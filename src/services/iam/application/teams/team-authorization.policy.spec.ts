import { TeamAuthorizationPolicy } from './team-authorization.policy';
import type {
  TeamActionPermission,
  TeamAuthorizationEvaluationInput,
} from './team-authorization.policy';

const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const orgId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const projectId = 'cccccccccccccccccccccccc';

type MutableAuthorizationInput = Omit<
  TeamAuthorizationEvaluationInput,
  'assignments'
> & {
  assignments: Array<TeamAuthorizationEvaluationInput['assignments'][number]>;
};

function baseline(permission: TeamActionPermission): MutableAuthorizationInput {
  const permissionsByAction: Record<TeamActionPermission, string[]> = {
    'team.create': ['team.create', 'team.children.manage'],
    'team.update': ['team.update', 'team.children.manage'],
    'team.archive': ['team.archive', 'team.children.manage'],
    'team.restore': ['team.restore', 'team.children.manage'],
    'team.read': ['team.read', 'team.children.manage'],
  };
  return {
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
    assignments: [
      {
        userId,
        organizationId: orgId,
        projectId,
        roleCode: 'TEAM_LEADER',
        resolvedRoleCode: 'TEAM_LEADER',
        permissions: permissionsByAction[permission],
      },
    ],
    explicitDeny: 'CLEAR' as const,
  };
}

describe('TeamAuthorizationPolicy', () => {
  const policy = new TeamAuthorizationPolicy();
  const operationPermissions: Array<[TeamActionPermission, string[]]> = [
    ['team.create', ['team.create', 'team.children.manage']],
    ['team.update', ['team.update', 'team.children.manage']],
    ['team.archive', ['team.archive', 'team.children.manage']],
    ['team.restore', ['team.restore', 'team.children.manage']],
    ['team.read', ['team.read', 'team.children.manage']],
  ];

  it.each(operationPermissions.slice(0, 4))(
    'allows %s only with its operation capability and child-management capability',
    (permission, permissions) => {
      const input = baseline(permission);
      input.assignments[0].permissions = [...permissions];
      expect(policy.evaluate(input)).toEqual({
        allowed: true,
        access: 'MANAGER',
      });
    },
  );

  it.each(operationPermissions)(
    'denies %s when team.children.manage is absent',
    (permission, [actionPermission]) => {
      const input = baseline(permission);
      input.assignments[0].permissions = [actionPermission];
      expect(policy.evaluate(input).allowed).toBe(false);
    },
  );

  it.each(operationPermissions)(
    'denies %s when its operation capability is absent',
    (permission) => {
      const input = baseline(permission);
      input.assignments[0].permissions = ['team.children.manage'];
      expect(policy.evaluate(input).allowed).toBe(false);
    },
  );

  it('allows candidate manager reads only with team.read and team.children.manage', () => {
    const input = baseline('team.read');
    expect(policy.evaluate(input)).toEqual({
      allowed: true,
      access: 'MANAGER',
    });
    input.assignments[0].permissions = ['team.read'];
    expect(policy.evaluate(input).allowed).toBe(false);
    input.assignments[0].permissions = ['team.children.manage'];
    expect(policy.evaluate(input).allowed).toBe(false);
  });

  it.each([
    [
      'another actor',
      (input: MutableAuthorizationInput) => {
        input.assignments[0].userId = 'eeeeeeeeeeeeeeeeeeeeeeee';
      },
    ],
    [
      'another Organization',
      (input: MutableAuthorizationInput) => {
        input.assignments[0].organizationId = 'ffffffffffffffffffffffff';
      },
    ],
    [
      'another Project',
      (input: MutableAuthorizationInput) => {
        input.assignments[0].projectId = 'dddddddddddddddddddddddd';
      },
    ],
  ])('denies a candidate read assignment scoped to %s', (_scope, mutate) => {
    const input = baseline('team.read');
    mutate(input);
    expect(policy.evaluate(input).allowed).toBe(false);
  });

  it('does not infer candidate read access from an Organization ADMIN role', () => {
    const input = baseline('team.read');
    input.assignments[0].projectId = null;
    input.assignments[0].roleCode = 'ADMIN';
    input.assignments[0].resolvedRoleCode = 'ADMIN';
    expect(policy.evaluate(input).allowed).toBe(false);
  });

  it('denies MEMBER reads until the current admission proof provider is available', () => {
    const input = baseline('team.read');
    input.assignments[0] = {
      ...input.assignments[0],
      roleCode: 'MEMBER',
      resolvedRoleCode: 'MEMBER',
      permissions: ['team.read'],
    };
    expect(policy.evaluate(input).allowed).toBe(false);
  });

  it('does not grant ordinary members write access even if their role has write codes', () => {
    const input = baseline('team.update');
    input.assignments[0].roleCode = 'MEMBER';
    input.assignments[0].resolvedRoleCode = 'MEMBER';
    expect(policy.evaluate(input).allowed).toBe(false);
  });

  it.each([
    [
      'missing organization membership',
      (input: MutableAuthorizationInput) => {
        input.membership = null;
      },
    ],
    [
      'inactive Project',
      (input: MutableAuthorizationInput) => {
        input.project!.status = 'ARCHIVED';
      },
    ],
    [
      'missing Project membership',
      (input: MutableAuthorizationInput) => {
        input.projectMembership = null;
      },
    ],
    [
      'unknown explicit deny',
      (input: MutableAuthorizationInput) => {
        input.explicitDeny = 'UNKNOWN';
      },
    ],
    [
      'explicit deny despite a positive grant',
      (input: MutableAuthorizationInput) => {
        input.explicitDeny = 'DENY';
      },
    ],
    [
      'cross-Project assignment',
      (input: MutableAuthorizationInput) => {
        input.assignments[0].projectId = 'dddddddddddddddddddddddd';
      },
    ],
    [
      'stale role resolution',
      (input: MutableAuthorizationInput) => {
        input.assignments[0].resolvedRoleCode = 'MEMBER';
      },
    ],
    [
      'organization ADMIN',
      (input: MutableAuthorizationInput) => {
        input.assignments[0].projectId = null;
        input.assignments[0].roleCode = 'ADMIN';
        input.assignments[0].resolvedRoleCode = 'ADMIN';
      },
    ],
  ])('denies %s', (_case, mutate) => {
    const input = baseline('team.create');
    mutate(input);
    expect(policy.evaluate(input).allowed).toBe(false);
  });

  it('denies when the current Role no longer carries a revoked capability', () => {
    const input = baseline('team.update');
    input.assignments[0].permissions = ['team.children.manage'];
    expect(policy.evaluate(input).allowed).toBe(false);
  });

  it('denies a revoked Project RoleAssignment when it is no longer present', () => {
    const input = baseline('team.update');
    input.assignments = [];
    expect(policy.evaluate(input).allowed).toBe(false);
  });
});
