import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import {
  PASSWORD_RESET_OUTBOX_COLLECTION,
  PASSWORD_RESET_OUTBOX_DATABASE,
  PASSWORD_RESET_OUTBOX_INDEXES,
  hashPasswordResetOutboxReport,
  isExactPasswordResetOutboxIndex,
  planPasswordResetOutboxIndexes,
} from './password-reset-outbox.plan.mjs';

function fingerprintTarget(uri) {
  const parsed = new URL(uri);
  return createHash('sha256')
    .update(
      `${parsed.protocol}//${parsed.host}/${PASSWORD_RESET_OUTBOX_DATABASE}`,
    )
    .digest('hex');
}

async function inspect(connection, uri) {
  const db = connection.db;
  if (!db) throw new Error('MongoDB connection did not expose a database');
  const objects = await db
    .listCollections(
      { name: PASSWORD_RESET_OUTBOX_COLLECTION },
      { nameOnly: false },
    )
    .toArray();
  const object = objects.find(
    (entry) => entry.name === PASSWORD_RESET_OUTBOX_COLLECTION,
  );
  const collectionExists = object?.type === 'collection';
  let documentCount = 0;
  let malformedDocumentCount = 0;
  let duplicateUserScopeGroups = 0;
  let duplicateTokenHashGroups = 0;
  let indexes = [];

  if (collectionExists) {
    const collection = db.collection(PASSWORD_RESET_OUTBOX_COLLECTION);
    const [count, malformed, duplicateScopes, duplicateTokens, currentIndexes] =
      await Promise.all([
        collection.countDocuments(),
        collection.countDocuments({
          $or: [
            { userScopeHash: { $not: /^([0-9a-f]{64})$/i } },
            { userId: { $not: /^([0-9a-f]{24})$/i } },
            { tokenHash: { $not: /^([0-9a-f]{64})$/i } },
            { expiresAt: { $not: { $type: 'date' } } },
            { nextAttemptAt: { $not: { $type: 'date' } } },
            { attemptCount: { $not: { $type: 'number' } } },
            {
              deliveryStatus: {
                $nin: ['PENDING', 'SENDING', 'SENT', 'FAILED', 'IGNORED'],
              },
            },
          ],
        }),
        collection
          .aggregate([
            { $group: { _id: '$userScopeHash', count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } },
            { $count: 'groups' },
          ])
          .toArray(),
        collection
          .aggregate([
            { $group: { _id: '$tokenHash', count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } },
            { $count: 'groups' },
          ])
          .toArray(),
        collection.listIndexes().toArray(),
      ]);
    documentCount = count;
    malformedDocumentCount = malformed;
    duplicateUserScopeGroups = duplicateScopes[0]?.groups ?? 0;
    duplicateTokenHashGroups = duplicateTokens[0]?.groups ?? 0;
    indexes = currentIndexes;
  }

  return planPasswordResetOutboxIndexes({
    targetFingerprint: fingerprintTarget(uri),
    collectionExists,
    objectType: object?.type ?? null,
    documentCount,
    malformedDocumentCount,
    duplicateUserScopeGroups,
    duplicateTokenHashGroups,
    indexes,
  });
}

function assertExactCurrentIndex(current, desired) {
  if (!isExactPasswordResetOutboxIndex(current, desired)) {
    throw new Error(`Refusing to remove a non-matching index: ${desired.name}`);
  }
}

export async function runPasswordResetOutboxMigration({
  uri = process.env.MONGODB_URI,
  mode = process.argv.includes('--apply')
    ? 'apply'
    : process.argv.includes('--rollback')
      ? 'rollback'
      : 'dry-run',
  expectedReportSha256 = process.argv
    .find((value) => value.startsWith('--expected-report-sha256='))
    ?.split('=')[1],
} = {}) {
  if (!uri)
    throw new Error('MONGODB_URI is required; no .env files are loaded');
  if (!['dry-run', 'apply', 'rollback'].includes(mode)) {
    throw new Error(`Unsupported migration mode: ${mode}`);
  }
  if (mode !== 'dry-run' && !expectedReportSha256) {
    throw new Error(
      'Apply and rollback require a reviewed dry-run report SHA-256',
    );
  }

  const connection = await mongoose
    .createConnection(uri, {
      dbName: PASSWORD_RESET_OUTBOX_DATABASE,
      serverSelectionTimeoutMS: 5000,
    })
    .asPromise();
  try {
    const db = connection.db;
    if (!db) throw new Error('MongoDB connection did not expose a database');
    const report = await inspect(connection, uri);
    const reportSha256 = hashPasswordResetOutboxReport(report);
    if (mode === 'dry-run') return { ...report, reportSha256 };
    if (expectedReportSha256 !== reportSha256) {
      throw new Error(
        'Operation refused: report differs from the reviewed dry-run',
      );
    }
    if (!report.clean) {
      throw new Error(
        `Operation blocked by preflight findings: ${JSON.stringify(report)}`,
      );
    }

    const collection = db.collection(PASSWORD_RESET_OUTBOX_COLLECTION);
    if (mode === 'rollback') {
      if (!report.collectionExists) {
        return {
          migration: 'password-reset-outbox-v1',
          databaseName: PASSWORD_RESET_OUTBOX_DATABASE,
          action: 'NOOP',
          collectionDropped: false,
          documentsChanged: false,
          reportSha256,
        };
      }
      const currentIndexes = await collection.listIndexes().toArray();
      for (const desired of PASSWORD_RESET_OUTBOX_INDEXES) {
        const current = currentIndexes.find(
          (item) => item.name === desired.name,
        );
        if (current) {
          assertExactCurrentIndex(current, desired);
          await collection.dropIndex(desired.name);
        }
      }
      return {
        migration: 'password-reset-outbox-v1',
        databaseName: PASSWORD_RESET_OUTBOX_DATABASE,
        action: 'ROLLED_BACK',
        collectionDropped: false,
        documentsChanged: false,
        reportSha256,
      };
    }

    if (!report.collectionExists) {
      await db.createCollection(PASSWORD_RESET_OUTBOX_COLLECTION);
    }
    await collection.createIndexes(
      PASSWORD_RESET_OUTBOX_INDEXES.map(
        ({ key, name, unique, expireAfterSeconds }) => ({
          key,
          name,
          ...(unique ? { unique } : {}),
          ...(expireAfterSeconds !== undefined ? { expireAfterSeconds } : {}),
        }),
      ),
    );

    const verified = await inspect(connection, uri);
    if (!verified.clean || verified.action !== 'NOOP') {
      throw new Error(
        `Post-apply verification failed: ${JSON.stringify(verified)}`,
      );
    }
    if (verified.documentCount !== report.documentCount) {
      throw new Error('Document count changed while creating indexes');
    }
    return {
      migration: 'password-reset-outbox-v1',
      databaseName: PASSWORD_RESET_OUTBOX_DATABASE,
      action: 'APPLIED',
      collectionCreated: !report.collectionExists,
      documentCount: report.documentCount,
      reportSha256,
    };
  } finally {
    await connection.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPasswordResetOutboxMigration()
    .then((result) =>
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    )
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Migration failed'}\n`,
      );
      process.exitCode = 1;
    });
}
