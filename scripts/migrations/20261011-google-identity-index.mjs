import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import {
  GOOGLE_SUBJECT_INDEX,
  hashGoogleIdentityIndexReport,
  planGoogleIdentityIndex,
} from './google-identity-index.plan.mjs';

const DATABASE_NAME = 'continuum_iam';
const COLLECTION_NAME = 'users';

function fingerprintTarget(uri) {
  const parsed = new URL(uri);
  const target = `${parsed.protocol}//${parsed.host}/${DATABASE_NAME}`;
  return createHash('sha256').update(target).digest('hex');
}

async function inspect(connection, uri) {
  const db = connection.db;
  if (!db) throw new Error('MongoDB connection did not expose a database');
  const matchingObjects = await db
    .listCollections({ name: COLLECTION_NAME }, { nameOnly: false })
    .toArray();
  const object = matchingObjects.find(
    (entry) => entry.name === COLLECTION_NAME,
  );
  const collectionExists = object?.type === 'collection';
  let userCount = 0;
  let duplicateSubjectGroups = 0;
  let indexes = [];

  if (collectionExists) {
    const collection = db.collection(COLLECTION_NAME);
    const [count, duplicates, currentIndexes] = await Promise.all([
      collection.countDocuments(),
      collection
        .aggregate([
          { $match: { googleSubject: { $exists: true } } },
          { $group: { _id: '$googleSubject', count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } },
          { $count: 'groups' },
        ])
        .toArray(),
      collection.listIndexes().toArray(),
    ]);
    userCount = count;
    duplicateSubjectGroups = duplicates[0]?.groups ?? 0;
    indexes = currentIndexes;
  }

  return planGoogleIdentityIndex({
    databaseName: DATABASE_NAME,
    targetFingerprint: fingerprintTarget(uri),
    collectionExists,
    objectType: object?.type ?? null,
    userCount,
    duplicateSubjectGroups,
    indexes,
  });
}

function assertExactIndex(index) {
  if (
    index?.name !== GOOGLE_SUBJECT_INDEX.name ||
    JSON.stringify(Object.entries(index.key ?? {})) !==
      JSON.stringify(Object.entries(GOOGLE_SUBJECT_INDEX.key)) ||
    index.unique !== true ||
    index.sparse !== true
  ) {
    throw new Error(
      'Refusing to remove a Google subject index with a different definition',
    );
  }
}

export async function runGoogleIdentityIndexMigration({
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
    throw new Error(
      'MONGODB_URI is required; this script does not load .env files',
    );
  if (mode !== 'dry-run' && mode !== 'apply' && mode !== 'rollback') {
    throw new Error(`Unsupported migration mode: ${mode}`);
  }
  if (mode !== 'dry-run' && !expectedReportSha256) {
    throw new Error(
      'Apply and rollback require a reviewed dry-run report SHA-256',
    );
  }
  const parsed = new URL(uri);
  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)) {
    throw new Error('MONGODB_URI must use a MongoDB protocol');
  }

  const connection = await mongoose
    .createConnection(uri, {
      dbName: DATABASE_NAME,
      serverSelectionTimeoutMS: 5000,
    })
    .asPromise();
  try {
    const db = connection.db;
    if (!db) throw new Error('MongoDB connection did not expose a database');
    const collection = db.collection(COLLECTION_NAME);
    const report = await inspect(connection, uri);
    const reportSha256 = hashGoogleIdentityIndexReport(report);

    if (mode === 'dry-run') return { ...report, reportSha256 };
    if (expectedReportSha256 !== reportSha256) {
      throw new Error(
        'Operation refused: report does not match the reviewed dry-run',
      );
    }
    if (!report.clean) {
      throw new Error(
        `Operation blocked by preflight findings: ${JSON.stringify(report)}`,
      );
    }

    if (mode === 'rollback') {
      const objects = await db
        .listCollections({ name: COLLECTION_NAME }, { nameOnly: false })
        .toArray();
      if (objects.some((entry) => entry.type === 'collection')) {
        const indexes = await collection.listIndexes().toArray();
        const matching = indexes.find(
          (index) => index.name === GOOGLE_SUBJECT_INDEX.name,
        );
        if (matching) {
          assertExactIndex(matching);
          await collection.dropIndex(GOOGLE_SUBJECT_INDEX.name);
          return {
            migration: 'google-identity-index-v1',
            databaseName: DATABASE_NAME,
            action: 'ROLLED_BACK',
            userDataChanged: false,
            reportSha256,
          };
        }
      }
      return {
        migration: 'google-identity-index-v1',
        databaseName: DATABASE_NAME,
        action: 'NOOP',
        userDataChanged: false,
        reportSha256,
      };
    }

    if (report.action === 'CREATE_COLLECTION_AND_INDEX') {
      await collection.createIndex(GOOGLE_SUBJECT_INDEX.key, {
        name: GOOGLE_SUBJECT_INDEX.name,
        unique: true,
        sparse: true,
      });
    } else if (report.action === 'CREATE_INDEX') {
      await collection.createIndex(GOOGLE_SUBJECT_INDEX.key, {
        name: GOOGLE_SUBJECT_INDEX.name,
        unique: true,
        sparse: true,
      });
    }
    const verified = await inspect(connection, uri);
    if (!verified.clean || verified.desiredIndex.action !== 'NOOP') {
      throw new Error(
        `Post-apply verification failed: ${JSON.stringify(verified)}`,
      );
    }
    if (report.action !== 'NOOP' && verified.userCount !== report.userCount) {
      throw new Error('User count changed while the index was being created');
    }
    return {
      ...verified,
      action: report.action === 'NOOP' ? 'NOOP' : 'APPLIED',
      beforeUserCount: report.userCount,
      reportSha256,
    };
  } finally {
    await connection.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGoogleIdentityIndexMigration()
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.action === 'BLOCKED') process.exitCode = 2;
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Google identity index migration failed'}\n`,
      );
      process.exitCode = 1;
    });
}
