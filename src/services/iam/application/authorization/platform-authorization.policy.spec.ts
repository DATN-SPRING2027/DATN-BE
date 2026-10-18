import {
  AuthorizationPolicy,
  PLATFORM_PERMISSIONS,
  PLATFORM_V1_PERMISSIONS,
  PLATFORM_V2_PERMISSIONS,
} from './authorization.policy';

const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const now = new Date('2026-10-05T12:00:00.000Z');

const assignment = (permission: string, overrides = {}) => ({
  subjectUserId: userId,
  grantedAt: new Date('2026-10-05T11:00:00.000Z'),
  grantedBy: 'ffffffffffffffffffffffff',
  permission,
  scope: 'PLATFORM',
  status: 'ACTIVE',
  expiresAt: null,
  revokedAt: null,
  ...overrides,
});

describe('AuthorizationPolicy platform permissions', () => {
  const policy = new AuthorizationPolicy();

  it('preserves the exact seven PLATFORM_OPERATOR V1 permissions', () => {
    expect(PLATFORM_V1_PERMISSIONS).toEqual([
      'organization.create',
      'platform.health.read',
      'platform.audit.read',
      'platform.organizations.organization.read',
      'platform.users.account.read',
      'platform.memberships.membership.read',
      'platform.memberships.lifecycle.manage',
    ]);
  });

  it('adds a separately versioned, explicit Platform Operations permission set', () => {
    expect(PLATFORM_V2_PERMISSIONS).toEqual([
      ...PLATFORM_V1_PERMISSIONS,
      'platform.users.account.manage',
      'platform.sessions.session.read',
      'platform.sessions.session.manage',
      'platform.organizations.organization.manage',
      'platform.memberships.invitation.manage',
      'platform.memberships.role.manage',
      'platform.projects.project.read',
      'platform.projects.project.manage',
      'platform.dashboard.summary.read',
      'platform.services.service.read',
      'platform.jobs.job.read',
      'platform.jobs.job.manage',
      'platform.ai.operations.read',
      'platform.integrations.integration.read',
      'platform.integrations.integration.manage',
      'platform.incidents.incident.read',
      'platform.incidents.incident.manage',
      'platform.diagnostics.trace.read',
    ]);
    expect(PLATFORM_PERMISSIONS).toEqual(PLATFORM_V2_PERMISSIONS);
  });

  it.each(PLATFORM_PERMISSIONS)(
    'allows exactly one active PLATFORM assignment for %s',
    (permission) => {
      expect(
        policy.evaluatePlatformPermission({
          permission,
          subject: { userId, status: 'ACTIVE' },
          assignments: [assignment(permission)],
          now,
        }),
      ).toEqual({ allowed: true });
    },
  );

  it.each([
    ['no assignment', []],
    [
      'wrong scope',
      [assignment('platform.health.read', { scope: 'ORGANIZATION' })],
    ],
    [
      'revoked lifecycle',
      [assignment('platform.health.read', { status: 'REVOKED' })],
    ],
    [
      'revocation timestamp',
      [assignment('platform.health.read', { revokedAt: now })],
    ],
    [
      'expired assignment',
      [
        assignment('platform.health.read', {
          expiresAt: new Date(now.getTime() - 1),
        }),
      ],
    ],
    [
      'ambiguous duplicate active assignment',
      [assignment('platform.health.read'), assignment('platform.health.read')],
    ],
    [
      'assignment for another user',
      [
        assignment('platform.health.read', {
          subjectUserId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        }),
      ],
    ],
    [
      'self-granted assignment',
      [assignment('platform.health.read', { grantedBy: userId })],
    ],
    [
      'future grant time',
      [
        assignment('platform.health.read', {
          grantedAt: new Date(now.getTime() + 1),
        }),
      ],
    ],
    [
      'missing or malformed grant time',
      [assignment('platform.health.read', { grantedAt: new Date('invalid') })],
    ],
  ])('denies %s', (_reason, assignments) => {
    expect(
      policy.evaluatePlatformPermission({
        permission: 'platform.health.read',
        subject: { userId, status: 'ACTIVE' },
        assignments,
        now,
      }).allowed,
    ).toBe(false);
  });

  it.each([
    ['inactive subject', { userId, status: 'SUSPENDED' }],
    ['missing subject', null],
    ['malformed subject', { userId: 'not-an-id', status: 'ACTIVE' }],
  ])('denies %s', (_reason, subject) => {
    expect(
      policy.evaluatePlatformPermission({
        permission: 'platform.health.read',
        subject,
        assignments: [assignment('platform.health.read')],
        now,
      }).allowed,
    ).toBe(false);
  });

  it('denies permissions outside the exact A-04 set', () => {
    expect(
      policy.evaluatePlatformPermission({
        permission: 'platform.configuration.read',
        subject: { userId, status: 'ACTIVE' },
        assignments: [assignment('platform.configuration.read')],
        now,
      }),
    ).toEqual({ allowed: false, reason: 'NO_DOCUMENTED_PERMISSION' });
  });
});
