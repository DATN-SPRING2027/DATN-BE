import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { targetFingerprint } from './organization-membership-backfill.plan.mjs';

export const NOTIFICATION_DATABASE_NAME = 'continuum_notification';
export const NOTIFICATION_COLLECTION_NAME = 'notifications';
export const NOTIFICATION_TTL_SECONDS = 90 * 24 * 60 * 60;
export const NOTIFICATION_REQUEST_FLOW_INDEXES = [
  {
    key: { recipientUserId: 1, isRead: 1, createdAt: 1 },
    name: 'recipientUserId_1_isRead_1_createdAt_1',
  },
  {
    key: { createdAt: 1 },
    name: 'createdAt_1',
    expireAfterSeconds: NOTIFICATION_TTL_SECONDS,
  },
  {
    key: { recipientId: 1, createdAt: -1 },
    name: 'recipientId_1_createdAt_-1',
  },
  {
    key: { recipientId: 1, readAt: 1 },
    name: 'recipientId_1_readAt_1',
  },
  {
    key: { recipientId: 1, eventKey: 1 },
    name: 'recipientId_1_eventKey_1',
    unique: true,
    sparse: true,
  },
];

function sameKey(left = {}, right = {}) {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value], index) =>
        rightEntries[index]?.[0] === key &&
        rightEntries[index]?.[1] === value,
    )
  );
}

function hasExactOptions(actual, expected) {
  return (
    Boolean(actual.unique) === Boolean(expected.unique) &&
    Boolean(actual.sparse) === Boolean(expected.sparse) &&
    actual.expireAfterSeconds === expected.expireAfterSeconds &&
    actual.partialFilterExpression === undefined &&
    actual.collation === undefined
  );
}

function sameIndex(actual, expected) {
  return (
    actual.name === expected.name &&
    sameKey(actual.key, expected.key) &&
    hasExactOptions(actual, expected)
  );
}

export function planNotificationRequestFlowIndexes({
  databaseName,
  target,
  objectType,
  documentCount,
  expiredDocumentCount,
  duplicateEventKeyGroups,
  indexes,
}) {
  const observed = NOTIFICATION_REQUEST_FLOW_INDEXES.map((desired) => {
    const relevant = indexes.filter(
      (index) => index.name === desired.name || sameKey(index.key, desired.key),
    );
    const conflicts = relevant.filter((index) => !sameIndex(index, desired));
    return {
      name: desired.name,
      key: desired.key,
      unique: Boolean(desired.unique),
      sparse: Boolean(desired.sparse),
      expireAfterSeconds: desired.expireAfterSeconds ?? null,
      action: conflicts.length > 0
        ? 'BLOCK'
        : relevant.some((index) => sameIndex(index, desired))
          ? 'NOOP'
          : 'CREATE',
      conflicts: conflicts.map((index) => ({
        name: index.name ?? null,
        key: index.key ?? null,
      })),
    };
  });
  const scopeMatches =
    databaseName === NOTIFICATION_DATABASE_NAME &&
    objectType === 'collection';
  const safetyChecksPass =
    expiredDocumentCount === 0 && duplicateEventKeyGroups === 0;
  const noIndexConflicts = observed.every(
    (index) => index.action !== 'BLOCK',
  );
  const clean = scopeMatches && safetyChecksPass && noIndexConflicts;

  return {
    migration: '20261024-notification-request-flow-indexes',
    target,
    databaseName,
    collection: NOTIFICATION_COLLECTION_NAME,
    objectType,
    documentCount,
    expiredDocumentCount,
    duplicateEventKeyGroups,
    clean,
    desiredIndexes: observed.map((index) => ({
      name: index.name,
      key: index.key,
      unique: index.unique,
      sparse: index.sparse,
      expireAfterSeconds: index.expireAfterSeconds,
      action: clean ? index.action : 'BLOCK',
      conflicts: index.conflicts,
    })),
  };
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) ===
    path.resolve(process.argv[1]);

