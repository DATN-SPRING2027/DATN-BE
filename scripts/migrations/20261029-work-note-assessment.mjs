import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';

const DAY = 24 * 60 * 60 * 1000;
const DATABASE = 'continuum_capture';
const TTL = {
  work_note_agent_drafts: 'agent_drafts_expiry',
  work_note_agent_operations: 'agent_operations_expiry',
};
const validDate = (value) =>
  value instanceof Date && Number.isFinite(value.getTime());
const sameKey = (key) =>
  JSON.stringify(key) === JSON.stringify({ expiresAt: 1 });
const exactExpiry = (index, name) =>
  sameKey(index.key) &&
  index.name === name &&
  index.expireAfterSeconds === 0 &&
  !index.partialFilterExpression;

async function readIndexes(db, name) {
  try {
    return await db.collection(name).indexes();
  } catch (error) {
    if (error?.code === 26) return [];
    throw error;
  }
}

export async function assessmentReadiness(db) {
  if (db.databaseName !== DATABASE)
    throw Error('Only continuum_capture is allowed');
  const readiness = {};
  for (const [name, ttlName] of Object.entries(TTL)) {
    const indexes = await readIndexes(db, name);
    if (
      indexes.some(
        (i) =>
          (sameKey(i.key) || i.name === ttlName) && !exactExpiry(i, ttlName),
      )
    )
      throw Error('Conflicting expiry index; reviewed repair required');
    readiness[name] = indexes.some((i) => exactExpiry(i, ttlName));
  }
  return readiness;
}

/** Bounded expiry-only migration. No canonical content, new collection or implicit target. */
export async function migrateWorkNoteAssessment(
  client,
  { apply = false, maxRecords = 10000, now = new Date() } = {},
) {
  if (
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 1 ||
    maxRecords > 100000 ||
    !validDate(now)
  )
    throw Error('Invalid scan budget or clock');
  const db = client.db(DATABASE);
  const drafts = await db
    .collection('work_note_agent_drafts')
    .find()
    .limit(maxRecords + 1)
    .toArray();
  if (drafts.length > maxRecords)
    throw Error('Scan budget exceeded; no writes made');
  const operations = await db
    .collection('work_note_agent_operations')
    .find()
    .limit(maxRecords - drafts.length + 1)
    .toArray();
  if (drafts.length + operations.length > maxRecords)
    throw Error('Scan budget exceeded; no writes made');
  const changes = [];
  const deadlines = new Map();
  let legacyOrphanOperations = 0;
  for (const row of drafts) {
    if (!validDate(row.createdAt))
      throw Error(
        'Invalid draft creation timestamp; manual inventory required',
      );
    if (!validDate(row.expiresAt))
      throw Error('Invalid draft expiry timestamp; manual inventory required');
    const cap = Math.min(
      row.expiresAt.getTime(),
      row.createdAt.getTime() + DAY,
    );
    deadlines.set(String(row._id), cap);
    const patch = {};
    if (row.expiresAt.getTime() > cap) patch.expiresAt = new Date(cap);
    const assessment = row.state?.assessment;
    if (assessment != null) {
      if (
        typeof assessment !== 'object' ||
        assessment.schemaVersion !== 'task-note-assessment/v1' ||
        typeof assessment.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(assessment.createdAt)) ||
        typeof assessment.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(assessment.expiresAt))
      )
        throw Error(
          'Invalid private assessment timestamp; manual inventory required',
        );
      const assessmentCap = Math.min(
        cap,
        Date.parse(assessment.createdAt) + DAY,
        Date.parse(assessment.expiresAt),
      );
      if (Date.parse(assessment.expiresAt) > assessmentCap)
        patch['state.assessment.expiresAt'] = new Date(
          assessmentCap,
        ).toISOString();
    }
    if (Object.keys(patch).length)
      changes.push({ collection: 'work_note_agent_drafts', row, patch });
  }
  for (const row of operations) {
    if (!validDate(row.expiresAt))
      throw Error(
        'Invalid operation expiry timestamp; manual inventory required',
      );
    if (row.createdAt != null && !validDate(row.createdAt))
      throw Error(
        'Invalid operation creation timestamp; manual inventory required',
      );
    const draftCap = deadlines.get(String(row.draftId));
    const ownCap = validDate(row.createdAt)
      ? row.createdAt.getTime() + DAY
      : undefined;
    // Old raw inserts lacked timestamps: an associated draft is a valid upper bound.
    // An orphan with no trustworthy clock expires now; never invent creation time.
    if (ownCap === undefined && draftCap === undefined)
      legacyOrphanOperations++;
    const cap = Math.min(
      row.expiresAt.getTime(),
      ownCap ?? draftCap ?? now.getTime(),
      draftCap ?? Number.POSITIVE_INFINITY,
    );
    if (row.expiresAt.getTime() > cap)
      changes.push({
        collection: 'work_note_agent_operations',
        row,
        patch: { expiresAt: new Date(cap) },
      });
  }
  const before = await assessmentReadiness(db);
  const result = {
    inspected: drafts.length + operations.length,
    wouldClampDrafts: changes.filter(
      (c) => c.collection === 'work_note_agent_drafts',
    ).length,
    wouldClampOperations: changes.filter(
      (c) => c.collection === 'work_note_agent_operations',
    ).length,
    legacyOrphanOperations,
    ttlReady: before,
    applied: 0,
  };
  if (!apply) return result;
  for (const [name, ttlName] of Object.entries(TTL)) {
    if (!before[name])
      await db
        .collection(name)
        .createIndex(
          { expiresAt: 1 },
          { name: ttlName, expireAfterSeconds: 0 },
        );
  }
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      for (const change of changes) {
        const filter = { _id: change.row._id, expiresAt: change.row.expiresAt };
        if (Object.hasOwn(change.row, 'createdAt'))
          filter.createdAt = change.row.createdAt;
        else filter.createdAt = { $exists: false };
        if (change.patch['state.assessment.expiresAt'])
          filter['state.assessment.expiresAt'] =
            change.row.state.assessment.expiresAt;
        const updated = await db
          .collection(change.collection)
          .updateOne(filter, { $set: change.patch }, { session });
        if (updated.matchedCount !== 1)
          throw Error('Concurrent retention change; retry inventory');
      }
    });
  } finally {
    await session.endSession();
  }
  return {
    ...result,
    applied: changes.length,
    ttlReady: await assessmentReadiness(db),
  };
}

