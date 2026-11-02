import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { targetFingerprint } from './organization-membership-backfill.plan.mjs';

export const CAPTURE_DATABASE_NAME = 'continuum_capture';
export const LEDGER_COLLECTION_NAME = 'task_clarification_ledger';
export const TASK_CLARIFICATION_LEDGER_INDEXES = [
  {
    key: {
      organizationId: 1,
      projectId: 1,
      taskId: 1,
      disposition: 1,
      answeredAt: -1,
    },
    name: 'ledger_task_answered_at',
  },
  {
    key: { organizationId: 1, projectId: 1, noteId: 1 },
    name: 'ledger_note_lookup',
  },
];

function sameKey(left = {}, right = {}) {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value], index) =>
        rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value,
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

export function planTaskClarificationLedgerIndexes({
  databaseName,
  target,
  objectType,
  documentCount,
  indexes,
}) {
  const observed = TASK_CLARIFICATION_LEDGER_INDEXES.map((desired) => {
    const relevant = indexes.filter(
      (index) => index.name === desired.name || sameKey(index.key, desired.key),
    );
    const conflicts = relevant.filter((index) => !sameIndex(index, desired));
    return {
      name: desired.name,
      key: desired.key,
      action:
        conflicts.length > 0
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
    databaseName === CAPTURE_DATABASE_NAME &&
    (objectType === 'collection' || objectType === null);
  const noIndexConflicts = observed.every((index) => index.action !== 'BLOCK');
  const clean = scopeMatches && noIndexConflicts;

  return {
    migration: '20261102-task-clarification-ledger-indexes',
    target,
    databaseName,
    collection: LEDGER_COLLECTION_NAME,
    objectType,
    documentCount,
    clean,
    desiredIndexes: observed.map((index) => ({
      name: index.name,
      key: index.key,
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
  const captureWritesPaused = process.argv.includes('--capture-writes-paused');
  const expectedHash = process.argv
    .find((argument) => argument.startsWith('--expected-report-sha256='))
    ?.split('=')[1];

  if (apply && !captureWritesPaused) {
    throw new Error('Apply requires the --capture-writes-paused assertion');
  }
  if (apply && !expectedHash) {
    throw new Error('Apply requires a reviewed dry-run report SHA-256');
  }

  const captureMongoUri = process.env.CAPTURE_MONGODB_URI;
  if (!captureMongoUri) {
    throw new Error(
      'CAPTURE_MONGODB_URI must be explicitly provided by the caller',
    );
  }

  const fingerprint = targetFingerprint(captureMongoUri, CAPTURE_DATABASE_NAME);
  const connection = mongoose.createConnection(captureMongoUri, {
    dbName: CAPTURE_DATABASE_NAME,
    autoIndex: false,
    serverSelectionTimeoutMS: 5000,
  });

  async function inspect(db) {
    const listed = await db
      .listCollections({ name: LEDGER_COLLECTION_NAME })
      .toArray();
    const objectType = listed[0]?.type ?? null;
    const collection = db.collection(LEDGER_COLLECTION_NAME);
    const indexes =
      objectType === 'collection' ? await collection.indexes() : [];
    const documentCount =
      objectType === 'collection'
        ? await collection.estimatedDocumentCount()
        : 0;
    const plan = planTaskClarificationLedgerIndexes({
      databaseName: db.databaseName,
      target: fingerprint,
      objectType,
      documentCount,
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
    if (!db || db.databaseName !== CAPTURE_DATABASE_NAME) {
      throw new Error('Connected database does not match continuum_capture');
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

      if (plan.objectType === null) {
        await db.createCollection(LEDGER_COLLECTION_NAME);
      }

      for (const desired of plan.desiredIndexes) {
        if (desired.action === 'NOOP') continue;
        await db
          .collection(LEDGER_COLLECTION_NAME)
          .createIndex(desired.key, { name: desired.name });
      }

      const verification = await inspect(db);
      if (
        !verification.clean ||
        verification.objectType !== 'collection' ||
        verification.desiredIndexes.some((index) => index.action !== 'NOOP')
      ) {
        throw new Error(
          'Task clarification ledger index migration verification failed',
        );
      }
      process.stdout.write(
        'Verified task_clarification_ledger indexes; documents were not modified.\n',
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