async function runMigration() {
  const apply = process.argv.includes('--apply');
  const notificationWritesPaused = process.argv.includes(
    '--notification-writes-paused',
  );
  const expectedHash = process.argv
    .find((argument) => argument.startsWith('--expected-report-sha256='))
    ?.split('=')[1];

  if (apply && !notificationWritesPaused) {
    throw new Error(
      'Apply requires the --notification-writes-paused assertion',
    );
  }
  if (apply && !expectedHash) {
    throw new Error('Apply requires a reviewed dry-run report SHA-256');
  }

  const notificationMongoUri = process.env.NOTIFICATION_MONGODB_URI;
  if (!notificationMongoUri) {
    throw new Error(
      'NOTIFICATION_MONGODB_URI must be explicitly provided by the caller',
    );
  }

  const fingerprint = targetFingerprint(
    notificationMongoUri,
    NOTIFICATION_DATABASE_NAME,
  );
  const connection = mongoose.createConnection(notificationMongoUri, {
    dbName: NOTIFICATION_DATABASE_NAME,
    autoIndex: false,
    serverSelectionTimeoutMS: 5000,
  });

  async function inspect(db) {
    const listed = await db
      .listCollections({ name: NOTIFICATION_COLLECTION_NAME })
      .toArray();
    const objectType = listed[0]?.type ?? null;
    const collection = db.collection(NOTIFICATION_COLLECTION_NAME);
    const indexes =
      objectType === 'collection' ? await collection.indexes() : [];
    const documentCount =
      objectType === 'collection'
        ? await collection.countDocuments({})
        : 0;
    const expiredDocumentCount =
      objectType === 'collection'
        ? await collection.countDocuments({
            createdAt: {
              $lte: new Date(Date.now() - NOTIFICATION_TTL_SECONDS * 1000),
            },
          })
        : 0;
    const duplicateEventKeyGroups =
      objectType === 'collection'
        ? ((await collection
            .aggregate([
              {
                $match: {
                  recipientId: { $exists: true },
                  eventKey: { $exists: true },
                },
              },
              {
                $group: {
                  _id: { recipientId: '$recipientId', eventKey: '$eventKey' },
                  count: { $sum: 1 },
                },
              },
              { $match: { count: { $gt: 1 } } },
              { $count: 'groups' },
            ])
            .toArray())[0]?.groups ?? 0)
        : 0;
    const plan = planNotificationRequestFlowIndexes({
      databaseName: db.databaseName,
      target: fingerprint,
      objectType,
      documentCount,
      expiredDocumentCount,
      duplicateEventKeyGroups,
      indexes,
    });
    const reportSha256 = createHash('sha256')
      .update(JSON.stringify(plan))
      .digest('hex');
    return { ...plan, reportSha256 };
  }

  try {
    await connection.asPromise();
    const db = connection.db;
    if (!db || db.databaseName !== NOTIFICATION_DATABASE_NAME) {
      throw new Error(
        'Connected database does not match continuum_notification',
      );
    }

    const plan = await inspect(db);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    if (!plan.clean) {
      process.exitCode = 2;
    } else if (apply) {
      if (expectedHash !== plan.reportSha256) {
        throw new Error(
          'Apply refused: report hash differs from reviewed dry-run',
        );
      }

      for (const desired of plan.desiredIndexes) {
        if (desired.action === 'NOOP') continue;
        const definition = NOTIFICATION_REQUEST_FLOW_INDEXES.find(
          (index) => index.name === desired.name,
        );
        const options = {
          name: definition.name,
          ...(definition.unique ? { unique: true } : {}),
          ...(definition.sparse ? { sparse: true } : {}),
          ...(definition.expireAfterSeconds !== undefined
            ? { expireAfterSeconds: definition.expireAfterSeconds }
            : {}),
        };
        await db
          .collection(NOTIFICATION_COLLECTION_NAME)
          .createIndex(definition.key, options);
      }

      const verification = await inspect(db);
      if (
        !verification.clean ||
        verification.desiredIndexes.some((index) => index.action !== 'NOOP')
      ) {
        throw new Error(
          'Notification request-flow index migration verification failed',
        );
      }
      process.stdout.write(
        'Verified notification indexes; notification documents were not modified.\n',
      );
    }
  } finally {
    await connection.close();
  }
}

if (isDirectExecution) {
  runMigration().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Migration failed'}\n`,
    );
    process.exitCode = 1;
  });
}
