import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTURE_DATABASE_NAME,
  TASK_CLARIFICATION_LEDGER_INDEXES,
  planTaskClarificationLedgerIndexes,
} from './20261102-task-clarification-ledger-indexes.mjs';

function plan(overrides = {}) {
  return planTaskClarificationLedgerIndexes({
    databaseName: CAPTURE_DATABASE_NAME,
    target: 'credential-free-target-fingerprint',
    objectType: 'collection',
    documentCount: 12,
    indexes: [{ name: '_id_', key: { _id: 1 } }],
    ...overrides,
  });
}

test('plans additive task_clarification_ledger indexes on existing or fresh continuum_capture', () => {
  const existing = plan();
  assert.equal(existing.clean, true);
  assert.deepEqual(
    existing.desiredIndexes.map(({ name, action }) => ({ name, action })),
    TASK_CLARIFICATION_LEDGER_INDEXES.map(({ name }) => ({
      name,
      action: 'CREATE',
    })),
  );

  const fresh = plan({ objectType: null, documentCount: 0, indexes: [] });
  assert.equal(fresh.clean, true);
  assert.ok(fresh.desiredIndexes.every((index) => index.action === 'CREATE'));
});

test('treats exact declared indexes as NOOP', () => {
  const result = plan({
    indexes: [
      { name: '_id_', key: { _id: 1 } },
      ...TASK_CLARIFICATION_LEDGER_INDEXES.map((index) => ({ ...index })),
    ],
  });
  assert.equal(result.clean, true);
  assert.ok(result.desiredIndexes.every((index) => index.action === 'NOOP'));
});

test('blocks wrong database, view objectType, or conflicting index definitions', () => {
  assert.equal(plan({ databaseName: 'continuum_iam' }).clean, false);
  assert.equal(plan({ objectType: 'view' }).clean, false);

  const conflict = plan({
    indexes: [
      {
        name: 'ledger_task_answered_at',
        key: { taskId: 1, answeredAt: -1 },
      },
    ],
  });
  assert.equal(conflict.clean, false);
  assert.ok(conflict.desiredIndexes.every((index) => index.action === 'BLOCK'));
});
