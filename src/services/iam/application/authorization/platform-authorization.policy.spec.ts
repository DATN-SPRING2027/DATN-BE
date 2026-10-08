import {
  AuthorizationPolicy,
  PLATFORM_PERMISSIONS,
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
