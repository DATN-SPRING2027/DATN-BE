import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import { buildBackfillReport, resolveIamDatabaseName, targetFingerprint } from './organization-membership-backfill.plan.mjs';

const oid = (number) => new Types.ObjectId(number.toString(16).padStart(24, '0'));
const user = oid(1);
const organization = oid(2);

test('chooses the same IAM database as shared and dedicated runtime modes', () => {
  assert.equal(resolveIamDatabaseName({ mongodbEnabled: 'true', infraEnabled: 'false', configuredName: 'continuum_db' }), 'continuum_db');
  assert.equal(resolveIamDatabaseName({ mongodbEnabled: 'false', infraEnabled: 'true', configuredName: 'continuum_db' }), 'continuum_iam');
  assert.throws(() => resolveIamDatabaseName({ mongodbEnabled: 'false', infraEnabled: 'false', configuredName: 'continuum_db' }));
});

test('reviewed target fingerprint changes with endpoint or database', () => {
  const original = targetFingerprint('mongodb://user:secret@host-a:27017', 'continuum_db');
  assert.notEqual(original, targetFingerprint('mongodb://user:secret@host-b:27017', 'continuum_db'));
  assert.notEqual(original, targetFingerprint('mongodb://user:secret@host-a:27017', 'other_db'));
  assert.notEqual(original, targetFingerprint('mongodb://other:password@host-a:27017', 'continuum_db'));
  assert.match(targetFingerprint('mongodb://host-a:27017,host-b:27017/continuum_db?replicaSet=rs0', 'continuum_db'), /^[a-f0-9]{64}$/);
});

test('deduplicates organization-level roles and excludes project roles', () => {
  const report = buildBackfillReport({
    users: [{ _id: user }], organizations: [{ _id: organization }],
    assignments: [
      { _id: oid(3), userId: user, organizationId: organization },
      { _id: oid(4), userId: user, organizationId: organization, projectId: null },
      { _id: oid(5), userId: user, organizationId: organization, projectId: oid(6) },
    ],
    memberships: [],
  });
  assert.equal(report.clean, true);
  assert.equal(report.counts.projectScopedExcluded, 1);
  assert.equal(report.toCreate.length, 1);
  assert.equal(report.toCreate[0].status, 'ACTIVE');
  assert.equal(report.duplicateLegacyRelationships.length, 1);
});

test('rerun leaves existing membership untouched and flags inactive conflict', () => {
  const base = { users: [{ _id: user }], organizations: [{ _id: organization }],
    assignments: [{ _id: oid(3), userId: user, organizationId: organization }] };
  const active = buildBackfillReport({ ...base,
    memberships: [{ _id: oid(4), userId: user, organizationId: organization, status: 'ACTIVE' }] });
  assert.equal(active.clean, true);
  assert.equal(active.toCreate.length, 0);
  const suspended = buildBackfillReport({ ...base,
    memberships: [{ _id: oid(4), userId: user, organizationId: organization, status: 'SUSPENDED' }] });
  assert.equal(suspended.clean, false);
  assert.equal(suspended.toCreate.length, 0);
  assert.equal(suspended.conflictingExistingMemberships.length, 1);
});

test('reports unmatched and dangling references without inventing memberships', () => {
  const report = buildBackfillReport({
    users: [{ _id: user }], organizations: [{ _id: organization }],
    assignments: [{ _id: oid(3), userId: oid(7), organizationId: organization }],
    memberships: [],
  });
  assert.equal(report.clean, false);
  assert.equal(report.toCreate.length, 0);
  assert.deepEqual(report.usersWithoutOrganizationLevelLegacyRelationship, [user.toHexString()]);
  assert.equal(report.danglingLegacyRelationships[0].missingUser, true);
});
