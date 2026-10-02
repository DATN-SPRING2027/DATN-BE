import {
  AuthorizationPolicy,
  type AuthorizationEvaluationInput,
  type ProjectAccessEvaluationInput,
  type ProjectAccessPermission,
  type ProjectReadScopeInput,
} from './authorization.policy';

const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const orgId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const otherOrgId = 'cccccccccccccccccccccccc';
const now = new Date('2026-09-29T12:00:00.000Z');

const base = (): AuthorizationEvaluationInput => ({
  permission: 'project.create',
  subject: { userId, organizationId: orgId, status: 'ACTIVE' },
  requestedOrganizationId: orgId,
  membership: { userId, organizationId: orgId, status: 'ACTIVE' },
  explicitDeny: 'CLEAR',
  now,
});

describe('AuthorizationPolicy: Project metadata read scope', () => {
  const policy = new AuthorizationPolicy();
  const projectId = 'dddddddddddddddddddddddd';
  const readBase = (): ProjectReadScopeInput => ({
    subject: { userId, organizationId: orgId, status: 'ACTIVE' },
    requestedOrganizationId: orgId,
    membership: { userId, organizationId: orgId, status: 'ACTIVE' },
    assignments: [
      {
        projectId,
        roleCode: 'MEMBER',
        resolvedRoleCode: 'MEMBER',
        permissions: ['project.read'],
      },
    ],
    activeProjectMembershipIds: [projectId],
    explicitDeny: 'CLEAR',
  });

  it('limits MEMBER to an active Project Membership with project.read', () => {
    expect(policy.projectReadScope(readBase())).toEqual({
      all: false,
      projectIds: [projectId],
      includePublicProjects: true,
    });
  });

  it('matches Mongo ObjectId project identifiers regardless of hex casing', () => {
    const facts = readBase();
    facts.assignments[0].projectId = projectId.toUpperCase();
    facts.activeProjectMembershipIds = [projectId];
    expect(policy.projectReadScope(facts)).toEqual({
      all: false,
      projectIds: [projectId],
      includePublicProjects: true,
    });
  });

  it('allows organization ADMIN to read all metadata only with a current Role', () => {
    const facts = readBase();
    facts.assignments = [
      {
        projectId: null,
        roleCode: 'ADMIN',
        resolvedRoleCode: 'ADMIN',
        permissions: [],
      },
    ];
    facts.activeProjectMembershipIds = [];
    expect(policy.projectReadScope(facts)).toEqual({
      all: true,
      projectIds: [],
      includePublicProjects: false,
    });
  });

  it('includes public metadata for an ACTIVE Organization member without a Project role', () => {
    const facts = readBase();
    facts.assignments = [];
    facts.activeProjectMembershipIds = [];
    expect(policy.projectReadScope(facts)).toEqual({
      all: false,
      projectIds: [],
      includePublicProjects: true,
    });
  });

  it.each([
    [
      'other organization',
      (facts: ProjectReadScopeInput) => {
        facts.requestedOrganizationId = otherOrgId;
      },
      false,
    ],
    [
      'inactive membership',
      (facts: ProjectReadScopeInput) => {
        facts.membership!.status = 'SUSPENDED';
      },
      false,
    ],
    [
      'explicit deny',
      (facts: ProjectReadScopeInput) => {
        facts.explicitDeny = 'DENY';
      },
      false,
    ],
    [
      'missing private Project membership',
      (facts: ProjectReadScopeInput) => {
        facts.activeProjectMembershipIds = [];
      },
      true,
    ],
    [
      'missing private Role permission',
      (facts: ProjectReadScopeInput) => {
        facts.assignments = [
          {
            projectId,
            roleCode: 'MEMBER',
            resolvedRoleCode: 'MEMBER',
            permissions: [],
          },
        ];
      },
      true,
    ],
    [
      'mismatched private Role',
      (facts: ProjectReadScopeInput) => {
        facts.assignments = [
          {
            projectId,
            roleCode: 'MEMBER',
            resolvedRoleCode: 'ADMIN',
            permissions: ['project.read'],
          },
        ];
      },
      true,
    ],
  ])(
    'does not authorize private Project through %s',
    (_case, mutate, includePublicProjects) => {
      const facts = readBase();
      mutate(facts);
      expect(policy.projectReadScope(facts)).toEqual({
        all: false,
        projectIds: [],
        includePublicProjects,
      });
    },
  );
});

