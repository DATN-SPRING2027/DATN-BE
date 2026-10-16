import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_AUTHORITY_CHANGE_LOCKS,
  planPlatformAuthorityChangeHardening,
} from './platform-authority-change-hardening.plan.mjs';

const ttlIndex = {
  key: { expiresAt: 1 },
  name: 'platform_authority_operation_expiry',
  expireAfterSeconds: 0,
};
const lockIndex = {
  key: { permission: 1, scope: 1 },
  name: 'platform_authority_change_lock_key',
  unique: true,
};

function basePlan(overrides = {}) {
  return planPlatformAuthorityChangeHardening({
    databaseName: 'continuum_iam',
    targetFingerprint: 'target:iam-mongodb',
    operations: {
      collectionExists: true,
      objectType: 'collection',
      documentCount: 0,
      indexes: [],
      ...overrides.operations,
    },
    locks: {
      collectionExists: false,
      objectType: null,
      documentCount: 0,
      indexes: [],
      validLockKeys: [],
      ...overrides.locks,
    },
  });
}

test('plans the ledger TTL index and three permission locks', () => {
  const plan = basePlan();

  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'APPLY_HARDENING');
  assert.equal(
    plan.operations.desiredIndexes[0].name,
    'platform_authority_operation_expiry',
  );
  assert.equal(plan.operations.desiredIndexes[0].action, 'CREATE');
  assert.equal(plan.locks.desiredIndexes[0].action, 'CREATE');
  assert.equal(plan.locks.missingLockKeys.length, 3);
});

test('is a no-op when the TTL index, lock index, and all lock rows exist', () => {
  const plan = basePlan({
    operations: { indexes: [ttlIndex] },
    locks: {
      collectionExists: true,
      objectType: 'collection',
      documentCount: 3,
      indexes: [lockIndex],
      validLockKeys: PLATFORM_AUTHORITY_CHANGE_LOCKS.map(
        ({ permission, scope }) => `${scope}:${permission}`,
      ),
    },
  });

  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'NOOP');
  assert.deepEqual(plan.locks.missingLockKeys, []);
  assert.equal(plan.operations.desiredIndexes[0].action, 'NOOP');
});

test('blocks when the prerequisite operations collection is missing', () => {
  const plan = basePlan({
    operations: { collectionExists: false, objectType: null },
  });

  assert.equal(plan.clean, false);
  assert.equal(plan.action, 'BLOCKED');
});

test('blocks a conflicting TTL index on expiresAt', () => {
  const plan = basePlan({
    operations: {
      indexes: [
        { ...ttlIndex, name: 'wrong_expiry', expireAfterSeconds: 3600 },
      ],
    },
  });

  assert.equal(plan.clean, false);
  assert.equal(plan.operations.desiredIndexes[0].action, 'CONFLICT');
});

test('blocks duplicate lock keys and malformed lock rows', () => {
  const plan = basePlan({
    locks: {
      collectionExists: true,
      objectType: 'collection',
      duplicateLockPairs: [{ permission: 'organization.create', count: 2 }],
      invalidLockRows: [{ id: 'redacted-id', reason: 'invalid-version' }],
    },
  });

  assert.equal(plan.clean, false);
  assert.equal(plan.action, 'BLOCKED');
});

test('blocks a non-collection object using the lock collection name', () => {
  const plan = basePlan({
    locks: { collectionExists: true, objectType: 'view' },
  });

  assert.equal(plan.clean, false);
  assert.equal(plan.action, 'BLOCKED');
});
