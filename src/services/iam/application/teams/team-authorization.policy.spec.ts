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
        permissions: ['team.read', 'team:children.manage'],
      },
    ],
    explicitDeny: 'CLEAR' as const,
  };
}

describe('TeamAuthorizationPolicy', () => {
  const policy = new TeamAuthorizationPolicy();

  it.each([
    ['team.create', 'TEAM_LEADER'],
    ['team.update', 'TEAM_LEADER'],
    ['team.archive', 'TEAM_LEADER'],
    ['team.restore', 'TEAM_LEADER'],
  ])(
    'allows %s for a current Project TEAM_LEADER with the approved permission',
    (permission, role) => {
      const input = baseline(permission as TeamActionPermission);
      input.assignments[0].roleCode = role;
      input.assignments[0].resolvedRoleCode = role;
      input.assignments[0].permissions = ['team:children.manage'];
      expect(policy.evaluate(input)).toEqual({
        allowed: true,
        access: 'MANAGER',
      });
    },
  );

  it('allows manager reads only with both team.read and delegation permission', () => {
    const input = baseline('team.read');
    expect(policy.evaluate(input)).toEqual({
      allowed: true,
      access: 'MANAGER',
    });
    input.assignments[0].permissions = ['team.read'];
    expect(policy.evaluate(input).allowed).toBe(false);
    input.assignments[0].permissions = ['team:children.manage'];
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
});
