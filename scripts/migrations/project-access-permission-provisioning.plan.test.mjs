import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getProjectAccessPermissionRollbackAdditions,
  hashProjectAccessPermissionReport,
  planProjectAccessPermissionProvisioning,
  PROJECT_ACCESS_PERMISSION_PROVISIONING,
} from './project-access-permission-provisioning.plan.mjs';

const base = {
  databaseName: 'continuum_iam',
  targetFingerprint: 'target',
  collectionExists: true,
  objectType: 'collection',
};

const role = (code, permissions, overrides = {}) => ({
  _id:
    code === 'ADMIN' ? '64a000000000000000000001' : '64a000000000000000000002',
  code,
  isSystem: true,
  permissions,
  ...overrides,
});

const expectedAdditions = {
  ADMIN: ['project.visibility.manage', 'project.leader.manage'],
  TEAM_LEADER: [
    'project.members.list',
    'project.members.add',
    'project.members.remove',
  ],
};

function completeRoles() {
  return [
    role('ADMIN', ['project.visibility.manage', 'project.leader.manage']),
    role('TEAM_LEADER', [
      'project.read',
      'project.members.list',
      'project.members.add',
      'project.members.remove',
    ]),
  ];
}

test('declares only the accepted V1 role-to-permission mapping', () => {
  assert.deepEqual(PROJECT_ACCESS_PERMISSION_PROVISIONING.roles, [
    {
      code: 'ADMIN',
      permissions: ['project.visibility.manage', 'project.leader.manage'],
    },
    {
      code: 'TEAM_LEADER',
      permissions: [
        'project.members.list',
        'project.members.add',
        'project.members.remove',
      ],
    },
  ]);
  assert.equal(
    PROJECT_ACCESS_PERMISSION_PROVISIONING.disabledPermission,
    'project.members.role.change',
  );
});

test('plans only missing approved permissions and preserves existing values', () => {
  const plan = planProjectAccessPermissionProvisioning({
    ...base,
    roles: [
      role('ADMIN', ['project.read', 'other.admin.permission']),
      role('TEAM_LEADER', ['project.read', 'other.team.permission']),
    ],
  });

  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'ADD_MISSING_PERMISSIONS');
  assert.deepEqual(
    Object.fromEntries(
      plan.roles.map(({ code, missingPermissions }) => [
        code,
        missingPermissions,
      ]),
    ),
    expectedAdditions,
  );
  assert.deepEqual(plan.roles[0].existingPermissions, [
    'project.read',
    'other.admin.permission',
  ]);
  assert.deepEqual(plan.roles[1].existingPermissions, [
    'project.read',
    'other.team.permission',
  ]);
});

test('plans NOOP when approved permissions are already present exactly once', () => {
  const plan = planProjectAccessPermissionProvisioning({
    ...base,
    roles: completeRoles(),
  });

  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'NOOP');
  assert.ok(
    plan.roles.every(
      ({ missingPermissions }) => missingPermissions.length === 0,
    ),
  );
});

test('treats a missing permissions field as empty and plans only approved additions', () => {
  const plan = planProjectAccessPermissionProvisioning({
    ...base,
    roles: [role('ADMIN', undefined), completeRoles()[1]],
  });

  assert.equal(plan.clean, true);
  assert.equal(plan.roles[0].permissionsFieldMissing, true);
  assert.deepEqual(plan.roles[0].existingPermissions, []);
  assert.deepEqual(plan.roles[0].missingPermissions, expectedAdditions.ADMIN);
});

test('blocks an unavailable collection, missing Role, or duplicate Role code', () => {
  const unavailable = planProjectAccessPermissionProvisioning({
    ...base,
    collectionExists: false,
    objectType: null,
    roles: [],
  });
  assert.equal(unavailable.clean, false);
  assert.ok(unavailable.issues.includes('ROLE_COLLECTION_UNAVAILABLE'));

  const missing = planProjectAccessPermissionProvisioning({
    ...base,
    roles: [role('ADMIN', [])],
  });
  assert.equal(missing.clean, false);
  assert.ok(missing.issues.includes('ROLE_MISSING:TEAM_LEADER'));

  const duplicate = planProjectAccessPermissionProvisioning({
    ...base,
    roles: [...completeRoles(), role('TEAM_LEADER', [])],
  });
  assert.equal(duplicate.clean, false);
  assert.ok(duplicate.issues.includes('ROLE_DUPLICATE:TEAM_LEADER'));
  assert.equal(duplicate.action, 'BLOCKED');
});

