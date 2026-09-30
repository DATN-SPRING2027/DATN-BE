import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import { buildProjectFoundationReport } from './project-foundation.plan.mjs';

const oid = (number) =>
  new Types.ObjectId(number.toString(16).padStart(24, '0'));
const organizationId = oid(1);
const projectId = oid(2);
const userId = oid(3);

test('plans PRIVATE backfill for projects missing visibility and a unique membership index', () => {
  const report = buildProjectFoundationReport({
    projects: [
      { _id: projectId, organizationId },
      { _id: oid(4), organizationId, visibility: 'PUBLIC' },
      { _id: oid(5), organizationId, visibility: 'PRIVATE' },
    ],
    projectMemberships: [],
    indexes: [{ name: '_id_', key: { _id: 1 }, unique: true }],
  });

  assert.equal(report.clean, true);
  assert.deepEqual(report.projectsToSetPrivate, [projectId.toHexString()]);
  assert.equal(report.counts.projectsToSetPrivate, 1);
  assert.equal(report.projectMembershipIndex.action, 'CREATE');
  assert.deepEqual(report.duplicateProjectMemberships, []);
});

test('reports duplicate Project memberships and refuses the unique-index plan', () => {
  const report = buildProjectFoundationReport({
    projects: [],
    projectMemberships: [
      { _id: oid(4), organizationId, projectId, userId, status: 'ACTIVE' },
      { _id: oid(5), organizationId, projectId, userId, status: 'INACTIVE' },
    ],
    indexes: [],
  });

  assert.equal(report.clean, false);
  assert.deepEqual(report.duplicateProjectMemberships, [
    {
      projectId: projectId.toHexString(),
      userId: userId.toHexString(),
      organizationIds: [organizationId.toHexString()],
      membershipIds: [oid(4).toHexString(), oid(5).toHexString()],
    },
  ]);
  assert.equal(report.projectMembershipIndex.action, 'BLOCKED_DUPLICATES');
  assert.equal(report.projectsToSetPrivate.length, 0);
});

test('reports invalid visibility and malformed membership keys without repairs', () => {
  const report = buildProjectFoundationReport({
    projects: [
      { _id: projectId, organizationId, visibility: 'TEAM_ONLY' },
      { _id: 'bad-project-id', organizationId, visibility: 'PRIVATE' },
    ],
    projectMemberships: [
      { _id: oid(6), projectId, userId: 'not-an-object-id' },
    ],
    indexes: [],
  });

  assert.equal(report.clean, false);
  assert.deepEqual(report.invalidProjectVisibility, [
    { projectId: projectId.toHexString(), value: 'TEAM_ONLY' },
  ]);
  assert.deepEqual(report.invalidProjectIds, ['bad-project-id']);
  assert.deepEqual(report.invalidProjectMembershipKeys, [oid(6).toHexString()]);
  assert.deepEqual(report.projectsToSetPrivate, []);
});

test('reports Project Membership records with mismatched scope or undefined status', () => {
  const otherOrganizationId = oid(7);
  const report = buildProjectFoundationReport({
    projects: [{ _id: projectId, organizationId }],
    projectMemberships: [
      {
        _id: oid(8),
        organizationId: otherOrganizationId,
        projectId,
        userId,
        status: 'PENDING',
      },
    ],
    indexes: [],
  });

  assert.equal(report.clean, false);
  assert.deepEqual(report.danglingProjectMemberships, [
    {
      membershipId: oid(8).toHexString(),
      projectId: projectId.toHexString(),
      organizationId: otherOrganizationId.toHexString(),
      projectOrganizationId: organizationId.toHexString(),
    },
  ]);
  assert.deepEqual(report.invalidProjectMembershipStatuses, [
    { membershipId: oid(8).toHexString(), status: 'PENDING' },
  ]);
});

test('recognizes an existing matching unique index and rejects a conflicting named index', () => {
  const matching = buildProjectFoundationReport({
    projects: [],
    projectMemberships: [],
    indexes: [
      {
        name: 'projectId_1_userId_1',
        key: { projectId: 1, userId: 1 },
        unique: true,
      },
    ],
  });
  assert.equal(matching.clean, true);
  assert.equal(matching.projectMembershipIndex.action, 'PRESENT');

  const conflicting = buildProjectFoundationReport({
    projects: [],
    projectMemberships: [],
    indexes: [
      {
        name: 'projectId_1_userId_1',
        key: { projectId: 1, userId: 1 },
        unique: false,
      },
    ],
  });
  assert.equal(conflicting.clean, false);
  assert.equal(conflicting.projectMembershipIndex.action, 'BLOCKED_CONFLICT');

  const partial = buildProjectFoundationReport({
    projects: [],
    projectMemberships: [],
    indexes: [
      {
        name: 'only_active_members',
        key: { projectId: 1, userId: 1 },
        unique: true,
        partialFilterExpression: { status: 'ACTIVE' },
      },
    ],
  });
  assert.equal(partial.clean, false);
  assert.equal(partial.projectMembershipIndex.action, 'BLOCKED_CONFLICT');

  const sparse = buildProjectFoundationReport({
    projects: [],
    projectMemberships: [],
    indexes: [
      {
        name: 'sparse_members',
        key: { projectId: 1, userId: 1 },
        unique: true,
        sparse: true,
      },
    ],
  });
  assert.equal(sparse.clean, false);
  assert.equal(sparse.projectMembershipIndex.action, 'BLOCKED_CONFLICT');
});

test('an empty legacy database is a clean no-op apart from the membership index', () => {
  const report = buildProjectFoundationReport({
    projects: [],
    projectMemberships: [],
    indexes: [],
  });

  assert.equal(report.clean, true);
  assert.deepEqual(report.projectsToSetPrivate, []);
  assert.equal(report.projectMembershipIndex.action, 'CREATE');
});