describe('AuthorizationPolicy: active-membership project.create rule', () => {
  const policy = new AuthorizationPolicy();

  it('allows an ACTIVE OrganizationMembership without a role or capability grant', () => {
    const facts = base();
    expect(policy.evaluate(facts).allowed).toBe(true);
  });

  it.each(['PENDING_INVITE', 'SUSPENDED', 'REMOVED'])(
    'denies %s organization membership',
    (status) => {
      const facts = base();
      facts.membership!.status = status;
      expect(policy.evaluate(facts).allowed).toBe(false);
    },
  );

  it('denies missing membership', () => {
    const facts = base();
    facts.membership = null;
    expect(policy.evaluate(facts).allowed).toBe(false);
  });

  it('denies cross-organization context and mismatched membership evidence', () => {
    const crossOrg = base();
    crossOrg.requestedOrganizationId = otherOrgId;
    expect(policy.evaluate(crossOrg).allowed).toBe(false);

    const otherOrganizationMembership = base();
    otherOrganizationMembership.membership!.organizationId = otherOrgId;
    expect(policy.evaluate(otherOrganizationMembership).allowed).toBe(false);

    const otherUserMembership = base();
    otherUserMembership.membership!.userId = 'eeeeeeeeeeeeeeeeeeeeeeee';
    expect(policy.evaluate(otherUserMembership).allowed).toBe(false);
  });

  it.each(['DENY', 'UNKNOWN'] as const)(
    'denies when explicit deny assessment is %s',
    (explicitDeny) => {
      const facts = base();
      facts.explicitDeny = explicitDeny;
      expect(policy.evaluate(facts).allowed).toBe(false);
    },
  );

  it('denies an inactive User even with an ACTIVE membership', () => {
    const facts = base();
    facts.subject!.status = 'SUSPENDED';
    expect(policy.evaluate(facts).allowed).toBe(false);
  });

  it('denies invalid evaluation time', () => {
    const facts = base();
    facts.now = new Date(Number.NaN);
    expect(policy.evaluate(facts).allowed).toBe(false);
  });
});

