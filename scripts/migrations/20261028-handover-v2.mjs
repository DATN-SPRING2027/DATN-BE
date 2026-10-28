import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import {
  DATABASE,
  contract,
  planHandoverV2,
  validateTarget,
} from './handover-v2.plan.mjs';

const referenceTargets = (name) => [
  ...(name !== 'handovers'
    ? [
        {
          field: 'handoverId',
          collection: 'handovers',
          matches: ['organizationId', 'projectId'],
        },
      ]
    : []),
  ...(name === 'handovers'
    ? [
        {
          field: 'publishedRevisionId',
          collection: 'handover_revisions',
          matches: ['organizationId', 'projectId'],
          parent: true,
        },
      ]
    : []),
  ...([
    'handover_acceptances',
    'handover_evidence',
    'handover_evidence_reviews',
    'handover_operations',
    'follow_up_tasks',
  ].includes(name)
    ? [
        {
          field: 'revisionId',
          collection: 'handover_revisions',
          matches: ['organizationId', 'projectId', 'handoverId'],
        },
      ]
    : []),
  ...(name === 'handover_evidence_reviews'
    ? [
        {
          field: 'evidenceId',
          collection: 'handover_evidence',
          matches: [
            'organizationId',
            'projectId',
            'handoverId',
            'revisionId',
            'itemId',
            'contentVersion',
            'assignmentVersion',
            'successorUserId',
            'dependencyFingerprint',
          ],
        },
      ]
    : []),
];

async function orphanCount(db, name) {
  let count = 0;
  for (const { field, collection, matches, parent } of referenceTargets(name)) {
    const rows = await db
      .collection(name)
      .aggregate([
        { $match: { schemaVersion: 2, [field]: { $type: 'objectId' } } },
        {
          $lookup: {
            from: collection,
            let: {
              targetId: `$${field}`,
              ...(parent ? { handoverId: '$_id' } : {}),
              ...Object.fromEntries(matches.map((key) => [key, `$${key}`])),
            },
            pipeline: [
              {
                $match: {
                  schemaVersion: 2,
                  $expr: {
                    $and: [
                      { $eq: ['$_id', '$$targetId'] },
                      ...(parent
                        ? [{ $eq: ['$handoverId', '$$handoverId'] }]
                        : []),
                      ...matches.map((key) => ({
                        $eq: [`$${key}`, `$$${key}`],
                      })),
                    ],
                  },
                },
              },
              { $limit: 1 },
            ],
            as: '__target',
          },
        },
        { $match: { '__target.0': { $exists: false } } },
        { $count: 'count' },
      ])
      .toArray();
    count += rows[0]?.count ?? 0;
  }
  return count;
}

/** Read-only preflight. Never includes documents, user IDs, credentials or content. */
export async function inspectHandoverV2(
  db,
  targetFingerprint = 'isolated-test',
) {
  if (db.databaseName !== DATABASE) throw new Error(`Expected ${DATABASE}`);
  const inventory = {};
  for (const [name, definition] of Object.entries(contract.collections)) {
    const info = await db.listCollections({ name }).next();
    if (!info) {
      inventory[name] = { exists: false };
      continue;
    }
    const collection = db.collection(name);
    const indexes = await collection.listIndexes().toArray();
    const duplicateIndexes = [];
    for (const index of definition.indexes.filter((entry) => entry.unique)) {
      const duplicates = await collection
        .aggregate([
          { $match: index.partialFilterExpression ?? {} },
          {
            $group: {
              _id: Object.fromEntries(
                Object.keys(index.key).map((key) => [key, `$${key}`]),
              ),
              count: { $sum: 1 },
            },
          },
          { $match: { count: { $gt: 1 } } },
          { $limit: 1 },
        ])
        .toArray();
      if (duplicates.length) duplicateIndexes.push(index.name);
    }
    inventory[name] = {
      exists: true,
      legacyCount: await collection.countDocuments({
        $or: [{ schemaVersion: { $exists: false } }, { schemaVersion: 1 }],
      }),
      v2Count: await collection.countDocuments({ schemaVersion: 2 }),
      invalidCount: await collection.countDocuments({
        $nor: [contract.validatorFor(name)],
      }),
      orphanCount: await orphanCount(db, name),
      indexes,
      duplicateIndexes,
      validator: info.options?.validator ?? {},
      validationLevel: info.options?.validationLevel,
      validationAction: info.options?.validationAction,
    };
  }
  return planHandoverV2({
    databaseName: db.databaseName,
    inventory,
    targetFingerprint,
  });
}

