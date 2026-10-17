import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_AUTHORITY_CHANGE_OPERATIONS_INDEXES,
  planPlatformAuthorityChangeOperations,
} from './platform-authority-change-operations.plan.mjs';

const base = (overrides = {}) => ({
  databaseName: 'continuum_iam_test',
  targetFingerprint: 'reviewed-target',
  collectionExists: false,
  objectType: null,
  documentCount: 0,
  duplicateOperations: [],
  invalidRecords: [],
  indexes: [],
  ...overrides,
});

test('plans isolated collection and required indexes without touching records', () => {
  const plan = planPlatformAuthorityChangeOperations(base());
  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'CREATE_COLLECTION_AND_INDEXES');
  assert.deepEqual(
    plan.desiredIndexes.map(({ action }) => action),
    ['CREATE', 'CREATE', 'CREATE'],
  );
});

test('plans NOOP when collection already has the exact declared indexes', () => {
  const plan = planPlatformAuthorityChangeOperations(
    base({
      collectionExists: true,
      objectType: 'collection',
      indexes: PLATFORM_AUTHORITY_CHANGE_OPERATIONS_INDEXES,
    }),
  );
  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'NOOP');
  assert.deepEqual(
    plan.desiredIndexes.map(({ action }) => action),
    ['NOOP', 'NOOP', 'NOOP'],
  );
});

test('blocks duplicate operation IDs instead of overwriting them', () => {
  const plan = planPlatformAuthorityChangeOperations(
    base({
      collectionExists: true,
      objectType: 'collection',
      documentCount: 2,
      duplicateOperations: [
        {
          operationId: 'op-123',
          count: 2,
        },
      ],
    }),
  );
  assert.equal(plan.clean, false);
  assert.equal(plan.action, 'BLOCKED');
});

test('blocks conflicting index definitions and unexpected database objects', () => {
  const conflict = planPlatformAuthorityChangeOperations(
    base({
      collectionExists: true,
      objectType: 'collection',
      indexes: [
        {
          key: PLATFORM_AUTHORITY_CHANGE_OPERATIONS_INDEXES[0].key,
          unique: false,
        },
      ],
    }),
  );
  assert.equal(conflict.clean, false);
  assert.equal(conflict.desiredIndexes[0].action, 'CONFLICT');

  const view = planPlatformAuthorityChangeOperations(
    base({ collectionExists: true, objectType: 'view' }),
  );
  assert.equal(view.clean, false);
  assert.equal(view.action, 'BLOCKED');
});

test('blocks equivalent keys with a name that differs from the runtime schema', () => {
  const plan = planPlatformAuthorityChangeOperations(
    base({
      collectionExists: true,
      objectType: 'collection',
      indexes: [
        {
          ...PLATFORM_AUTHORITY_CHANGE_OPERATIONS_INDEXES[0],
          name: 'legacy_operation_id_key',
        },
      ],
    }),
  );
  assert.equal(plan.clean, false);
  assert.equal(plan.desiredIndexes[0].action, 'CONFLICT');
});

test('blocks malformed existing platform authority change operation records', () => {
  const plan = planPlatformAuthorityChangeOperations(
    base({
      collectionExists: true,
      objectType: 'collection',
      invalidRecords: [{ id: 'record-1', reason: 'malformed payload hash' }],
    }),
  );
  assert.equal(plan.clean, false);
  assert.equal(plan.action, 'BLOCKED');
});
