import 'dotenv/config';
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import {
  resolveIamDatabaseName,
  targetFingerprint,
} from './organization-membership-backfill.plan.mjs';
import {
  PLATFORM_AUTHORITY_CHANGE_LOCKS,
  planPlatformAuthorityChangeHardening,
} from './platform-authority-change-hardening.plan.mjs';

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

async function inspectCollection(db, name) {
  const objects = await db.listCollections({ name }).toArray();
  const objectType = objects.length === 0 ? null : objects[0].type;
  const collectionExists = objectType !== null;
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
  return { collectionExists, objectType, documentCount, indexes, collection };
}

async function inspect(db) {
  const operations = await inspectCollection(
    db,
    'platform_authority_change_operations',
  );
  const lockState = await inspectCollection(
    db,
    'platform_authority_change_locks',
  );
  let validLockKeys = [];
  let duplicateLockPairs = [];
  let invalidLockRows = [];

  if (lockState.objectType === 'collection') {
    const rows = await lockState.collection
      .find({}, { projection: { _id: 1, permission: 1, scope: 1, version: 1 } })
      .limit(101)
      .toArray();
    const expected = new Set(
      PLATFORM_AUTHORITY_CHANGE_LOCKS.map(
        ({ permission, scope }) => `${permission}|${scope}`,
      ),
    );
    validLockKeys = rows
      .filter(
        (row) =>
          expected.has(`${row.permission}|${row.scope}`) &&
          Number.isInteger(row.version) &&
          row.version >= 0,
      )
      .map((row) => `${row.scope}:${row.permission}`);
    invalidLockRows = rows
      .filter(
        (row) =>
          !expected.has(`${row.permission}|${row.scope}`) ||
          !Number.isInteger(row.version) ||
          row.version < 0,
      )
      .map((row) => ({
        id: String(row._id),
        reason: 'unexpected-lock-record',
      }));
    duplicateLockPairs = await lockState.collection
      .aggregate([
        {
          $group: {
            _id: { permission: '$permission', scope: '$scope' },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
        {
          $project: {
            _id: 0,
            permission: '$_id.permission',
            scope: '$_id.scope',
            count: 1,
          },
        },
        { $limit: 100 },
      ])
      .toArray();
    if (lockState.documentCount > 100) {
      invalidLockRows.push({
        id: null,
        reason: 'too-many-lock-records-to-review',
      });
    }
  }

  return planPlatformAuthorityChangeHardening({
    databaseName: db.databaseName,
    targetFingerprint: fingerprint,
    operations,
    locks: {
      collectionExists: lockState.collectionExists,
      objectType: lockState.objectType,
      documentCount: lockState.documentCount,
      indexes: lockState.indexes,
      validLockKeys,
      duplicateLockPairs,
      invalidLockRows,
    },
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

    const operations = db.collection('platform_authority_change_operations');
    for (const index of plan.operations.desiredIndexes) {
      if (index.action === 'CREATE') {
        await operations.createIndex(index.key, {
          name: index.name,
          ...(index.expireAfterSeconds === undefined
            ? {}
            : { expireAfterSeconds: index.expireAfterSeconds }),
        });
      }
    }

    if (!plan.locks.collectionExists)
      await db.createCollection('platform_authority_change_locks');
    const locks = db.collection('platform_authority_change_locks');
    for (const index of plan.locks.desiredIndexes) {
      if (index.action === 'CREATE') {
        await locks.createIndex(index.key, {
          name: index.name,
          unique: index.unique,
        });
      }
    }
    for (const { permission, scope } of PLATFORM_AUTHORITY_CHANGE_LOCKS) {
      await locks.updateOne(
        { permission, scope },
        { $setOnInsert: { permission, scope, version: 0 } },
        { upsert: true },
      );
    }

    const after = await inspect(db);
    if (
      !after.clean ||
      after.operations.documentCount < plan.operations.documentCount ||
      after.operations.desiredIndexes.some(
        (index) => index.action !== 'NOOP',
      ) ||
      after.locks.desiredIndexes.some((index) => index.action !== 'NOOP') ||
      after.locks.missingLockKeys.length > 0
    ) {
      throw new Error('Platform authority hardening verification failed');
    }
    process.stdout.write(
      `Verified platform authority TTL and permission locks; operation records before=${plan.operations.documentCount}, after=${after.operations.documentCount}.\n`,
    );
  }
} finally {
  await connection.close();
}
