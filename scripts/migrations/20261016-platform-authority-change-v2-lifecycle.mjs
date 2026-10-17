import 'dotenv/config';
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import {
  resolveIamDatabaseName,
  targetFingerprint,
} from './organization-membership-backfill.plan.mjs';

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

const operationIndexes = [
  {
    key: { operationId: 1 },
    name: 'platform_authority_operation_id',
    unique: true,
  },
  {
    key: { targetUserId: 1, committedAt: -1 },
    name: 'platform_authority_operation_target_v2',
    unique: false,
  },
  {
    key: { actorUserId: 1, committedAt: -1 },
    name: 'platform_authority_operation_actor',
    unique: false,
  },
];
const lockIndex = {
  key: { permission: 1, scope: 1 },
  name: 'platform_authority_change_lock_key',
  unique: true,
};
const lifecycleLock = {
  permission: 'PLATFORM_OPERATOR_LIFECYCLE',
  scope: 'PLATFORM',
};
const sameKey = (left, right) =>
  JSON.stringify(Object.entries(left ?? {})) ===
  JSON.stringify(Object.entries(right));

async function inspectCollection(db, name) {
  const objects = await db.listCollections({ name }).toArray();
  const objectType = objects.length === 0 ? null : objects[0].type;
  const exists = objectType !== null;
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
  return { exists, objectType, documentCount, indexes, collection };
}

function planIndexes(existingIndexes, wantedIndexes) {
  return wantedIndexes.map((wanted) => {
    const existing = existingIndexes.find((index) =>
      sameKey(index.key, wanted.key),
    );
    const valid = existing
      ? existing.name === wanted.name &&
        (existing.unique === true) === wanted.unique &&
        existing.sparse !== true &&
        existing.partialFilterExpression === undefined &&
        existing.expireAfterSeconds === undefined &&
        (existing.collation === undefined ||
          (existing.collation.locale === 'simple' &&
            Object.keys(existing.collation).length === 1))
      : true;
    return {
      key: wanted.key,
      name: wanted.name,
      unique: wanted.unique,
      action: !existing ? 'CREATE' : valid ? 'NOOP' : 'CONFLICT',
    };
  });
}

async function inspect(db) {
  const operations = await inspectCollection(
    db,
    'platform_authority_change_operations',
  );
  const locks = await inspectCollection(
    db,
    'platform_authority_change_locks',
  );
  const operationIndexPlan = planIndexes(
    operations.indexes,
    operationIndexes,
  );
  const lockIndexPlan = planIndexes(locks.indexes, [lockIndex]);
  const ttlIndexes = operations.indexes.filter(
    (index) => index.expireAfterSeconds !== undefined,
  );
  const duplicateOperationIdCount =
    operations.objectType === 'collection'
      ? (
          await operations.collection
            .aggregate([
              {
                $group: {
                  _id: '$operationId',
                  count: { $sum: 1 },
                },
              },
              { $match: { count: { $gt: 1 } } },
              { $count: 'count' },
            ])
            .toArray()
        )[0]?.count ?? 0
      : 0;
  const exactTtlIndexes = ttlIndexes.filter(
    (index) =>
      index.name === 'platform_authority_operation_expiry' &&
      sameKey(index.key, { expiresAt: 1 }) &&
      index.expireAfterSeconds === 0,
  );
  const duplicateLockKeyCount =
    locks.objectType === 'collection'
      ? (
          await locks.collection
            .aggregate([
              {
                $group: {
                  _id: { permission: '$permission', scope: '$scope' },
                  count: { $sum: 1 },
                },
              },
              { $match: { count: { $gt: 1 } } },
              { $count: 'count' },
            ])
            .toArray()
        )[0]?.count ?? 0
      : 0;
  const invalidLockRowCount =
    locks.objectType === 'collection'
      ? await locks.collection.countDocuments({
          $or: [
            { permission: { $not: { $type: 'string' } } },
            { scope: { $ne: 'PLATFORM' } },
            { version: { $not: { $type: 'number' } } },
            { version: { $lt: 0 } },
          ],
        })
      : 0;
  const lifecycleLockCount =
    locks.objectType === 'collection'
      ? await locks.collection.countDocuments(lifecycleLock)
      : 0;
  const lifecycleLockRecord =
    locks.objectType === 'collection' && lifecycleLockCount === 1
      ? await locks.collection.findOne(lifecycleLock, {
          projection: { _id: 0, version: 1 },
        })
      : null;
  const malformedLifecycleLock =
    lifecycleLockCount === 1 &&
    (!Number.isInteger(lifecycleLockRecord?.version) ||
      lifecycleLockRecord.version < 0);
  const supportedObjects =
    [operations.objectType, locks.objectType].every(
      (type) => type === null || type === 'collection',
    );
  const clean =
    supportedObjects &&
    operationIndexPlan.every((index) => index.action !== 'CONFLICT') &&
    lockIndexPlan.every((index) => index.action !== 'CONFLICT') &&
    duplicateOperationIdCount === 0 &&
    ttlIndexes.length === exactTtlIndexes.length &&
    exactTtlIndexes.length <= 1 &&
    duplicateLockKeyCount === 0 &&
    invalidLockRowCount === 0 &&
    lifecycleLockCount <= 1 &&
    !malformedLifecycleLock;
  const needsChanges =
    !operations.exists ||
    !locks.exists ||
    operationIndexPlan.some((index) => index.action === 'CREATE') ||
    lockIndexPlan.some((index) => index.action === 'CREATE') ||
    exactTtlIndexes.length > 0 ||
    lifecycleLockCount === 0;

  return {
    migration: 'platform-authority-change-v2-lifecycle',
    databaseName: db.databaseName,
    targetFingerprint: fingerprint,
    operations: {
      collectionExists: operations.exists,
      objectType: operations.objectType,
      documentCount: operations.documentCount,
      duplicateOperationIdCount,
      desiredIndexes: operationIndexPlan,
      unapprovedTtlIndexCount: exactTtlIndexes.length,
    },
    locks: {
      collectionExists: locks.exists,
      objectType: locks.objectType,
      documentCount: locks.documentCount,
      desiredIndexes: lockIndexPlan,
      lifecycleLockCount,
      duplicateLockKeyCount,
      invalidLockRowCount,
    },
    clean,
    action: !clean
      ? 'BLOCKED'
      : needsChanges
        ? 'APPLY_V2_LIFECYCLE'
        : 'NOOP',
  };
}