describe('AuthorizationPolicy: Project Access V1 permissions', () => {
  const policy = new AuthorizationPolicy();
  const projectId = 'dddddddddddddddddddddddd';
  const projectAccessBase = (
    permission: ProjectAccessEvaluationInput['permission'],
  ): ProjectAccessEvaluationInput => ({
    permission,
    subject: { userId, organizationId: orgId, status: 'ACTIVE' },
    requestedOrganizationId: orgId,
    requestedProjectId: projectId,
    project: { id: projectId, organizationId: orgId, status: 'ACTIVE' },
    membership: { userId, organizationId: orgId, status: 'ACTIVE' },
    projectMembership: {
      userId,
      organizationId: orgId,
      projectId,
      status: 'ACTIVE',
    },
    assignments: [],
    explicitDeny: 'CLEAR',
  });
  const projectAssignment = (
    assignmentProjectId: string | null,
    roleCode: string,
    resolvedRoleCode: string | null,
    permissions: string[],
  ) => ({
    userId,
    organizationId: orgId,
    projectId: assignmentProjectId,
    roleCode,
    resolvedRoleCode,
    permissions,
  });

  it('allows organization ADMIN with project.visibility.manage to publish a private Project', () => {
    const facts = projectAccessBase('project.visibility.manage');
    facts.project = {
      id: projectId,
      organizationId: orgId,
      status: 'ACTIVE',
      visibility: 'PRIVATE',
    };
    facts.assignments = [
      projectAssignment(null, 'ADMIN', 'ADMIN', ['project.visibility.manage']),
    ];
    facts.projectMembership = null;
    expect(policy.evaluateProjectAccess(facts).allowed).toBe(true);
  });

  it('allows organization ADMIN with project.leader.manage to manage Leader Project appointments', () => {
    const facts = projectAccessBase('project.leader.manage');
    facts.projectMembership = null;
    facts.assignments = [
      projectAssignment(null, 'ADMIN', 'ADMIN', ['project.leader.manage']),
    ];
    expect(policy.evaluateProjectAccess(facts)).toEqual({ allowed: true });
  });

  it('denies the disabled project.members.role.change code even if it is present on a Role', () => {
    const facts = projectAccessBase('project.members.list');
    facts.permission = 'project.members.role.change' as ProjectAccessPermission;
    facts.assignments = [
      projectAssignment(projectId, 'TEAM_LEADER', 'TEAM_LEADER', [
        'project.members.role.change',
      ]),
    ];
    expect(policy.evaluateProjectAccess(facts)).toEqual({
      allowed: false,
      reason: 'NO_DOCUMENTED_PERMISSION',
    });
  });

  it.each([
    'project.members.list',
    'project.members.add',
    'project.members.remove',
  ] as const)(
    'allows %s only with an ACTIVE ProjectMembership and scoped TEAM_LEADER permission',
    (permission) => {
      const facts = projectAccessBase(permission);
      facts.assignments = [
        projectAssignment(projectId, 'TEAM_LEADER', 'TEAM_LEADER', [
          permission,
        ]),
      ];
      expect(policy.evaluateProjectAccess(facts).allowed).toBe(true);
      facts.projectMembership!.status = 'INACTIVE';
      expect(policy.evaluateProjectAccess(facts).allowed).toBe(false);
    },
  );

  it('resolves a case-variant Project path ID against canonical Project, membership, and role evidence', () => {
    const facts = projectAccessBase('project.members.add');
    facts.requestedProjectId = projectId.toUpperCase();
    facts.assignments = [
      projectAssignment(projectId, 'TEAM_LEADER', 'TEAM_LEADER', [
        'project.members.add',
      ]),
    ];
    expect(policy.evaluateProjectAccess(facts)).toEqual({ allowed: true });
  });

  it.each(['not-an-object-id', 'g'.repeat(24), ''])(
    'denies malformed Project ID %s',
    (requestedProjectId) => {
      const facts = projectAccessBase('project.members.add');
      facts.requestedProjectId = requestedProjectId;
      facts.assignments = [
        projectAssignment(projectId, 'TEAM_LEADER', 'TEAM_LEADER', [
          'project.members.add',
        ]),
      ];
      expect(policy.evaluateProjectAccess(facts)).toEqual({
        allowed: false,
        reason: 'INVALID_CONTEXT',
      });
    },
  );

  it('does not let another Project ID, including an uppercase representation, reuse this Project evidence', () => {
    const facts = projectAccessBase('project.members.add');
    facts.requestedProjectId = 'eeeeeeeeeeeeeeeeeeeeeeee'.toUpperCase();
    facts.assignments = [
      projectAssignment(projectId, 'TEAM_LEADER', 'TEAM_LEADER', [
        'project.members.add',
      ]),
    ];
    expect(policy.evaluateProjectAccess(facts)).toEqual({
      allowed: false,
      reason: 'INVALID_CONTEXT',
    });
  });

  it.each([
    [
      'organization ADMIN alone cannot list project members',
      'project.members.list',
      null,
      'ADMIN',
      'ADMIN',
      ['project.members.list'],
    ],
    [
      'organization ADMIN alone cannot add project members',
      'project.members.add',
      null,
      'ADMIN',
      'ADMIN',
      ['project.members.add'],
    ],
    [
      'organization ADMIN alone cannot remove project members',
      'project.members.remove',
      null,
      'ADMIN',
      'ADMIN',
      ['project.members.remove'],
    ],
    [
      'organization ADMIN without project.leader.manage cannot manage leaders',
      'project.leader.manage',
      null,
      'ADMIN',
      'ADMIN',
      ['project.visibility.manage'],
    ],
    [
      'organization ADMIN needs the exact permission for visibility',
      'project.visibility.manage',
      null,
      'ADMIN',
      'ADMIN',
      ['project.leader.manage'],
    ],
    [
      'TEAM_LEADER without the permission is denied',
      'project.members.add',
      projectId,
      'TEAM_LEADER',
      'TEAM_LEADER',
      [],
    ],
    [
      'TEAM_LEADER without a matching project assignment is denied',
      'project.members.add',
      'eeeeeeeeeeeeeeeeeeeeeeee',
      'TEAM_LEADER',
      'TEAM_LEADER',
      ['project.members.add'],
    ],
    [
      'a project-scoped ADMIN is not an organization leader',
      'project.visibility.manage',
      projectId,
      'ADMIN',
      'ADMIN',
      ['project.visibility.manage'],
    ],
    [
      'a project-scoped TEAM_LEADER cannot change visibility',
      'project.visibility.manage',
      projectId,
      'TEAM_LEADER',
      'TEAM_LEADER',
      ['project.visibility.manage'],
    ],
    [
      'a project-scoped TEAM_LEADER cannot appoint another Leader Project',
      'project.leader.manage',
      projectId,
      'TEAM_LEADER',
      'TEAM_LEADER',
      ['project.leader.manage'],
    ],
    [
      'a MEMBER cannot change visibility',
      'project.visibility.manage',
      projectId,
      'MEMBER',
      'MEMBER',
      ['project.visibility.manage'],
    ],
    [
      'a stale Role code is denied',
      'project.members.add',
      projectId,
      'TEAM_LEADER',
      'MEMBER',
      ['project.members.add'],
    ],
  ] as const)(
    'denies when %s',
    (
      _case,
      permission,
      assignmentProjectId,
      roleCode,
      resolvedRoleCode,
      permissions,
    ) => {
      const facts = projectAccessBase(permission);
      facts.assignments = [
        projectAssignment(assignmentProjectId, roleCode, resolvedRoleCode, [
          ...permissions,
        ]),
      ];
      expect(policy.evaluateProjectAccess(facts).allowed).toBe(false);
    },
  );

  it.each(['PENDING_INVITE', 'SUSPENDED', 'REMOVED'])(
    'denies non-ACTIVE OrganizationMembership status %s',
    (status) => {
      const facts = projectAccessBase('project.members.list');
      facts.membership!.status = status;
      expect(policy.evaluateProjectAccess(facts).allowed).toBe(false);
    },
  );

  it('rejects ProjectMembership and RoleAssignment evidence from another scope or User', () => {
    const wrongMembershipOrganization = projectAccessBase(
      'project.members.add',
    );
    wrongMembershipOrganization.projectMembership!.organizationId = otherOrgId;
    wrongMembershipOrganization.assignments = [
      projectAssignment(projectId, 'TEAM_LEADER', 'TEAM_LEADER', [
        'project.members.add',
      ]),
    ];
    expect(
      policy.evaluateProjectAccess(wrongMembershipOrganization).allowed,
    ).toBe(false);

    const wrongAssignmentUser = projectAccessBase('project.members.add');
    wrongAssignmentUser.assignments = [
      {
        ...projectAssignment(projectId, 'TEAM_LEADER', 'TEAM_LEADER', [
          'project.members.add',
        ]),
        userId: 'ffffffffffffffffffffffff',
      },
    ];
    expect(policy.evaluateProjectAccess(wrongAssignmentUser).allowed).toBe(
      false,
    );

    const wrongAssignmentOrganization = projectAccessBase(
      'project.members.add',
    );
    wrongAssignmentOrganization.assignments = [
      {
        ...projectAssignment(projectId, 'TEAM_LEADER', 'TEAM_LEADER', [
          'project.members.add',
        ]),
        organizationId: otherOrgId,
      },
    ];
    expect(
      policy.evaluateProjectAccess(wrongAssignmentOrganization).allowed,
    ).toBe(false);
  });

  it('denies cross-organization, cross-project, and archived access while leaving visibility state to the mutation contract', () => {
    const facts = projectAccessBase('project.members.list');
    facts.requestedOrganizationId = otherOrgId;
    expect(policy.evaluateProjectAccess(facts).allowed).toBe(false);

    const archived = projectAccessBase('project.members.list');
    archived.project!.status = 'ARCHIVED';
    expect(policy.evaluateProjectAccess(archived).allowed).toBe(false);

    const alreadyPublic = projectAccessBase('project.visibility.manage');
    alreadyPublic.project = {
      id: projectId,
      organizationId: orgId,
      status: 'ACTIVE',
      visibility: 'PUBLIC',
    };
    alreadyPublic.assignments = [
      projectAssignment(null, 'ADMIN', 'ADMIN', ['project.visibility.manage']),
    ];
    expect(policy.evaluateProjectAccess(alreadyPublic).allowed).toBe(true);
  });
});