test('blocks non-system roles and invalid Role identities', () => {
  const plan = planProjectAccessPermissionProvisioning({
    ...base,
    roles: [
      role('ADMIN', [], { isSystem: false }),
      role('TEAM_LEADER', [], { _id: 'not-an-object-id' }),
    ],
  });

  assert.equal(plan.clean, false);
  assert.ok(plan.issues.includes('ROLE_NOT_SYSTEM:ADMIN'));
  assert.ok(plan.issues.includes('ROLE_ID_INVALID:TEAM_LEADER'));
});

test('blocks malformed or duplicate permission arrays without normalizing them', () => {
  const plan = planProjectAccessPermissionProvisioning({
    ...base,
    roles: [
      role('ADMIN', ['project.read', 7]),
      role('TEAM_LEADER', ['project.read', 'project.read']),
    ],
  });

  assert.equal(plan.clean, false);
  assert.ok(plan.issues.includes('PERMISSIONS_INVALID:ADMIN'));
  assert.ok(plan.issues.includes('PERMISSIONS_DUPLICATED:TEAM_LEADER'));
});

test('blocks misplaced and disabled Project permissions instead of moving or granting them', () => {
  const plan = planProjectAccessPermissionProvisioning({
    ...base,
    roles: [
      role('ADMIN', ['project.members.add']),
      role('TEAM_LEADER', [
        'project.visibility.manage',
        'project.members.role.change',
      ]),
    ],
  });

  assert.equal(plan.clean, false);
  assert.ok(plan.issues.includes('PROJECT_PERMISSION_MAPPING_INVALID:ADMIN'));
  assert.ok(
    plan.issues.includes('PROJECT_PERMISSION_MAPPING_INVALID:TEAM_LEADER'),
  );
  assert.equal(plan.action, 'BLOCKED');
});

test('blocks a known Project Access permission on a non-target Role', () => {
  const plan = planProjectAccessPermissionProvisioning({
    ...base,
    roles: [
      ...completeRoles(),
      role('MEMBER', ['project.members.add']),
      role('OBSERVER', 'project.visibility.manage'),
    ],
  });

  assert.equal(plan.clean, false);
  assert.ok(plan.issues.includes('PROJECT_PERMISSION_MAPPING_INVALID:MEMBER'));
  assert.ok(
    plan.issues.includes('PROJECT_PERMISSION_MAPPING_INVALID:OBSERVER'),
  );
  assert.equal(plan.action, 'BLOCKED');
});

test('allows the existing project.read permission on TEAM_LEADER without changing it', () => {
  const plan = planProjectAccessPermissionProvisioning({
    ...base,
    roles: completeRoles(),
  });

  assert.equal(plan.clean, true);
  assert.ok(plan.roles[1].existingPermissions.includes('project.read'));
  assert.ok(!plan.roles[0].missingPermissions.includes('project.read'));
});

test('report hash binds database target and plan content', () => {
  const first = planProjectAccessPermissionProvisioning({
    ...base,
    roles: completeRoles(),
  });
  const otherTarget = planProjectAccessPermissionProvisioning({
    ...base,
    databaseName: 'another_database',
    roles: completeRoles(),
  });

  assert.notEqual(
    hashProjectAccessPermissionReport(first),
    hashProjectAccessPermissionReport(otherTarget),
  );
});

test('rollback report records only approved permissions missing before apply', () => {
  const plan = planProjectAccessPermissionProvisioning({
    ...base,
    roles: [
      role('ADMIN', ['project.read', 'project.leader.manage']),
      role('TEAM_LEADER', ['project.read']),
    ],
  });
  const report = {
    ...plan,
    reportSha256: hashProjectAccessPermissionReport(plan),
  };
  const additions = getProjectAccessPermissionRollbackAdditions(report);

  assert.deepEqual(
    [...additions],
    [
      [
        'ADMIN',
        {
          id: '64a000000000000000000001',
          permissions: ['project.visibility.manage'],
        },
      ],
      [
        'TEAM_LEADER',
        {
          id: '64a000000000000000000002',
          permissions: [
            'project.members.list',
            'project.members.add',
            'project.members.remove',
          ],
        },
      ],
    ],
  );
});

test('rejects modified or unapproved rollback reports', () => {
  const plan = planProjectAccessPermissionProvisioning({
    ...base,
    roles: completeRoles(),
  });
  const report = {
    ...plan,
    reportSha256: hashProjectAccessPermissionReport(plan),
  };
  const modified = structuredClone(report);
  modified.roles[0].missingPermissions.push('project.members.role.change');

  assert.throws(
    () => getProjectAccessPermissionRollbackAdditions(modified),
    /saved pre-apply report is invalid or was modified/,
  );
});