try {
  await connection.asPromise();
  const db = connection.db;
  if (!db || db.databaseName !== databaseName)
    throw new Error('Connected IAM database does not match the configured target');

  const report = await inspect(db);
  const reportSha256 = createHash('sha256')
    .update(JSON.stringify(report))
    .digest('hex');
  process.stdout.write(
    `${JSON.stringify({ ...report, reportSha256 }, null, 2)}\n`,
  );
  if (!report.clean) process.exitCode = 2;

  if (apply) {
    if (!report.clean || expectedHash !== reportSha256)
      throw new Error('Apply refused: report does not match reviewed dry-run');

    const operations = db.collection('platform_authority_change_operations');
    const locks = db.collection('platform_authority_change_locks');
    if (!report.operations.collectionExists)
      await db.createCollection('platform_authority_change_operations');
    if (!report.locks.collectionExists)
      await db.createCollection('platform_authority_change_locks');

    if (report.operations.unapprovedTtlIndexCount === 1)
      await operations.dropIndex('platform_authority_operation_expiry');
    for (const index of report.operations.desiredIndexes) {
      if (index.action === 'CREATE')
        await operations.createIndex(index.key, {
          name: index.name,
          unique: index.unique,
        });
    }
    for (const index of report.locks.desiredIndexes) {
      if (index.action === 'CREATE')
        await locks.createIndex(index.key, {
          name: index.name,
          unique: index.unique,
        });
    }
    await locks.updateOne(
      lifecycleLock,
      { $setOnInsert: { ...lifecycleLock, version: 0 } },
      { upsert: true },
    );

    const after = await inspect(db);
    if (
      !after.clean ||
      after.operations.documentCount !== report.operations.documentCount ||
      after.locks.documentCount !==
        report.locks.documentCount + (report.locks.lifecycleLockCount === 0 ? 1 : 0) ||
      after.operations.desiredIndexes.some((index) => index.action !== 'NOOP') ||
      after.operations.unapprovedTtlIndexCount !== 0 ||
      after.locks.desiredIndexes.some((index) => index.action !== 'NOOP') ||
      after.locks.lifecycleLockCount !== 1
    ) {
      throw new Error('Platform authority lifecycle verification failed');
    }
    process.stdout.write(
      `Verified lifecycle indexes and shared lock; operation records before=${report.operations.documentCount}, after=${after.operations.documentCount}.\n`,
    );
  }
} finally {
  await connection.close();
}
