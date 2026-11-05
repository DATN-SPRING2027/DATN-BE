import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';

export const DATABASE = 'continuum_capture';
export const COLLECTION = 'work_note_assessment_feedback';
export const TTL_SECONDS = 15_552_000; // 180 days (180 * 24 * 3600)
export const TTL_INDEX_NAME = 'assessment_feedback_retention_180d';
export const COMPOUND_INDEX_NAME =
  'assessment_feedback_version_purpose_category';

const TTL_KEY = { recordedAt: 1 };
const COMPOUND_KEY = {
  promptVersion: 1,
  purpose: 1,
  category: 1,
  recordedAt: -1,
};

const isSameKey = (actual, expected) => {
  const actualEntries = Object.entries(actual ?? {});
  const expectedEntries = Object.entries(expected);
  return (
    actualEntries.length === expectedEntries.length &&
    expectedEntries.every(
      ([key, value], idx) =>
        actualEntries[idx]?.[0] === key && actualEntries[idx]?.[1] === value,
    )
  );
};

const hasStandardIndexOptions = (
  index,
  { expectedExpireAfterSeconds } = {},
) => {
  if (index.partialFilterExpression !== undefined) return false;
  if (index.sparse === true) return false;
  if (index.unique === true) return false;
  if (index.hidden === true) return false;
  if (index.collation !== undefined) return false;
  if (index.wildcardProjection !== undefined) return false;
  if (expectedExpireAfterSeconds !== undefined) {
    return index.expireAfterSeconds === expectedExpireAfterSeconds;
  }
  return index.expireAfterSeconds === undefined;
};

const isValidTtlIndex = (i) =>
  i.name === TTL_INDEX_NAME &&
  isSameKey(i.key, TTL_KEY) &&
  hasStandardIndexOptions(i, { expectedExpireAfterSeconds: TTL_SECONDS });

const isValidCompoundIndex = (i) =>
  i.name === COMPOUND_INDEX_NAME &&
  isSameKey(i.key, COMPOUND_KEY) &&
  hasStandardIndexOptions(i);

const isIncompatibleIndex = (i) => {
  if (!i || i.name === '_id_') return false;
  const touchesTtl =
    i.name === TTL_INDEX_NAME ||
    isSameKey(i.key, TTL_KEY) ||
    i.expireAfterSeconds !== undefined;
  if (touchesTtl && !isValidTtlIndex(i)) return true;
  const touchesCompound =
    i.name === COMPOUND_INDEX_NAME || isSameKey(i.key, COMPOUND_KEY);
  if (touchesCompound && !isValidCompoundIndex(i)) return true;
  return false;
};

async function readIndexes(db, name) {
  try {
    return await db.collection(name).indexes();
  } catch (error) {
    if (error?.code === 26) return []; // NamespaceNotFound
    throw error;
  }
}

export async function feedbackReadiness(db) {
  if (db.databaseName !== DATABASE)
    throw Error('Only continuum_capture is allowed');

  const indexes = await readIndexes(db, COLLECTION);
  const incompatibleIndexes = indexes
    .filter(isIncompatibleIndex)
    .map((i) => i.name);
  const ttlReady =
    incompatibleIndexes.length === 0 && indexes.some(isValidTtlIndex);
  const compoundReady =
    incompatibleIndexes.length === 0 && indexes.some(isValidCompoundIndex);

  return {
    collection: COLLECTION,
    ttlReady,
    compoundReady,
    allReady: ttlReady && compoundReady && incompatibleIndexes.length === 0,
    incompatibleIndexes,
    indexesCount: indexes.length,
  };
}

/**
 * Idempotent, bounded index migration for work_note_assessment_feedback.
 * Creates the 180-day TTL index on recordedAt and the query compound index.
 */
export async function migrateWorkNoteFeedbackTtl(
  client,
  { apply = false, acknowledgeExistingExpiry = false } = {},
) {
  const db = client.db(DATABASE);
  const before = await feedbackReadiness(db);
  const collection = db.collection(COLLECTION);
  const cutoff = new Date(Date.now() - TTL_SECONDS * 1000);
  const metadata = {
    totalRecords: await collection.countDocuments({}),
    invalidRecordedAt: await collection.countDocuments({
      recordedAt: { $not: { $type: 'date' } },
    }),
    eligibleForExpiry: await collection.countDocuments({
      recordedAt: { $type: 'date', $lt: cutoff },
    }),
    expiryCutoff: cutoff.toISOString(),
  };
  if (apply && before.incompatibleIndexes.length > 0)
    throw Error(
      `FEEDBACK_TTL_INCOMPATIBLE_INDEX_EXISTS: ${before.incompatibleIndexes.join(', ')}`,
    );
  if (apply && metadata.invalidRecordedAt > 0)
    throw Error('FEEDBACK_TTL_INVALID_RECORDED_AT_REQUIRES_REMEDIATION');
  if (apply && metadata.eligibleForExpiry > 0 && !acknowledgeExistingExpiry)
    throw Error('FEEDBACK_TTL_EXISTING_EXPIRY_REQUIRES_ACKNOWLEDGEMENT');

  // Check if collection exists or create if needed
  const collections = await db
    .listCollections({ name: COLLECTION }, { nameOnly: true })
    .toArray();
  const collectionExists = collections.length > 0;

  let ttlCreated = false;
  let compoundCreated = false;

  if (apply) {
    if (!collectionExists) {
      await db.createCollection(COLLECTION);
    }

    if (!before.ttlReady) {
      await db.collection(COLLECTION).createIndex(
        { recordedAt: 1 },
        {
          name: TTL_INDEX_NAME,
          expireAfterSeconds: TTL_SECONDS,
        },
      );
      ttlCreated = true;
    }

    if (!before.compoundReady) {
      await db.collection(COLLECTION).createIndex(
        {
          promptVersion: 1,
          purpose: 1,
          category: 1,
          recordedAt: -1,
        },
        {
          name: COMPOUND_INDEX_NAME,
        },
      );
      compoundCreated = true;
    }
  }

  const after = apply ? await feedbackReadiness(db) : before;

  return {
    database: DATABASE,
    collection: COLLECTION,
    apply,
    before,
    after,
    ttlCreated,
    compoundCreated,
    metadata,
    acknowledgeExistingExpiry,
    ttlRetentionDays: 180,
    ttlSeconds: TTL_SECONDS,
  };
}

export async function runFeedbackTtlMigration(
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
    args.some(
      (a) => !['--inspect', '--apply', '--ack-existing-expiry'].includes(a),
    ) ||
    new Set(args).size !== args.length
  )
    throw Error('Unknown or duplicate argument');

  if (!args.length)
    return {
      dryRun: true,
      networkCalls: 0,
      database: DATABASE,
      collection: COLLECTION,
      retention:
        'TTL requires valid recordedAt and explicit target inspection; creating an index can expire old records',
    };

  const actions = args.filter((a) => a === '--inspect' || a === '--apply');
  if (
    actions.length !== 1 ||
    (args.includes('--ack-existing-expiry') && !args.includes('--apply')) ||
    env.NODE_ENV === 'production'
  )
    throw Error('Choose inspect or apply in a non-production local environment');

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
    return await migrateWorkNoteFeedbackTtl(client, {
      apply: args.includes('--apply'),
      acknowledgeExistingExpiry: args.includes('--ack-existing-expiry'),
    });
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runFeedbackTtlMigration(process.argv.slice(2))
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err) => {
      console.error(
        'Feedback TTL migration failed; no credentials, source text or record identifiers logged.',
        err?.message,
      );
      process.exitCode = 1;
    });
