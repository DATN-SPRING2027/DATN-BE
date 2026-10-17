import 'dotenv/config';
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import {
  resolveIamDatabaseName,
  targetFingerprint,
} from './organization-membership-backfill.plan.mjs';
import { planPlatformAuthorityChangeOperations } from './platform-authority-change-operations.plan.mjs';

const apply = process.argv.includes('--apply');
const expectedHash = process.argv
  .find((value) => value.startsWith('--expected-report-sha256='))
  ?.split('=')[1];
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
if (apply && !expectedHash)
  throw new Error('Apply requires a reviewed dry-run report SHA-256');

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
  const objects = await db
    .listCollections({ name: 'platform_authority_change_operations' })
    .toArray();
  const objectType = objects.length === 0 ? null : objects[0].type;
  const collectionExists = objectType !== null;
  const collection = db.collection('platform_authority_change_operations');
  const documentCount =
    objectType === 'collection' ? await collection.countDocuments() : 0;
  const duplicateOperations =
    objectType === 'collection'
      ? await collection
          .aggregate([
            {
              $group: {
                _id: '$operationId',
                count: { $sum: 1 },
              },
            },
            { $match: { count: { $gt: 1 } } },
            {
              $project: {
                _id: 0,
                operationId: '$_id',
                count: 1,
              },
            },
            { $limit: 100 },
          ])
          .toArray()
      : [];
  const invalidRecords =
    objectType === 'collection'
      ? await collection
          .find(
            {
              $or: [
                { operationId: { $not: { $type: 'string' } } },
                { payloadHash: { $not: { $type: 'string' } } },
                { actorUserId: { $not: { $type: 'objectId' } } },
                { issuerUserId: { $not: { $type: 'objectId' } } },
                { targetUserId: { $not: { $type: 'objectId' } } },
                { operationType: { $nin: ['GRANT', 'REVOKE'] } },
                {
                  permission: {
                    $nin: [
                      'organization.create',
                      'platform.health.read',
                      'platform.audit.read',
                    ],
                  },
                },
                { scope: { $ne: 'PLATFORM' } },
                { status: { $ne: 'COMMITTED' } },
                { httpStatus: { $nin: [200, 201] } },
                { committedAt: { $not: { $type: 'date' } } },
                { expiresAt: { $not: { $type: 'date' } } },
              ],
            },
            { projection: { _id: 1, operationId: 1, status: 1 } },
          )
          .limit(100)
          .toArray()
          .then((rows) =>
            rows.map((row) => ({
              id: String(row._id),
              operationId: row.operationId ?? null,
              status: row.status ?? null,
            })),
          )
      : [];
  const indexes =
    objectType === 'collection'
      ? await collection.indexes().catch((error) => {
          if (error?.codeName === 'NamespaceNotFound') return [];
          throw error;
        })
      : [];
  return planPlatformAuthorityChangeOperations({
    databaseName: db.databaseName,
    targetFingerprint: fingerprint,
    collectionExists,
    objectType,
    documentCount,
    duplicateOperations,
    invalidRecords,
    indexes,
  });
}

try {
  await connection.asPromise();
  const db = connection.db;
  if (!db || db.databaseName !== databaseName)
    throw new Error(
      'Connected IAM database does not match the configured target',
    );
  const plan = await inspect(db);
  const reportSha256 = createHash('sha256')
    .update(JSON.stringify(plan))
    .digest('hex');
  process.stdout.write(
    `${JSON.stringify({ ...plan, reportSha256 }, null, 2)}\n`,
  );
  if (!plan.clean) process.exitCode = 2;
  if (apply) {
    if (!plan.clean || expectedHash !== reportSha256)
      throw new Error('Apply refused: report does not match reviewed dry-run');
    if (!plan.collectionExists)
      await db.createCollection('platform_authority_change_operations');
    const collection = db.collection('platform_authority_change_operations');
    for (const index of plan.desiredIndexes) {
      if (index.action === 'CREATE')
        await collection.createIndex(index.key, {
          unique: index.unique,
          name: index.name,
        });
    }
    const after = await inspect(db);
    if (
      !after.clean ||
      after.documentCount < plan.documentCount ||
      after.desiredIndexes.some((index) => index.action !== 'NOOP')
    )
      throw new Error(
        'Platform authority change operations collection/index verification failed',
      );
    process.stdout.write(
      `Verified platform_authority_change_operations; documents before=${plan.documentCount}, after=${after.documentCount}.\n`,
    );
  }
} finally {
  await connection.close();
}
