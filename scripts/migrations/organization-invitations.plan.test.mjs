import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getDesiredOrganizationInvitationIndexes,
  planOrganizationInvitationIndexes,
} from './organization-invitations.plan.mjs';

const base = {
  databaseName: 'continuum_iam',
  targetFingerprint: 'target',
  collectionExists: false,
  objectType: null,
  documentCount: 0,
  pendingDuplicatePairs: [],
  invalidRecords: [],
  indexes: [],
};

test('plans additive indexes and creates no user or membership data', () => {
  const plan = planOrganizationInvitationIndexes(base);

  assert.equal(plan.clean, true);
  assert.equal(plan.desiredIndexes.length, 3);
  assert.ok(plan.desiredIndexes.every((index) => index.action === 'CREATE'));
  assert.equal(plan.collection, 'organization_invitations');
});

test('plans NOOP when every exact declared index exists', () => {
  const indexes = getDesiredOrganizationInvitationIndexes().map((index) => ({
    ...index,
  }));
  const plan = planOrganizationInvitationIndexes({
    ...base,
    collectionExists: true,
    objectType: 'collection',
    indexes,
  });

  assert.equal(plan.clean, true);
  assert.ok(plan.desiredIndexes.every((index) => index.action === 'NOOP'));
});

test('blocks index creation when duplicate pending invitations need manual review', () => {
  const plan = planOrganizationInvitationIndexes({
    ...base,
    collectionExists: true,
    objectType: 'collection',
    pendingDuplicatePairs: [{ organizationId: 'org', email: 'user@example.com', count: 2 }],
  });

  assert.equal(plan.clean, false);
  assert.match(plan.conflicts[0].reason, /duplicate pending/);
});

test('blocks a conflicting index with the same key but incompatible options', () => {
  const plan = planOrganizationInvitationIndexes({
    ...base,
    collectionExists: true,
    objectType: 'collection',
    indexes: [{
      name: 'organizationId_1_email_1',
      key: { organizationId: 1, email: 1 },
      unique: false,
    }],
  });

  assert.equal(plan.clean, false);
  assert.match(plan.conflicts[0].reason, /incompatible/);
});

test('blocks a view occupying the collection name', () => {
  const plan = planOrganizationInvitationIndexes({
    ...base,
    collectionExists: true,
    objectType: 'view',
  });

  assert.equal(plan.clean, false);
});

test('blocks malformed or non-normalized invitation records before indexing', () => {
  const plan = planOrganizationInvitationIndexes({
    ...base,
    collectionExists: true,
    objectType: 'collection',
    invalidRecords: [{ id: 'invite', status: 'PENDING' }],
  });

  assert.equal(plan.clean, false);
  assert.match(plan.conflicts[0].reason, /invalid invitation records/);
});