export async function runAssessmentMigration(
  args,
  env = process.env,
  connect = async (uri) => {
    const client = new mongoose.mongo.MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  },
) {
  if (
    args.some((a) => !['--inspect', '--apply'].includes(a)) ||
    new Set(args).size !== args.length
  )
    throw Error('Unknown or duplicate argument');
  if (!args.length)
    return {
      dryRun: true,
      networkCalls: 0,
      database: DATABASE,
      retention:
        'Private draft/assessment at most24h from draft creation; expiry-only, canonical unchanged',
    };
  if (args.length !== 1 || env.NODE_ENV === 'production')
    throw Error(
      'Choose inspect or apply in a non-production local environment',
    );
  const uri = env.WORKNOTE_MIGRATION_URI;
  if (!uri) throw Error('Explicit WORKNOTE_MIGRATION_URI required');
  const parsed = new URL(uri);
  const authority = uri.slice(uri.indexOf('://') + 3).split(/[/?#]/, 1)[0];
  if (
    parsed.protocol !== 'mongodb:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    authority.includes(',') ||
    (parsed.pathname && !['/', '/continuum_capture'].includes(parsed.pathname))
  )
    throw Error('One explicit loopback continuum_capture target required');
  const client = await connect(uri);
  try {
    return await migrateWorkNoteAssessment(client, {
      apply: args[0] === '--apply',
    });
  } finally {
    await client.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runAssessmentMigration(process.argv.slice(2))
    .then((r) => console.log(JSON.stringify(r)))
    .catch(() => {
      console.error(
        'Assessment retention migration failed; no credentials, source text or record identifiers logged.',
      );
      process.exitCode = 1;
    });
