import {
  AuthorizationPolicy,
  type AuthorizationEvaluationInput,
  type CapabilityGrantEvidence,
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
  roleAssignments: [],
  grants: [],
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
    });
  });

  it.each([
    [
      'other organization',
      (facts: ProjectReadScopeInput) => {
        facts.requestedOrganizationId = otherOrgId;
      },
    ],
    [
      'inactive membership',
      (facts: ProjectReadScopeInput) => {
        facts.membership!.status = 'SUSPENDED';
      },
    ],
    [
      'explicit deny',
      (facts: ProjectReadScopeInput) => {
        facts.explicitDeny = 'DENY';
      },
    ],
    [
      'missing project membership',
      (facts: ProjectReadScopeInput) => {
        facts.activeProjectMembershipIds = [];
      },
    ],
    [
      'missing Role permission',
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
    ],
    [
      'mismatched Role',
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
    ],
  ])('denies %s', (_case, mutate) => {
    const facts = readBase();
    mutate(facts);
    expect(policy.projectReadScope(facts)).toEqual({
      all: false,
      projectIds: [],
    });
  });
});

describe('AuthorizationPolicy: documented project.create boundary', () => {
  const policy = new AuthorizationPolicy();

  it('allows an organization ADMIN only with active membership and a clear deny assessment', () => {
    const facts = base();
    facts.roleAssignments = [
      { userId, organizationId: orgId, roleCode: 'ADMIN' },
    ];
    expect(policy.evaluate(facts).allowed).toBe(true);
  });

  it('allows a TEAM_LEADER with a valid organization grant', () => {
    const facts = base();
    facts.roleAssignments = [
      { userId, organizationId: orgId, roleCode: 'TEAM_LEADER' },
    ];
    facts.grants = [
      {
        userId,
        organizationId: orgId,
        capability: 'project.create',
        expiresAt: new Date(now.getTime() + 1000),
      },
    ];
    expect(policy.evaluate(facts).allowed).toBe(true);
  });

  it.each(['PENDING_INVITE', 'SUSPENDED', 'REMOVED'])(
    'denies %s organization membership',
    (status) => {
      const facts = base();
      facts.membership!.status = status;
      facts.roleAssignments = [
        { userId, organizationId: orgId, roleCode: 'ADMIN' },
      ];
      expect(policy.evaluate(facts).allowed).toBe(false);
    },
  );

  it('denies missing membership even if an organization role exists', () => {
    const facts = base();
    facts.membership = null;
    facts.roleAssignments = [
      { userId, organizationId: orgId, roleCode: 'ADMIN' },
    ];
    expect(policy.evaluate(facts).allowed).toBe(false);
  });

  it('denies cross-organization requests and project-scoped ADMIN assignments', () => {
    const crossOrg = base();
    crossOrg.requestedOrganizationId = otherOrgId;
    crossOrg.roleAssignments = [
      { userId, organizationId: orgId, roleCode: 'ADMIN' },
    ];
    expect(policy.evaluate(crossOrg).allowed).toBe(false);

    const scoped = base();
    scoped.roleAssignments = [
      {
        userId,
        organizationId: orgId,
        projectId: 'eeeeeeeeeeeeeeeeeeeeeeee',
        roleCode: 'ADMIN',
      },
    ];
    expect(policy.evaluate(scoped).allowed).toBe(false);
  });

  it.each(['DENY', 'UNKNOWN'] as const)(
    'denies when explicit deny assessment is %s',
    (explicitDeny) => {
      const facts = base();
      facts.explicitDeny = explicitDeny;
      facts.roleAssignments = [
        { userId, organizationId: orgId, roleCode: 'ADMIN' },
      ];
      expect(policy.evaluate(facts).allowed).toBe(false);
    },
  );

  it('denies a leader with no grant or a revoked grant', () => {
    const facts = base();
    facts.roleAssignments = [
      { userId, organizationId: orgId, roleCode: 'TEAM_LEADER' },
    ];
    expect(policy.evaluate(facts).allowed).toBe(false);
    facts.grants = [
      {
        userId,
        organizationId: orgId,
        capability: 'project.create',
        expiresAt: new Date(now.getTime() + 1000),
        revokedAt: now,
      },
    ];
    expect(policy.evaluate(facts).allowed).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['invalid', new Date(Number.NaN)],
    ['not a Date', '2026-09-30T00:00:00.000Z'],
    ['at evaluation time', now],
    ['past', new Date(now.getTime() - 1)],
  ])('denies a TEAM_LEADER grant with %s expiry', (_label, expiresAt) => {
    const facts = base();
    facts.roleAssignments = [
      { userId, organizationId: orgId, roleCode: 'TEAM_LEADER' },
    ];
    facts.grants = [
      {
        userId,
        organizationId: orgId,
        capability: 'project.create',
        expiresAt,
      } as unknown as CapabilityGrantEvidence,
    ];
    expect(policy.evaluate(facts).allowed).toBe(false);
  });

  it('does not let a MEMBER or a grant from another organization create a project', () => {
    const facts = base();
    facts.roleAssignments = [
      { userId, organizationId: orgId, roleCode: 'MEMBER' },
    ];
    facts.grants = [
      {
        userId,
        organizationId: orgId,
        capability: 'project.create',
        expiresAt: new Date(now.getTime() + 1000),
      },
    ];
    expect(policy.evaluate(facts).allowed).toBe(false);

    facts.roleAssignments = [
      { userId, organizationId: orgId, roleCode: 'TEAM_LEADER' },
    ];
    facts.grants = [{ ...facts.grants[0], organizationId: otherOrgId }];
    expect(policy.evaluate(facts).allowed).toBe(false);
  });

  it('denies an inactive User even with active membership and ADMIN assignment', () => {
    const facts = base();
    facts.subject!.status = 'SUSPENDED';
    facts.roleAssignments = [
      { userId, organizationId: orgId, roleCode: 'ADMIN' },
    ];
    expect(policy.evaluate(facts).allowed).toBe(false);
  });
});
