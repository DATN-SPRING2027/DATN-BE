import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import {
  EMAIL_REGISTRATION_OUTBOX_COLLECTION,
  EMAIL_REGISTRATION_OUTBOX_DATABASE,
  EMAIL_REGISTRATION_OUTBOX_INDEXES,
  hashEmailRegistrationOutboxReport,
  isExactEmailRegistrationOutboxIndex,
  planEmailRegistrationOutboxIndexes,
} from './email-registration-outbox.plan.mjs';

function fingerprintTarget(uri) {
  const parsed = new URL(uri);
  return createHash('sha256')
    .update(`${parsed.protocol}//${parsed.host}/${EMAIL_REGISTRATION_OUTBOX_DATABASE}`)
    .digest('hex');
}

async function inspect(connection, uri) {
  const db = connection.db;
  if (!db) throw new Error('MongoDB connection did not expose a database');
  const objects = await db
    .listCollections({ name: EMAIL_REGISTRATION_OUTBOX_COLLECTION }, { nameOnly: false })
    .toArray();
  const object = objects.find((entry) => entry.name === EMAIL_REGISTRATION_OUTBOX_COLLECTION);
  const collectionExists = object?.type === 'collection';
  let documentCount = 0;
  let malformedDocumentCount = 0;
  let duplicateEmailGroups = 0;
  let duplicateTokenHashGroups = 0;
  let indexes = [];

  if (collectionExists) {
    const collection = db.collection(EMAIL_REGISTRATION_OUTBOX_COLLECTION);
    const [count, malformed, duplicateEmails, duplicateTokens, currentIndexes] =
      await Promise.all([
        collection.countDocuments(),
        collection.countDocuments({
          $or: [
            { normalizedEmail: { $not: /^[^\s@]{1,64}@[^\s@]{1,255}$/ } },
            { normalizedEmail: { $regex: /[A-Z\s]/ } },
            { fullName: { $not: /^[\s\S]{1,160}$/ } },
            { fullName: { $not: /\S/ } },
            { fullName: { $regex: /^\s|\s$/ } },
            { tokenHash: { $not: /^[0-9a-f]{64}$/i } },
            { expiresAt: { $not: { $type: 'date' } } },
            { nextAttemptAt: { $not: { $type: 'date' } } },
            { attemptCount: { $not: { $type: 'number' } } },
            { attemptCount: { $lt: 0 } },
            { deliveryStatus: { $nin: ['PENDING', 'SENDING', 'SENT', 'FAILED', 'IGNORED'] } },
            { tokenClaimUntil: { $exists: true, $not: { $type: 'date' } } },
            {
              $and: [
                { deliveryStatus: { $in: ['PENDING', 'SENDING'] } },
                { encryptedPayload: { $not: { $type: 'string' } } },
              ],
            },
            { encryptedPayload: { $exists: true, $not: { $type: 'string' } } },
          ],
        }),
        collection
          .aggregate([
            { $group: { _id: '$normalizedEmail', count: { $sum: 1 } } },
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
    duplicateEmailGroups = duplicateEmails[0]?.groups ?? 0;
    duplicateTokenHashGroups = duplicateTokens[0]?.groups ?? 0;
    indexes = currentIndexes;
  }

  return planEmailRegistrationOutboxIndexes({
    targetFingerprint: fingerprintTarget(uri),
    collectionExists,
    collectionCollation: object?.options?.collation,
    objectType: object?.type ?? null,
    documentCount,
    malformedDocumentCount,
    duplicateEmailGroups,
    duplicateTokenHashGroups,
    indexes,
  });
}

function assertExactCurrentIndex(current, desired) {
  if (!isExactEmailRegistrationOutboxIndex(current, desired)) {
    throw new Error(`Refusing to remove a non-matching index: ${desired.name}`);
  }
}

export async function runEmailRegistrationOutboxMigration({
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
  if (!uri) throw new Error('MONGODB_URI is required; no .env files are loaded');
  if (!['dry-run', 'apply', 'rollback'].includes(mode)) {
    throw new Error(`Unsupported migration mode: ${mode}`);
  }
  if (mode !== 'dry-run' && !expectedReportSha256) {
    throw new Error('Apply and rollback require a reviewed dry-run report SHA-256');
  }

  const connection = await mongoose
    .createConnection(uri, {
      dbName: EMAIL_REGISTRATION_OUTBOX_DATABASE,
      serverSelectionTimeoutMS: 5000,
    })
    .asPromise();
  try {
    const db = connection.db;
    if (!db) throw new Error('MongoDB connection did not expose a database');
    const report = await inspect(connection, uri);
    const reportSha256 = hashEmailRegistrationOutboxReport(report);
    if (mode === 'dry-run') return { ...report, reportSha256 };
    if (expectedReportSha256 !== reportSha256) {
      throw new Error('Operation refused: report differs from the reviewed dry-run');
    }
    if (!report.clean) {
      throw new Error(`Operation blocked by preflight findings: ${JSON.stringify(report)}`);
    }

    const collection = db.collection(EMAIL_REGISTRATION_OUTBOX_COLLECTION);
    if (mode === 'rollback') {
      if (!report.collectionExists) {
        return {
          migration: 'email-registration-outbox-v1',
          databaseName: EMAIL_REGISTRATION_OUTBOX_DATABASE,
          action: 'NOOP',
          collectionDropped: false,
          documentsChanged: false,
          reportSha256,
        };
      }
      const currentIndexes = await collection.listIndexes().toArray();
      for (const desired of EMAIL_REGISTRATION_OUTBOX_INDEXES) {
        const current = currentIndexes.find((item) => item.name === desired.name);
        if (current) {
          assertExactCurrentIndex(current, desired);
          await collection.dropIndex(desired.name);
        }
      }
      return {
        migration: 'email-registration-outbox-v1',
        databaseName: EMAIL_REGISTRATION_OUTBOX_DATABASE,
        action: 'ROLLED_BACK',
        collectionDropped: false,
        documentsChanged: false,
        reportSha256,
      };
    }

    if (!report.collectionExists) {
      await db.createCollection(EMAIL_REGISTRATION_OUTBOX_COLLECTION, {
        collation: { locale: 'simple' },
      });
    }
    await collection.createIndexes(
      EMAIL_REGISTRATION_OUTBOX_INDEXES.map(
        ({ key, ...options }) => ({
          key,
          ...options,
        }),
      ),
    );
    const verified = await inspect(connection, uri);
    if (!verified.clean || verified.action !== 'NOOP') {
      throw new Error(`Post-apply verification failed: ${JSON.stringify(verified)}`);
    }
    if (verified.documentCount !== report.documentCount) {
      throw new Error('Document count changed while creating indexes');
    }
    return {
      migration: 'email-registration-outbox-v1',
      databaseName: EMAIL_REGISTRATION_OUTBOX_DATABASE,
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
  runEmailRegistrationOutboxMigration()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed'}\n`);
      process.exitCode = 1;
    });
}
