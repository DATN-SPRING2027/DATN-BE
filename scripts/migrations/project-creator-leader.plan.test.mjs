import test from 'node:test';
import assert from 'node:assert/strict';
import { planProjectCreatorLeader } from './project-creator-leader.plan.mjs';

const mockRoles = [
  {
    _id: '6ad5ce7f4e98d4b07f5fc001',
    code: 'TEAM_LEADER',
    permissions: [
      'project.read',
      'project.members.list',
      'project.members.add',
      'project.members.remove',
    ],
  },
  {
    _id: '6ad5ce7f4e98d4b07f5fc002',
    code: 'MEMBER',
    permissions: ['project.read'],
  },
];

const mockProject = {
  _id: '6ad5ce7f4e98d4b07f5fc201',
  organizationId: '02f962598527ec6f886ddac0',
  name: 'Đồ án tốt nghiệp – Kỳ 8',
  createdBy: '850dbf46d92a708bd0c55194',
  status: 'ACTIVE',
};

const mockMembership = {
  _id: '6ad5ce7f4e98d4b07f5fc301',
  organizationId: '02f962598527ec6f886ddac0',
  projectId: '6ad5ce7f4e98d4b07f5fc201',
  userId: '850dbf46d92a708bd0c55194',
  status: 'ACTIVE',
};

test('detects legacy project creator with MEMBER role and plans promotion to TEAM_LEADER', () => {
  const roleAssignments = [
    {
      _id: '6ad5ce7f4e98d4b07f5fc401',
      organizationId: '02f962598527ec6f886ddac0',
      projectId: '6ad5ce7f4e98d4b07f5fc201',
      userId: '850dbf46d92a708bd0c55194',
      roleId: '6ad5ce7f4e98d4b07f5fc002',
      roleCode: 'MEMBER',
    },
  ];

  const plan = planProjectCreatorLeader({
    databaseName: 'continuum_iam',
    targetFingerprint: 'test-fingerprint',
    projects: [mockProject],
    memberships: [mockMembership],
    roleAssignments,
    roles: mockRoles,
  });

  assert.equal(plan.isSafe, true);
  assert.equal(plan.globalIssues.length, 0);
  assert.equal(plan.plannedPromotions.length, 1);
  assert.equal(plan.plannedPromotions[0].projectId, '6ad5ce7f4e98d4b07f5fc201');
  assert.equal(plan.plannedPromotions[0].fromRoleCode, 'MEMBER');
  assert.equal(plan.plannedPromotions[0].toRoleCode, 'TEAM_LEADER');
  assert.equal(plan.plannedPromotions[0].toRoleId, '6ad5ce7f4e98d4b07f5fc001');
  assert.equal(plan.alreadyCompliant.length, 0);
});

test('idempotent: re-planning an already compliant creator reports 0 promotions and compliant', () => {
  const roleAssignments = [
    {
      _id: '6ad5ce7f4e98d4b07f5fc401',
      organizationId: '02f962598527ec6f886ddac0',
      projectId: '6ad5ce7f4e98d4b07f5fc201',
      userId: '850dbf46d92a708bd0c55194',
      roleId: '6ad5ce7f4e98d4b07f5fc001',
      roleCode: 'TEAM_LEADER',
    },
  ];

  const plan = planProjectCreatorLeader({
    databaseName: 'continuum_iam',
    targetFingerprint: 'test-fingerprint',
    projects: [mockProject],
    memberships: [mockMembership],
    roleAssignments,
    roles: mockRoles,
  });

  assert.equal(plan.isSafe, true);
  assert.equal(plan.globalIssues.length, 0);
  assert.equal(plan.plannedPromotions.length, 0);
  assert.equal(plan.alreadyCompliant.length, 1);
  assert.equal(plan.summary.promotionsNeeded, 0);
});

test('safely skips and records projects with missing creator membership without crashing', () => {
  const plan = planProjectCreatorLeader({
    databaseName: 'continuum_iam',
    targetFingerprint: 'test-fingerprint',
    projects: [mockProject],
    memberships: [], // missing membership
    roleAssignments: [],
    roles: mockRoles,
  });

  assert.equal(plan.isSafe, false);
  assert.equal(plan.plannedPromotions.length, 0);
  assert.equal(plan.skippedProjects.length, 1);
  assert.equal(plan.skippedProjects[0].reason, 'CREATOR_MEMBERSHIP_MISSING');
});

test('rejects a malformed explicit project filter without widening to all projects', () => {
  const plan = planProjectCreatorLeader({
    databaseName: 'continuum_iam',
    targetFingerprint: 'test-fingerprint',
    targetProjectId: 'not-an-object-id',
    projects: [mockProject],
    memberships: [mockMembership],
    roleAssignments: [
      {
        _id: '6ad5ce7f4e98d4b07f5fc401',
        organizationId: mockProject.organizationId,
        projectId: mockProject._id,
        userId: mockProject.createdBy,
        roleId: mockRoles[1]._id,
        roleCode: 'MEMBER',
      },
    ],
    roles: mockRoles,
  });

  assert.equal(plan.isSafe, false);
  assert.equal(plan.targetProjectId, null);
  assert.equal(plan.summary.totalProjectsInspected, 0);
  assert.equal(plan.plannedPromotions.length, 0);
  assert.ok(plan.globalIssues.includes('TARGET_PROJECT_ID_INVALID'));
});

