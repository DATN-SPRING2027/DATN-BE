import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getDesiredOrganizationInvitationTokenIndex,
  planOrganizationInvitationTokenIndex,
} from './organization-invitation-token-index.plan.mjs';

const base = {
  databaseName: 'continuum_iam',
  targetFingerprint: 'target',
  objectType: 'collection',
  documentCount: 4,
  v3InvitationCount: 0,
  v3InvitationsWithoutTokenHashCount: 0,
  pendingV3InvitationCount: 0,
  duplicateTokenHashGroups: 0,
  malformedTokenHashCount: 0,
  indexes: [],
};

test('plans an additive unique partial index without backfilling records', () => {
  const plan = planOrganizationInvitationTokenIndex(base);
  assert.equal(plan.clean, true);
  assert.equal(plan.documentCount, 4);
  assert.equal(plan.desiredIndex.action, 'CREATE');
  assert.deepEqual(plan.desiredIndex.key, { tokenHash: 1 });
  assert.deepEqual(plan.desiredIndex.partialFilterExpression, {
    tokenHash: { $type: 'string' },
  });
});

test('plans NOOP for an exact token hash index', () => {
  const plan = planOrganizationInvitationTokenIndex({
    ...base,
    indexes: [getDesiredOrganizationInvitationTokenIndex()],
  });
  assert.equal(plan.clean, true);
  assert.equal(plan.desiredIndex.action, 'NOOP');
});

test('keeps rollback disabled while any V3 invitation history exists', () => {
  const plan = planOrganizationInvitationTokenIndex({
    ...base,
    v3InvitationCount: 1,
  });
  assert.equal(plan.clean, true);
  assert.equal(plan.rollbackAllowed, false);
});

test('blocks an incompatible index on tokenHash', () => {
  const plan = planOrganizationInvitationTokenIndex({
    ...base,
    indexes: [{ name: 'tokenHash_1', key: { tokenHash: 1 }, unique: false }],
  });
  assert.equal(plan.clean, false);
  assert.match(plan.conflicts[0].reason, /incompatible/);
});

test('blocks duplicate and malformed hashes without returning token material', () => {
  const plan = planOrganizationInvitationTokenIndex({
    ...base,
    duplicateTokenHashGroups: 1,
    malformedTokenHashCount: 2,
  });
  assert.equal(plan.clean, false);
  assert.equal(JSON.stringify(plan).includes('tokenHashValue'), false);
  assert.equal(plan.conflicts.length, 2);
});

test('blocks V3 invitations that lack their required token hash', () => {
  const plan = planOrganizationInvitationTokenIndex({
    ...base,
    v3InvitationCount: 1,
    v3InvitationsWithoutTokenHashCount: 1,
  });
  assert.equal(plan.clean, false);
  assert.match(plan.conflicts[0].reason, /without token hashes/);
});

test('blocks apply if the existing invitation collection is missing', () => {
  const plan = planOrganizationInvitationTokenIndex({
    ...base,
    objectType: null,
  });
  assert.equal(plan.clean, false);
  assert.match(plan.conflicts[0].reason, /existing collection/);
});
