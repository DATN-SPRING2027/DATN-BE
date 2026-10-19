import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planOrganizationMembershipAdminPermissions,
  hashAdminPermissionsReport,
  getAdminPermissionsRollbackAdditions,
} from './organization-membership-admin-permissions.plan.mjs';

const baseContext = {
  databaseName: 'continuum_iam',
  targetFingerprint: 'target-hash-123',
  collectionExists: true,
  objectType: 'collection',
};

test('plans only missing approved permissions and preserves existing values', () => {
  const plan = planOrganizationMembershipAdminPermissions({
    ...baseContext,
    roles: [
      {
        _id: '83144b1b6a752e95ec40db09',
        code: 'ADMIN',
        isSystem: true,
        permissions: ['project.visibility.manage', 'project.leader.manage'],
      },
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: ['project.read', 'project.members.list'],
      },
      {
        _id: '7b969599ddca2242d9967caf',
        code: 'MEMBER',
        isSystem: true,
        permissions: ['project.read'],
      },
    ],
  });

  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'ADD_MISSING_PERMISSIONS');
  assert.deepEqual(plan.role.missingPermissions, [
    'organization.memberships.read',
    'organization.memberships.manage',
  ]);
  assert.deepEqual(plan.role.existingPermissions, [
    'project.visibility.manage',
    'project.leader.manage',
  ]);
});

test('plans NOOP when approved permissions are already present', () => {
  const plan = planOrganizationMembershipAdminPermissions({
    ...baseContext,
    roles: [
      {
        _id: '83144b1b6a752e95ec40db09',
        code: 'ADMIN',
        isSystem: true,
        permissions: [
          'project.visibility.manage',
          'project.leader.manage',
          'organization.memberships.read',
          'organization.memberships.manage',
        ],
      },
    ],
  });

  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'NOOP');
  assert.deepEqual(plan.role.missingPermissions, []);
});

test('blocks when ADMIN role is missing or duplicate', () => {
  const missing = planOrganizationMembershipAdminPermissions({
    ...baseContext,
    roles: [],
  });
  assert.equal(missing.clean, false);
  assert.deepEqual(missing.issues, ['ROLE_MISSING:ADMIN']);

  const duplicate = planOrganizationMembershipAdminPermissions({
    ...baseContext,
    roles: [
      { _id: '83144b1b6a752e95ec40db09', code: 'ADMIN', isSystem: true, permissions: [] },
      { _id: '99144b1b6a752e95ec40db09', code: 'ADMIN', isSystem: true, permissions: [] },
    ],
  });
  assert.equal(duplicate.clean, false);
  assert.ok(duplicate.issues.includes('ROLE_DUPLICATE:ADMIN'));
});

test('blocks when ADMIN is not a system role', () => {
  const plan = planOrganizationMembershipAdminPermissions({
    ...baseContext,
    roles: [
      {
        _id: '83144b1b6a752e95ec40db09',
        code: 'ADMIN',
        isSystem: false,
        permissions: [],
      },
    ],
  });
  assert.equal(plan.clean, false);
  assert.ok(plan.issues.includes('ROLE_NOT_SYSTEM:ADMIN'));
});

test('blocks when non-ADMIN roles have misplaced organization membership permissions', () => {
  const plan = planOrganizationMembershipAdminPermissions({
    ...baseContext,
    roles: [
      { _id: '83144b1b6a752e95ec40db09', code: 'ADMIN', isSystem: true, permissions: [] },
      {
        _id: '7b969599ddca2242d9967caf',
        code: 'MEMBER',
        isSystem: true,
        permissions: ['organization.memberships.read'],
      },
    ],
  });
  assert.equal(plan.clean, false);
  assert.deepEqual(plan.issues, ['MISPLACED_MEMBERSHIP_PERMISSION:MEMBER']);
});

test('computes deterministic report hash and verifies rollback additions', () => {
  const plan = planOrganizationMembershipAdminPermissions({
    ...baseContext,
    roles: [
      {
        _id: '83144b1b6a752e95ec40db09',
        code: 'ADMIN',
        isSystem: true,
        permissions: ['project.visibility.manage'],
      },
    ],
  });
  const hash = hashAdminPermissionsReport(plan);
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64);

  const report = { ...plan, reportSha256: hash };
  const additions = getAdminPermissionsRollbackAdditions(report);
  assert.deepEqual(additions, {
    id: '83144b1b6a752e95ec40db09',
    permissions: [
      'organization.memberships.read',
      'organization.memberships.manage',
    ],
  });
});
