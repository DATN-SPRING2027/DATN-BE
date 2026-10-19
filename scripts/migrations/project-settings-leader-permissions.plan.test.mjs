import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planProjectSettingsLeaderPermissions,
  hashLeaderPermissionsReport,
  getLeaderPermissionsRollbackAdditions,
} from './project-settings-leader-permissions.plan.mjs';

const baseContext = {
  databaseName: 'continuum_iam',
  targetFingerprint: 'target-hash-123',
  collectionExists: true,
  objectType: 'collection',
};

test('plans adding both permissions when TEAM_LEADER exists and is missing both', () => {
  const plan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: ['project.read', 'project.members.list'],
      },
    ],
  });

  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'ADD_MISSING_PERMISSIONS');
  assert.deepEqual(plan.role.missingPermissions, [
    'project.visibility.manage',
    'project.update',
  ]);
  assert.deepEqual(plan.role.existingPermissions, [
    'project.read',
    'project.members.list',
  ]);
  assert.deepEqual(plan.role.expectedPermissions, [
    'project.read',
    'project.members.list',
    'project.visibility.manage',
    'project.update',
  ]);
});

test('plans adding only the missing permission when TEAM_LEADER is missing 1', () => {
  const plan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: [
          'project.read',
          'project.members.list',
          'project.visibility.manage',
        ],
      },
    ],
  });

  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'ADD_MISSING_PERMISSIONS');
  assert.deepEqual(plan.role.missingPermissions, ['project.update']);
  assert.deepEqual(plan.role.existingPermissions, [
    'project.read',
    'project.members.list',
    'project.visibility.manage',
  ]);
});

test('plans NOOP when TEAM_LEADER already has both approved permissions', () => {
  const plan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: [
          'project.read',
          'project.members.list',
          'project.visibility.manage',
          'project.update',
        ],
      },
    ],
  });

  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'NOOP');
  assert.deepEqual(plan.role.missingPermissions, []);
  assert.deepEqual(plan.role.expectedPermissions, [
    'project.read',
    'project.members.list',
    'project.visibility.manage',
    'project.update',
  ]);
});

test('preserves existing permissions without overwriting them', () => {
  const customPermissions = [
    'project.read',
    'project.custom.view',
    'project.members.list',
  ];
  const plan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: customPermissions,
      },
    ],
  });

  assert.equal(plan.clean, true);
  assert.deepEqual(plan.role.existingPermissions, customPermissions);
  assert.deepEqual(plan.role.permissionsUnchanged, customPermissions);
  assert.ok(plan.role.expectedPermissions.includes('project.custom.view'));
});

test('blocks when TEAM_LEADER role is missing or duplicate', () => {
  const missing = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [],
  });
  assert.equal(missing.clean, false);
  assert.deepEqual(missing.issues, ['ROLE_MISSING:TEAM_LEADER']);
  assert.equal(missing.action, 'BLOCKED');

  const duplicate = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: [],
      },
      {
        _id: 'e0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: [],
      },
    ],
  });
  assert.equal(duplicate.clean, false);
  assert.ok(duplicate.issues.includes('ROLE_DUPLICATE:TEAM_LEADER'));
  assert.equal(duplicate.action, 'BLOCKED');
});

test('blocks when TEAM_LEADER is not a system role', () => {
  const plan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: false,
        permissions: [],
      },
    ],
  });
  assert.equal(plan.clean, false);
  assert.ok(plan.issues.includes('ROLE_NOT_SYSTEM:TEAM_LEADER'));
  assert.equal(plan.action, 'BLOCKED');
});

test('blocks when permissions field is malformed or contains duplicates', () => {
  const notArray = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: 'project.read',
      },
    ],
  });
  assert.equal(notArray.clean, false);
  assert.ok(notArray.issues.includes('PERMISSIONS_NOT_ARRAY:TEAM_LEADER'));

  const duplicated = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: ['project.read', 'project.read'],
      },
    ],
  });
  assert.equal(duplicated.clean, false);
  assert.ok(duplicated.issues.includes('PERMISSIONS_DUPLICATED:TEAM_LEADER'));
});

test('rollback extracts only permissions added by the migration based on dry-run report', () => {
  const preApplyPlan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: ['project.read', 'project.members.list'],
      },
    ],
  });

  const reportSha256 = hashLeaderPermissionsReport(preApplyPlan);
  const report = { ...preApplyPlan, reportSha256 };

  const rollback = getLeaderPermissionsRollbackAdditions(report);
  assert.equal(rollback.id, 'd0e4a4b1835649a8f2867257');
  assert.deepEqual(rollback.permissions, [
    'project.visibility.manage',
    'project.update',
  ]);
});

test('rollback fails if report is tampered or invalid', () => {
  const preApplyPlan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: ['project.read'],
      },
    ],
  });

  const reportSha256 = hashLeaderPermissionsReport(preApplyPlan);
  const report = { ...preApplyPlan, reportSha256: 'tampered-hash' };

  assert.throws(
    () => getLeaderPermissionsRollbackAdditions(report),
    /The saved pre-apply report is invalid or was modified/,
  );
});
