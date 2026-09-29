import {
  AuthorizationPolicy,
  type AuthorizationEvaluationInput,
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

  it('denies a leader with no grant or an expired or revoked grant', () => {
    const facts = base();
    facts.roleAssignments = [
      { userId, organizationId: orgId, roleCode: 'TEAM_LEADER' },
    ];
    expect(policy.evaluate(facts).allowed).toBe(false);
    for (const grant of [{ expiresAt: now }, { revokedAt: now }]) {
      facts.grants = [
        {
          userId,
          organizationId: orgId,
          capability: 'project.create',
          ...grant,
        },
      ];
      expect(policy.evaluate(facts).allowed).toBe(false);
    }
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