test('skips creator memberships whose organization differs from the Project', () => {
  const plan = planProjectCreatorLeader({
    databaseName: 'continuum_iam',
    targetFingerprint: 'test-fingerprint',
    projects: [mockProject],
    memberships: [
      { ...mockMembership, organizationId: '12f962598527ec6f886ddac0' },
    ],
    roleAssignments: [],
    roles: mockRoles,
  });

  assert.equal(plan.plannedPromotions.length, 0);
  assert.equal(
    plan.skippedProjects[0].reason,
    'CREATOR_MEMBERSHIP_ORGANIZATION_MISMATCH',
  );
});

test('skips project assignments whose organization differs from the Project', () => {
  const plan = planProjectCreatorLeader({
    databaseName: 'continuum_iam',
    targetFingerprint: 'test-fingerprint',
    projects: [mockProject],
    memberships: [mockMembership],
    roleAssignments: [
      {
        _id: '6ad5ce7f4e98d4b07f5fc401',
        organizationId: '12f962598527ec6f886ddac0',
        projectId: mockProject._id,
        userId: mockProject.createdBy,
        roleId: mockRoles[1]._id,
        roleCode: 'MEMBER',
      },
    ],
    roles: mockRoles,
  });

  assert.equal(plan.plannedPromotions.length, 0);
  assert.equal(
    plan.skippedProjects[0].reason,
    'PROJECT_ASSIGNMENT_ORGANIZATION_MISMATCH',
  );
});

test('does not trust a TEAM_LEADER roleCode when roleId resolves to a different Role', () => {
  const plan = planProjectCreatorLeader({
    databaseName: 'continuum_iam',
    targetFingerprint: 'test-fingerprint',
    projects: [mockProject],
    memberships: [mockMembership],
    roleAssignments: [
      {
        _id: '6ad5ce7f4e98d4b07f5fc401',
        organizationId: mockProject.organizationId,
        projectId: mockProject._id,
        userId: mockProject.createdBy,
        roleId: mockRoles[1]._id,
        roleCode: 'TEAM_LEADER',
      },
    ],
    roles: mockRoles,
  });

  assert.equal(plan.alreadyCompliant.length, 0);
  assert.equal(plan.plannedPromotions.length, 0);
  assert.equal(plan.skippedProjects[0].reason, 'ROLE_CODE_ID_MISMATCH');
});

test('does not promote a MEMBER-coded assignment when roleId resolves to another Role', () => {
  const plan = planProjectCreatorLeader({
    databaseName: 'continuum_iam',
    targetFingerprint: 'test-fingerprint',
    projects: [mockProject],
    memberships: [mockMembership],
    roleAssignments: [
      {
        _id: '6ad5ce7f4e98d4b07f5fc401',
        organizationId: mockProject.organizationId,
        projectId: mockProject._id,
        userId: mockProject.createdBy,
        roleId: mockRoles[0]._id,
        roleCode: 'MEMBER',
      },
    ],
    roles: mockRoles,
  });

  assert.equal(plan.plannedPromotions.length, 0);
  assert.equal(plan.skippedProjects[0].reason, 'ROLE_CODE_ID_MISMATCH');
});

test('fails safely if TEAM_LEADER role is missing or lacks required permissions', () => {
  const invalidRoles = [
    {
      _id: '6ad5ce7f4e98d4b07f5fc001',
      code: 'TEAM_LEADER',
      permissions: ['project.read'], // missing member management
    },
  ];

  const plan = planProjectCreatorLeader({
    databaseName: 'continuum_iam',
    targetFingerprint: 'test-fingerprint',
    projects: [mockProject],
    memberships: [mockMembership],
    roleAssignments: [
      {
        _id: '6ad5ce7f4e98d4b07f5fc401',
        organizationId: '02f962598527ec6f886ddac0',
        projectId: '6ad5ce7f4e98d4b07f5fc201',
        userId: '850dbf46d92a708bd0c55194',
        roleId: '6ad5ce7f4e98d4b07f5fc002',
        roleCode: 'MEMBER',
      },
    ],
    roles: invalidRoles,
  });

  assert.equal(plan.isSafe, false);
  assert.ok(
    plan.globalIssues.includes('ROLE_PERMISSIONS_INSUFFICIENT:TEAM_LEADER'),
  );
});

test('supports targetProjectId filter', () => {
  const otherProject = {
    _id: '7bd5ce7f4e98d4b07f5fc999',
    organizationId: '02f962598527ec6f886ddac0',
    name: 'Other Project',
    createdBy: '850dbf46d92a708bd0c55194',
    status: 'ACTIVE',
  };

  const roleAssignments = [
    {
      _id: '6ad5ce7f4e98d4b07f5fc401',
      organizationId: '02f962598527ec6f886ddac0',
      projectId: '6ad5ce7f4e98d4b07f5fc201',
      userId: '850dbf46d92a708bd0c55194',
      roleId: '6ad5ce7f4e98d4b07f5fc002',
      roleCode: 'MEMBER',
    },
  ];

  const plan = planProjectCreatorLeader({
    databaseName: 'continuum_iam',
    targetFingerprint: 'test-fingerprint',
    targetProjectId: '6ad5ce7f4e98d4b07f5fc201',
    projects: [mockProject, otherProject],
    memberships: [mockMembership],
    roleAssignments,
    roles: mockRoles,
  });

  assert.equal(plan.summary.totalProjectsInspected, 1);
  assert.equal(plan.plannedPromotions.length, 1);
  assert.equal(plan.plannedPromotions[0].projectId, '6ad5ce7f4e98d4b07f5fc201');
});
