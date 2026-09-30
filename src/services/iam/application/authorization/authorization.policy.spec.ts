import {
  AuthorizationPolicy,
  type AuthorizationEvaluationInput,
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
