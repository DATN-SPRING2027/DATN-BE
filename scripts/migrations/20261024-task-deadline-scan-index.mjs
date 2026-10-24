import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { targetFingerprint } from './organization-membership-backfill.plan.mjs';

export const TASK_DATABASE_NAME = 'continuum_task';
export const TASK_COLLECTION_NAME = 'tasks';
export const DEADLINE_SCAN_INDEX = {
  key: { dueDate: 1, _id: 1 },
  name: 'deadline_scan_due_cursor',
};

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])]),
    );
  }
  return value;
}

function hasExpectedKey(index) {
  return (
    JSON.stringify(normalize(index.key)) ===
    JSON.stringify(normalize(DEADLINE_SCAN_INDEX.key))
  );
}

function isExactIndex(index) {
  return (
    index.name === DEADLINE_SCAN_INDEX.name &&
    hasExpectedKey(index) &&
    !index.unique &&
    index.expireAfterSeconds === undefined &&
    index.partialFilterExpression === undefined
  );
}

export function planTaskDeadlineScanIndex({
  databaseName,
  target,
  objectType,
  taskCount,
  indexes,
}) {
  const relevantIndexes = indexes.filter(
    (index) =>
      index.name === DEADLINE_SCAN_INDEX.name || hasExpectedKey(index),
  );
  const conflicts = relevantIndexes.filter((index) => !isExactIndex(index));
  const exact = relevantIndexes.some(isExactIndex);
  const scopeMatches =
    databaseName === TASK_DATABASE_NAME && objectType === 'collection';

  return {
    migration: '20261024-task-deadline-scan-index',
    target,
    databaseName,
    collection: TASK_COLLECTION_NAME,
    objectType,
    taskCount,
    observedRelevantIndexes: relevantIndexes.length,
    clean: scopeMatches && conflicts.length === 0,
    conflicts: conflicts.map((index) => ({
      name: index.name ?? null,
      key: index.key ?? null,
    })),
    desiredIndex: {
      name: DEADLINE_SCAN_INDEX.name,
      key: DEADLINE_SCAN_INDEX.key,
      action: !scopeMatches || conflicts.length > 0
        ? 'BLOCK'
        : exact
          ? 'NOOP'
          : 'CREATE',
    },
  };
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) ===
    path.resolve(process.argv[1]);

async function runMigration() {
  const apply = process.argv.includes('--apply');
  const taskWritesPaused = process.argv.includes('--task-writes-paused');
  const expectedHash = process.argv
    .find((argument) => argument.startsWith('--expected-report-sha256='))
    ?.split('=')[1];

  if (apply && !taskWritesPaused) {
    throw new Error('Apply requires the --task-writes-paused assertion');
  }
  if (apply && !expectedHash) {
    throw new Error('Apply requires a reviewed dry-run report SHA-256');
  }
  const taskMongoUri = process.env.TASK_MONGODB_URI;
  if (!taskMongoUri) {
    throw new Error(
      'TASK_MONGODB_URI must be explicitly provided by the caller',
    );
  }

  const fingerprint = targetFingerprint(taskMongoUri, TASK_DATABASE_NAME);
  const connection = mongoose.createConnection(taskMongoUri, {
    dbName: TASK_DATABASE_NAME,
    autoIndex: false,
    serverSelectionTimeoutMS: 5000,
  });

  async function inspect(db) {
    const listed = await db
      .listCollections({ name: TASK_COLLECTION_NAME })
      .toArray();
    const objectType = listed[0]?.type ?? null;
    const collection = db.collection(TASK_COLLECTION_NAME);
    const indexes =
      objectType === 'collection' ? await collection.indexes() : [];
    const taskCount =
      objectType === 'collection'
        ? await collection.estimatedDocumentCount()
        : 0;
    const plan = planTaskDeadlineScanIndex({
      databaseName: db.databaseName,
      target: fingerprint,
      objectType,
      taskCount,
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
    if (!db || db.databaseName !== TASK_DATABASE_NAME) {
      throw new Error('Connected database does not match continuum_task');
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

      if (plan.desiredIndex.action === 'CREATE') {
        await db
          .collection(TASK_COLLECTION_NAME)
          .createIndex(DEADLINE_SCAN_INDEX.key, {
            name: DEADLINE_SCAN_INDEX.name,
          });
      }

      const verification = await inspect(db);
      if (
        !verification.clean ||
        verification.desiredIndex.action !== 'NOOP'
      ) {
        throw new Error('Deadline scan index migration verification failed');
      }
      process.stdout.write(
        'Verified the deadline scan index; Task documents were not modified.\n',
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
