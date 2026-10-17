import mongoose from 'mongoose';
import {
  resolveIamDatabaseName,
  targetFingerprint,
} from './organization-membership-backfill.plan.mjs';
import {
  PLATFORM_INCIDENT_COLLECTIONS,
  planPlatformIncidentStorage,
} from './platform-incidents.plan.mjs';

const apply = process.argv.includes('--apply');
const rollback = process.argv.includes('--rollback');
const expectedHash = process.argv
  .find((value) => value.startsWith('--expected-report-sha256='))
  ?.split('=')[1];
if (apply && rollback) throw new Error('Choose either --apply or --rollback');
if ((apply || rollback) && !expectedHash)
  throw new Error(
    'Apply and rollback require a reviewed dry-run report SHA-256',
  );
if (!process.env.MONGODB_URI)
  throw new Error('MONGODB_URI must be provided by the invoking process');

const databaseName = resolveIamDatabaseName({
  mongodbEnabled: process.env.MONGODB_ENABLED,
  infraEnabled: process.env.INFRA_ENABLED,
  configuredName: process.env.MONGODB_DATABASE,
});
const fingerprint = targetFingerprint(process.env.MONGODB_URI, databaseName);
const connection = mongoose.createConnection(process.env.MONGODB_URI, {
  dbName: databaseName,
  autoIndex: false,
  serverSelectionTimeoutMS: 5000,
});

async function inspect(db) {
  const collections = {};
  for (const name of PLATFORM_INCIDENT_COLLECTIONS) {
    const listed = await db.listCollections({ name }).toArray();
    const objectType = listed.length ? listed[0].type : null;
    const collection = db.collection(name);
    const documentCount =
      objectType === 'collection' ? await collection.countDocuments() : 0;
    const indexes =
      objectType === 'collection'
        ? await collection.indexes().catch((error) => {
            if (error?.codeName === 'NamespaceNotFound') return [];
            throw error;
          })
        : [];
    let duplicateKeys = 0;
    if (
      name === 'platform_incident_operations' &&
      objectType === 'collection'
    ) {
      duplicateKeys = await collection
        .aggregate([
          {
            $group: {
              _id: {
                actorUserId: '$actorUserId',
                idempotencyKeyHash: '$idempotencyKeyHash',
              },
              count: { $sum: 1 },
            },
          },
          { $match: { count: { $gt: 1 } } },
          { $count: 'duplicates' },
        ])
        .toArray()
        .then((rows) => rows[0]?.duplicates ?? 0);
    }
    collections[name] = {
      objectType,
      documentCount,
      indexes: indexes.map((index) => ({
        name: index.name,
        key: index.key,
        unique: index.unique ?? false,
        sparse: index.sparse ?? false,
        expireAfterSeconds: index.expireAfterSeconds,
        partialFilterExpression: index.partialFilterExpression,
        collation: index.collation,
      })),
      duplicateKeys,
    };
  }
  return planPlatformIncidentStorage(
    {
      databaseName: db.databaseName,
      targetFingerprint: fingerprint,
      collections,
    },
    { rollback },
  );
}

try {
  await connection.asPromise();
  const db = connection.db;
  if (!db || db.databaseName !== databaseName)
    throw new Error(
      'Connected IAM database does not match the configured target',
    );

  const plan = await inspect(db);
  const reportSha256 = plan.reportSha256;
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);

  if (apply || rollback) {
    if (!plan.clean || expectedHash !== reportSha256)
      throw new Error('Migration refused: report is not clean or hash differs');

    if (apply) {
      for (const name of plan.createCollections)
        await db.createCollection(name);
      for (const index of plan.desiredIndexes) {
        if (index.action !== 'CREATE') continue;
        await db.collection(index.collection).createIndex(index.key, {
          name: index.name,
          ...(index.unique ? { unique: true } : {}),
        });
      }
    } else {
      for (const index of plan.desiredIndexes) {
        if (index.action !== 'DROP') continue;
        await db.collection(index.collection).dropIndex(index.name);
      }
    }

    const verification = await inspect(db);
    if (!verification.clean)
      throw new Error('Incident storage migration verification failed');
    if (
      apply &&
      verification.desiredIndexes.some((index) => index.action !== 'KEEP')
    )
      throw new Error('Incident storage index verification failed');
    if (
      rollback &&
      verification.desiredIndexes.some((index) => index.action !== 'SKIP')
    )
      throw new Error('Incident storage rollback verification failed');
    process.stdout.write(
      `Verified incident storage ${apply ? 'indexes and collections' : 'index rollback'}; existing documents were preserved.\n`,
    );
  }
} finally {
  await connection.close();
}
