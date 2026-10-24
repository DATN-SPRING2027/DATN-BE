import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEADLINE_SCAN_INDEX,
  TASK_DATABASE_NAME,
  planTaskDeadlineScanIndex,
} from './20261024-task-deadline-scan-index.mjs';

function plan(overrides = {}) {
  return planTaskDeadlineScanIndex({
    databaseName: TASK_DATABASE_NAME,
    target: 'credential-free-target-fingerprint',
    objectType: 'collection',
    taskCount: 61,
    indexes: [{ name: '_id_', key: { _id: 1 } }],
    ...overrides,
  });
}

test('plans only the additive deadline cursor index when it is missing', () => {
  const result = plan();
  assert.equal(result.clean, true);
  assert.deepEqual(result.desiredIndex, {
    name: DEADLINE_SCAN_INDEX.name,
    key: DEADLINE_SCAN_INDEX.key,
    action: 'CREATE',
  });
  assert.equal(result.taskCount, 61);
  assert.deepEqual(result.conflicts, []);
});

test('keeps an exact deadline cursor index without changing it', () => {
  const result = plan({
    indexes: [
      { name: '_id_', key: { _id: 1 } },
      { name: DEADLINE_SCAN_INDEX.name, key: DEADLINE_SCAN_INDEX.key },
    ],
  });
  assert.equal(result.clean, true);
  assert.equal(result.desiredIndex.action, 'NOOP');
});

test('blocks same-name, same-key, or option conflicts', () => {
  const conflicts = [
    { name: DEADLINE_SCAN_INDEX.name, key: { projectId: 1, _id: 1 } },
    { name: 'legacy_deadline_cursor', key: DEADLINE_SCAN_INDEX.key },
    {
      name: DEADLINE_SCAN_INDEX.name,
      key: DEADLINE_SCAN_INDEX.key,
      unique: true,
    },
  ];
  for (const index of conflicts) {
    const result = plan({ indexes: [index] });
    assert.equal(result.clean, false);
    assert.equal(result.desiredIndex.action, 'BLOCK');
  }
});

test('refuses to create the index outside the Task database or without tasks', () => {
  const wrongDatabase = plan({ databaseName: 'continuum_iam' });
  assert.equal(wrongDatabase.clean, false);
  assert.equal(wrongDatabase.desiredIndex.action, 'BLOCK');

  const missingCollection = plan({ objectType: null });
  assert.equal(missingCollection.clean, false);
  assert.equal(missingCollection.desiredIndex.action, 'BLOCK');
});
