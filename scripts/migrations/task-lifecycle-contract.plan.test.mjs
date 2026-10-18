import assert from 'node:assert/strict';
import test from 'node:test';
import {
  planTaskLifecycleContract,
  TASK_LIFECYCLE_INDEXES,
} from './task-lifecycle-contract.plan.mjs';

const emptySnapshot = () => ({
  databaseName: 'continuum_task',
  targetFingerprint: 'a'.repeat(64),
  collections: {
    tasks: { objectType: 'collection', indexes: [] },
    task_events: {
      objectType: 'collection',
      invalidDocuments: 0,
      indexes: [
        {
          name: 'task_event_task_version_unique',
          key: { taskId: 1, taskVersion: 1 },
          unique: true,
        },
      ],
    },
    task_operations: { objectType: null, indexes: [] },
  },
  tasks: {
    count: 8,
    missingStatus: 8,
    missingAssigneeId: 8,
    missingCompletedAt: 8,
    invalidLifecycleDocuments: 0,
    invalidDocuments: 0,
  },
  taskEvents: {
    count: 8,
    duplicateCreationVersions: 0,
    duplicateMutationVersions: 0,
  },
  taskOperations: { count: 0, invalidDocuments: 0, duplicateKeys: 0 },
});

test('plans additive lifecycle backfill and exact index replacement without changing input', () => {
  const snapshot = emptySnapshot();
  const before = structuredClone(snapshot);
  const plan = planTaskLifecycleContract(snapshot);

  assert.equal(plan.clean, true);
  assert.deepEqual(snapshot, before);
  assert.equal(plan.taskCount, 8);
  assert.deepEqual(plan.tasksToBackfill, {
    status: 8,
    assigneeId: 8,
    completedAt: 8,
  });
  assert.equal(plan.legacyEventIndexAction, 'DROP_EXACT_LEGACY_INDEX');
  assert.equal(
    plan.taskEventIndexes.filter(({ action }) => action === 'CREATE').length,
    2,
  );
  assert.equal(
    plan.taskOperationIndexes.filter(({ action }) => action === 'CREATE')
      .length,
    2,
  );
  assert.equal(plan.preservesTaskAndEventDocuments, true);
  assert.match(plan.reportSha256, /^[0-9a-f]{64}$/);
});

test('is idempotent after lifecycle fields and all exact indexes are installed', () => {
  const snapshot = emptySnapshot();
  snapshot.collections.task_operations = {
    objectType: 'collection',
    indexes: TASK_LIFECYCLE_INDEXES.task_operations.map((index) => ({
      ...index,
    })),
  };
  snapshot.collections.task_events.indexes =
    TASK_LIFECYCLE_INDEXES.task_events.map((index) => ({ ...index }));
  snapshot.tasks.missingStatus = 0;
  snapshot.tasks.missingAssigneeId = 0;
  snapshot.tasks.missingCompletedAt = 0;
  snapshot.taskOperations.count = 5;

  const plan = planTaskLifecycleContract(snapshot);

  assert.equal(plan.clean, true);
  assert.equal(plan.legacyEventIndexAction, 'KEEP_ABSENT');
  assert.equal(
    plan.taskEventIndexes.every(({ action }) => action === 'KEEP'),
    true,
  );
  assert.equal(
    plan.taskOperationIndexes.every(({ action }) => action === 'KEEP'),
    true,
  );
});

test('blocks invalid legacy shapes and duplicate lifecycle invariants', () => {
  const snapshot = emptySnapshot();
  snapshot.tasks.invalidDocuments = 1;
  snapshot.taskEvents.invalidDocuments = 1;
  snapshot.taskOperations.invalidDocuments = 1;
  snapshot.taskEvents.duplicateMutationVersions = 2;
  snapshot.taskOperations.duplicateKeys = 1;

  const plan = planTaskLifecycleContract(snapshot);

  assert.equal(plan.clean, false);
  assert.ok(plan.issues.includes('TASK_DOCUMENTS_INVALID'));
  assert.ok(plan.issues.includes('TASK_EVENT_DOCUMENTS_INVALID'));
  assert.ok(plan.issues.includes('TASK_OPERATION_DOCUMENTS_INVALID'));
  assert.ok(plan.issues.includes('DUPLICATE_TASK_MUTATION_EVENT_VERSIONS'));
  assert.ok(plan.issues.includes('DUPLICATE_TASK_OPERATION_KEYS'));
});

test('blocks missing owned collections and incompatible named indexes', () => {
  const snapshot = emptySnapshot();
  snapshot.collections.task_events.objectType = 'view';
  snapshot.collections.task_operations.objectType = 'view';
  snapshot.collections.task_events.indexes[0].key = { taskId: 1, projectId: 1 };

  const plan = planTaskLifecycleContract(snapshot);

  assert.equal(plan.clean, false);
  assert.ok(plan.issues.includes('TASK_EVENT_COLLECTION_MISSING_OR_INVALID'));
  assert.ok(plan.issues.includes('TASK_OPERATION_COLLECTION_INVALID'));
  assert.ok(plan.issues.includes('LEGACY_TASK_EVENT_INDEX_CONFLICT'));
});

test('report hash binds target and preflight evidence', () => {
  const snapshot = emptySnapshot();
  const first = planTaskLifecycleContract(snapshot);
  const differentTarget = planTaskLifecycleContract({
    ...snapshot,
    targetFingerprint: 'b'.repeat(64),
  });
  const differentData = planTaskLifecycleContract({
    ...snapshot,
    tasks: { ...snapshot.tasks, count: 9 },
  });

  assert.notEqual(first.reportSha256, differentTarget.reportSha256);
  assert.notEqual(first.reportSha256, differentData.reportSha256);
});

test('blocks an unrecognized full unique legacy event index with the target key', () => {
  const snapshot = emptySnapshot();
  snapshot.collections.task_events.indexes.push({
    name: 'untracked_full_task_version_unique',
    key: { taskId: 1, taskVersion: 1 },
    unique: true,
  });

  const plan = planTaskLifecycleContract(snapshot);

  assert.equal(plan.clean, false);
  assert.ok(
    plan.issues.includes(
      'SAME_KEY_INDEX_CONFLICT:task_events:task_event_task_creation_version_unique',
    ),
  );
});

test('blocks a same-name lifecycle index with weaker sparse or hidden options', () => {
  const snapshot = emptySnapshot();
  snapshot.collections.task_operations.indexes = [
    {
      ...TASK_LIFECYCLE_INDEXES.task_operations[0],
      sparse: true,
    },
  ];

  const plan = planTaskLifecycleContract(snapshot);

  assert.equal(plan.clean, false);
  assert.ok(
    plan.issues.includes(
      'INDEX_CONFLICT:task_operations:task_operation_actor_project_key_unique',
    ),
  );
});