/** Writes only after the full preflight and exact report comparison succeed. */
export async function migrateHandoverV2(
  db,
  {
    apply = false,
    writesPaused = false,
    expectedReportSha256,
    targetFingerprint,
  } = {},
) {
  const plan = await inspectHandoverV2(db, targetFingerprint);
  if (!apply) return { ...plan, applied: false };
  if (!writesPaused) throw new Error('Apply requires --writes-paused');
  if (!expectedReportSha256 || expectedReportSha256 !== plan.reportSha256)
    throw new Error('Reviewed report changed; run dry-run and review again');
  if (plan.blockers.length)
    throw new Error('Migration blocked by preflight; no writes performed');
  for (const entry of plan.collections) {
    if (entry.action === 'CREATE')
      await db.createCollection(entry.name, {
        validator: entry.validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    else if (entry.action === 'VALIDATE')
      await db.command({
        collMod: entry.name,
        validator: entry.validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
  }
  for (const { collection, action, key, ...options } of plan.indexes) {
    if (action === 'CREATE')
      await db.collection(collection).createIndex(key, options);
  }
  const after = await inspectHandoverV2(db, targetFingerprint);
  if (
    after.blockers.length ||
    after.collections.some((entry) => entry.action !== 'KEEP') ||
    after.indexes.some((entry) => entry.action !== 'KEEP')
  )
    throw new Error(
      'Post-apply verification failed; preserve data and inspect the new dry-run',
    );
  return { ...after, applied: true };
}

export function parseArguments(args) {
  if (
    new Set(args).size !== args.length ||
    args.some(
      (arg) =>
        !['--apply', '--writes-paused', '--allow-shared-database'].includes(
          arg,
        ) && !/^--expected-report-sha256=[a-f0-9]{64}$/.test(arg),
    )
  )
    throw new Error('Unknown or duplicate migration argument');
  if (
    args.filter((arg) => arg.startsWith('--expected-report-sha256=')).length > 1
  )
    throw new Error('Only one report hash is allowed');
  const apply = args.includes('--apply');
  const writesPaused = args.includes('--writes-paused');
  const expectedReportSha256 = args
    .find((arg) => arg.startsWith('--expected-report-sha256='))
    ?.split('=')[1];
  if (apply && (!writesPaused || !expectedReportSha256))
    throw new Error(
      'Apply requires --writes-paused and --expected-report-sha256',
    );
  return {
    apply,
    writesPaused,
    expectedReportSha256,
    allowShared: args.includes('--allow-shared-database'),
  };
}

async function run() {
  const options = parseArguments(process.argv.slice(2));
  const uri = process.env.HANDOVER_MONGODB_URI;
  if (!uri)
    throw new Error('HANDOVER_MONGODB_URI is required; .env is never loaded');
  const target = validateTarget(uri, options.allowShared);
  if (
    !target.loopback &&
    process.env.HANDOVER_MIGRATION_CONFIRM_DATABASE !== DATABASE
  )
    throw new Error(
      'Shared target requires HANDOVER_MIGRATION_CONFIRM_DATABASE=continuum_handover',
    );
  const client = new mongoose.mongo.MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    appName: 'handover-v2-migration',
  });
  try {
    await client.connect();
    const report = await migrateHandoverV2(client.db(DATABASE), {
      ...options,
      targetFingerprint: target.targetFingerprint,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.blockers.length) process.exitCode = 2;
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run().catch(() => {
    // Driver errors can contain URI credentials or rejected protected documents.
    process.stderr.write(
      'Handover migration failed. Check target/arguments and rerun the read-only preflight; no raw driver error is logged.\n',
    );
    process.exitCode = 1;
  });
}
