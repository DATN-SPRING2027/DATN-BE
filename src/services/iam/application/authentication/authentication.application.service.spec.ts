import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AccessTokenError } from './access-token.service';
import type {
  AuthenticationAccount,
  AuthenticationRepositoryPort,
} from './authentication.repository';
import {
  AuthenticationApplicationService,
  extractAccessToken,
  RefreshCsrfError,
} from './authentication.application.service';
import type {
  LoginEligibilityDecision,
  LoginEligibilityInput,
  LoginEligibilityPolicy,
} from './login-eligibility.policy';
import type { OrganizationContextResolver } from './organization-context.resolver';
import { PasswordCredentialService } from '../credentials/password-credential.service';
import { PasswordHashFormatError } from '../credentials/password-credential.service';
import { LeaderDirectedLoginEligibilityPolicy } from './leader-directed-login-eligibility.policy';

const USER_ID = '651a2b3c4d5e6f7a8b9c0d1e';
const ORG_ID = '651a2b3c4d5e6f7a8b9c0d1f';
const OTHER_ORG_ID = '651a2b3c4d5e6f7a8b9c0d20';

const account: AuthenticationAccount = {
  userId: USER_ID,
  email: 'person@example.com',
  name: 'Test Person',
  passwordHash: '$argon2id$fixture-hash',
  status: 'ACTIVE',
  twoFactorEnabled: false,
};

describe('AuthenticationApplicationService', () => {
  let repository: jest.Mocked<AuthenticationRepositoryPort>;
  let eligibilityPolicy: jest.Mocked<LoginEligibilityPolicy>;
  let organizationResolver: jest.Mocked<OrganizationContextResolver>;
  let credentials: jest.Mocked<PasswordCredentialService>;
  let accessTokens: {
    signAccessToken: jest.Mock;
    verifyAccessToken: jest.Mock;
  };
  let securityStore: {
    consumeRateLimit: jest.Mock;
    clearRateLimit: jest.Mock;
    isTokenRevoked: jest.Mock;
    revokeToken: jest.Mock;
  };
  let service: AuthenticationApplicationService;

  beforeEach(() => {
    repository = {
      findAccountByEmail: jest.fn().mockResolvedValue(account),
      findActiveOrganizationMembershipIds: jest
        .fn()
        .mockResolvedValue([ORG_ID]),
      findOrganizationRoleAssignments: jest.fn(),
      findOrganizationOptions: jest.fn(),
      findProfileById: jest
        .fn()
        .mockResolvedValue({ name: 'Test Person', status: 'ACTIVE' }),
      replacePasswordHashIfCurrent: jest.fn().mockResolvedValue(undefined),
      revokeRefreshSessionByHash: jest.fn().mockResolvedValue(true),
      findRefreshSessionForRotation: jest.fn().mockResolvedValue({
        outcome: 'ACTIVE',
        userId: USER_ID,
        organizationId: ORG_ID,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }),
      rotateRefreshSession: jest.fn(),
      findAccountById: jest.fn().mockResolvedValue(account),
      createRefreshSession: jest.fn().mockResolvedValue(undefined),
    };
    eligibilityPolicy = {
      evaluate: jest.fn(
        (input: LoginEligibilityInput): LoginEligibilityDecision =>
          new LeaderDirectedLoginEligibilityPolicy().evaluate(input),
      ),
    };
    organizationResolver = {
      resolveForUser: jest.fn().mockResolvedValue({
        outcome: 'RESOLVED',
        context: { orgId: ORG_ID, roles: ['ADMIN', 'MEMBER'] },
      }),
    };
    credentials = {
      hashPassword: jest.fn(),
      verifyPassword: jest.fn().mockResolvedValue({
        verified: true,
        needsRehash: false,
      }),
    } as unknown as jest.Mocked<PasswordCredentialService>;
    accessTokens = {
      signAccessToken: jest.fn().mockReturnValue('signed-access-token'),
      verifyAccessToken: jest.fn().mockReturnValue({
        sub: USER_ID,
        email: account.email,
        orgId: ORG_ID,
        roles: ['ADMIN'],
        iat: 100,
        exp: 1000,
        jti: 'd9428888-122b-4f20-8f3b-6f96e5be2a5a',
      }),
    };
    securityStore = {
      consumeRateLimit: jest.fn().mockResolvedValue(true),
      clearRateLimit: jest.fn().mockResolvedValue(undefined),
      isTokenRevoked: jest.fn().mockResolvedValue(false),
      revokeToken: jest.fn().mockResolvedValue(undefined),
    };
    service = new AuthenticationApplicationService(
      repository,
      eligibilityPolicy,
      organizationResolver,
      credentials,
      accessTokens as never,
      securityStore,
    );
  });

  it('authenticates an ACTIVE user and signs only the selected organization context', async () => {
    const result = await service.login({
      email: account.email,
      password: 'correct-password',
    });
    expect(result).toMatchObject({
      accessToken: 'signed-access-token',
      user: {
        id: USER_ID,
        email: account.email,
        name: account.name,
        organizationId: ORG_ID,
        roles: ['ADMIN', 'MEMBER'],
      },
    });
    expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.csrfToken).not.toBe(result.refreshToken);
    expect(repository.createRefreshSession.mock.calls).toContainEqual([
      USER_ID,
      ORG_ID,
      createHash('sha256').update(result.refreshToken).digest('hex'),
      expect.any(Date),
    ]);
    const issuedExpiry = repository.createRefreshSession.mock.calls[0][3];
    expect(issuedExpiry.getTime() - Date.now()).toBeGreaterThan(604799000);
    expect(issuedExpiry.getTime() - Date.now()).toBeLessThanOrEqual(604800000);
    expect(organizationResolver.resolveForUser.mock.calls).toContainEqual([
      USER_ID,
      undefined,
    ]);
    expect(accessTokens.signAccessToken).toHaveBeenCalledWith({
      sub: USER_ID,
      email: account.email,
      orgId: ORG_ID,
      roles: ['ADMIN', 'MEMBER'],
    });
    expect(securityStore.clearRateLimit).toHaveBeenCalledWith(
      expect.stringMatching(/^auth:login:account:[a-f0-9]{64}$/),
    );
  });

  it('issues no Login credentials when initial refresh-session persistence fails', async () => {
    repository.createRefreshSession.mockRejectedValue(
      new Error('persistence failed'),
    );
    await expect(
      service.login({ email: account.email, password: 'correct-password' }),
    ).rejects.toThrow('persistence failed');
    expect(accessTokens.signAccessToken).not.toHaveBeenCalled();
  });

  it('upgrades a verified legacy hash after resolving an eligible login', async () => {
    credentials.verifyPassword.mockResolvedValue({
      verified: true,
      needsRehash: true,
    });
    credentials.hashPassword.mockResolvedValue('$2b$12$replacement');

    await service.login({ email: account.email, password: 'correct-password' });

    expect(credentials.hashPassword.mock.calls).toContainEqual([
      'correct-password',
    ]);
    expect(repository.replacePasswordHashIfCurrent.mock.calls).toContainEqual([
      account.userId,
      account.passwordHash,
      '$2b$12$replacement',
    ]);
  });

  it('passes an explicit organization selector to the server-side resolver', async () => {
    organizationResolver.resolveForUser.mockResolvedValue({
      outcome: 'RESOLVED',
      context: { orgId: OTHER_ORG_ID, roles: ['MEMBER'] },
    });

    await service.login({
      email: account.email,
      password: 'correct-password',
      organizationId: OTHER_ORG_ID,
    });

    expect(organizationResolver.resolveForUser.mock.calls).toContainEqual([
      USER_ID,
      OTHER_ORG_ID,
    ]);
  });

  it.each([
    [
      'unknown user',
      () => repository.findAccountByEmail.mockResolvedValue(null),
    ],
    [
      'wrong password',
      () =>
        credentials.verifyPassword.mockResolvedValue({
          verified: false,
          needsRehash: false,
        }),
    ],
    [
      'malformed password hash',
      () =>
        credentials.verifyPassword.mockRejectedValue(
          new PasswordHashFormatError('MALFORMED'),
        ),
    ],
    [
      'suspended user',
      () =>
        repository.findAccountByEmail.mockResolvedValue({
          ...account,
          status: 'SUSPENDED',
        }),
    ],
    [
      'pending invite user',
      () =>
        repository.findAccountByEmail.mockResolvedValue({
          ...account,
          status: 'PENDING_INVITE',
        }),
    ],
    [
      'invalid organization selector',
      () =>
        organizationResolver.resolveForUser.mockResolvedValue({
          outcome: 'INVALID_ORGANIZATION_SELECTION',
        }),
    ],
    [
      'zero eligible organizations',
      () =>
        organizationResolver.resolveForUser.mockResolvedValue({
          outcome: 'NO_ELIGIBLE_ORGANIZATION',
        }),
    ],
  ])('returns the same generic failure for %s', async (_case, arrange) => {
    arrange();
    let thrown: unknown;
    try {
      await service.login({
        email: account.email,
        password: 'supplied-secret',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnauthorizedException);
    const body = (thrown as UnauthorizedException).getResponse();
    expect(body).toEqual({
      code: 'AUTHENTICATION_FAILED',
      message: 'Authentication failed.',
    });
    expect(JSON.stringify(body)).not.toContain('supplied-secret');
    expect(JSON.stringify(body)).not.toContain(account.passwordHash);
  });

  it('does not use password-only login for an account whose MFA flag is enabled', async () => {
    repository.findAccountByEmail.mockResolvedValue({
      ...account,
      twoFactorEnabled: true,
    });

    await expect(
      service.login({ email: account.email, password: 'correct-password' }),
    ).rejects.toMatchObject({
      response: {
        code: 'AUTHENTICATION_FAILED',
        message: 'Authentication failed.',
      },
    });
  });

  it('returns 409 for multiple organizations without a selector', async () => {
    organizationResolver.resolveForUser.mockResolvedValue({
      outcome: 'ORGANIZATION_SELECTION_REQUIRED',
      organizations: [{ id: ORG_ID, name: 'Alpha' }],
    });

    await expect(
      service.login({ email: account.email, password: 'correct-password' }),
    ).rejects.toMatchObject({
      response: {
        code: 'ORGANIZATION_SELECTION_REQUIRED',
        details: { organizations: [{ id: ORG_ID, name: 'Alpha' }] },
      },
    });
  });

  it('limits requests from a source before expensive password verification', async () => {
    securityStore.consumeRateLimit.mockResolvedValue(false);
    await expect(
      service.login({
        email: 'Person@Example.com',
        password: 'wrong',
        sourceIp: '198.51.100.8',
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(repository.findAccountByEmail.mock.calls).toHaveLength(0);
    expect(credentials.verifyPassword.mock.calls).toHaveLength(0);
    expect(securityStore.clearRateLimit.mock.calls).toHaveLength(0);
    expect(securityStore.consumeRateLimit).toHaveBeenCalledWith(
      expect.stringMatching(/^auth:login:source:[a-f0-9]{64}$/),
      300,
      900,
    );
  });

  it('returns 429 for excess wrong guesses but permits the correct password', async () => {
    credentials.verifyPassword.mockResolvedValueOnce({
      verified: false,
      needsRehash: false,
    });
    securityStore.consumeRateLimit
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(
      service.login({
        email: account.email,
        password: 'wrong',
        sourceIp: '198.51.100.8',
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(securityStore.consumeRateLimit).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^auth:login:account:[a-f0-9]{64}$/),
      5,
      900,
    );
    await expect(
      service.login({
        email: account.email,
        password: 'correct',
        sourceIp: '203.0.113.9',
      }),
    ).resolves.toHaveProperty('accessToken');
    expect(securityStore.clearRateLimit).toHaveBeenCalledWith(
      expect.stringMatching(/^auth:login:account:[a-f0-9]{64}$/),
    );
  });

  it('returns the verified token identity at /me, including organization and roles', async () => {
    await expect(
      service.getCurrentIdentity('Bearer any.valid-token', undefined),
    ).resolves.toEqual({
      id: USER_ID,
      email: account.email,
      name: 'Test Person',
      organizationId: ORG_ID,
      roles: ['ADMIN'],
    });
    expect(repository.findProfileById.mock.calls).toContainEqual([USER_ID]);
  });

  it('authenticates a Human User for platform APIs without requiring Organization membership', async () => {
    repository.findActiveOrganizationMembershipIds.mockResolvedValue([]);

    await expect(
      service.getCurrentPlatformSubject('Bearer any.valid-token', undefined),
    ).resolves.toEqual({
      id: USER_ID,
      email: account.email,
      name: 'Test Person',
    });
    expect(
      repository.findActiveOrganizationMembershipIds.mock.calls,
    ).toHaveLength(0);
  });

  it('rejects a still-valid token after the user is suspended', async () => {
    repository.findProfileById.mockResolvedValue({
      name: 'Test Person',
      status: 'SUSPENDED',
    });
    await expect(
      service.getCurrentIdentity('Bearer any.valid-token', undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a still-valid token after organization membership is suspended or removed', async () => {
    repository.findActiveOrganizationMembershipIds.mockResolvedValue([]);
    await expect(
      service.getCurrentIdentity('Bearer any.valid-token', undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a revoked access token when replayed after logout', async () => {
    const claims = accessTokens.verifyAccessToken() as { exp: number };
    accessTokens.verifyAccessToken.mockReturnValue({
      ...claims,
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    await service.logout(undefined, 'continuum_access=signed-access-token');
    expect(securityStore.revokeToken).toHaveBeenCalledWith(
      createHash('sha256').update('signed-access-token').digest('hex'),
      expect.any(Number),
    );
    securityStore.isTokenRevoked.mockResolvedValue(true);
    await expect(
      service.getCurrentIdentity(
        undefined,
        'continuum_access=signed-access-token',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    ['missing authentication', undefined, undefined],
    ['invalid token', 'Bearer invalid-token', undefined],
  ])('returns 401 for %s', async (_case, authorization, cookie) => {
    if (authorization) {
      accessTokens.verifyAccessToken.mockImplementation(() => {
        throw new AccessTokenError('MALFORMED');
      });
    }
    await expect(
      service.getCurrentIdentity(authorization, cookie),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns 401 for an expired token', async () => {
    accessTokens.verifyAccessToken.mockImplementation(() => {
      throw new AccessTokenError('EXPIRED');
    });
    await expect(
      service.getCurrentIdentity('Bearer expired-token', undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('revokes a presented refresh session by SHA-256 hash and is idempotent when absent', async () => {
    const refreshToken = 'A'.repeat(43);
    await service.logout(undefined, `__Secure-refresh=${refreshToken}`);
    expect(repository.revokeRefreshSessionByHash.mock.calls).toContainEqual([
      createHash('sha256').update(refreshToken).digest('hex'),
    ]);

    repository.revokeRefreshSessionByHash.mockResolvedValue(false);
    await expect(
      service.logout(undefined, `continuum_refresh=${refreshToken}`),
    ).resolves.toBeUndefined();
    const callsAfterToken =
      repository.revokeRefreshSessionByHash.mock.calls.length;
    await expect(service.logout(undefined, undefined)).resolves.toBeUndefined();
    expect(repository.revokeRefreshSessionByHash.mock.calls).toHaveLength(
      callsAfterToken,
    );
  });

  it('rejects refresh after logout revokes the rotated credential', async () => {
    const initialToken = 'A'.repeat(43);
    repository.rotateRefreshSession.mockResolvedValueOnce({
      outcome: 'ROTATED',
      userId: USER_ID,
      organizationId: ORG_ID,
    });
    const refreshed = await service.refresh(
      initialToken,
      'csrf-value',
      'csrf-value',
    );

    await service.logout(
      undefined,
      `__Secure-refresh=${refreshed.refreshToken}`,
    );
    expect(repository.revokeRefreshSessionByHash.mock.calls).toContainEqual([
      createHash('sha256').update(refreshed.refreshToken).digest('hex'),
    ]);

    repository.findRefreshSessionForRotation.mockResolvedValueOnce({
      outcome: 'REVOKED',
      userId: USER_ID,
      organizationId: ORG_ID,
      expiresAt: new Date(Date.now() + 60_000),
    });
    repository.rotateRefreshSession.mockResolvedValueOnce({
      outcome: 'REPLAYED',
    });
    await expect(
      service.refresh(refreshed.refreshToken, 'csrf-value', 'csrf-value'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('extracts Bearer and HttpOnly cookie access tokens but rejects ambiguous or malformed inputs', () => {
    expect(extractAccessToken('Bearer jwt.token-value', undefined)).toBe(
      'jwt.token-value',
    );
    expect(
      extractAccessToken(undefined, 'other=x; continuum_access=jwt.token'),
    ).toBe('jwt.token');
    expect(
      extractAccessToken('Basic token', 'continuum_access=valid.token'),
    ).toBe(undefined);
    expect(
      extractAccessToken(
        undefined,
        'continuum_access=first.token; continuum_access=second.token',
      ),
    ).toBeUndefined();
  });

  describe('refresh rotation core', () => {
    const presented = 'A'.repeat(43);

    it('passes only hashes to persistence and issues credentials after rotation', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();
      repository.rotateRefreshSession.mockResolvedValue({
        outcome: 'ROTATED',
        userId: USER_ID,
        organizationId: ORG_ID,
      });
      const result = await service.refresh(
        presented,
        'csrf-value',
        'csrf-value',
      );
      expect(result.accessToken).toBe('signed-access-token');
      expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.refreshToken).not.toBe(presented);
      expect(repository.rotateRefreshSession.mock.calls).toContainEqual([
        createHash('sha256').update(presented).digest('hex'),
        createHash('sha256').update(result.refreshToken).digest('hex'),
        expect.any(Date),
        expect.any(Date),
      ]);
      const [, , expiresAt, now] =
        repository.rotateRefreshSession.mock.calls[0];
      expect(expiresAt.getTime() - now.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
      expect(organizationResolver.resolveForUser.mock.calls).toContainEqual([
        USER_ID,
        ORG_ID,
      ]);
      expect(
        repository.findRefreshSessionForRotation.mock.invocationCallOrder[0],
      ).toBeLessThan(repository.findAccountById.mock.invocationCallOrder[0]);
      expect(
        repository.findAccountById.mock.invocationCallOrder[0],
      ).toBeLessThan(
        organizationResolver.resolveForUser.mock.invocationCallOrder[0],
      );
      expect(
        organizationResolver.resolveForUser.mock.invocationCallOrder[0],
      ).toBeLessThan(accessTokens.signAccessToken.mock.invocationCallOrder[0]);
      expect(
        accessTokens.signAccessToken.mock.invocationCallOrder[0],
      ).toBeLessThan(
        repository.rotateRefreshSession.mock.invocationCallOrder[0],
      );
      expect(accessTokens.signAccessToken).toHaveBeenCalledWith({
        sub: USER_ID,
        email: account.email,
        orgId: ORG_ID,
        roles: ['ADMIN', 'MEMBER'],
      });
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it.each([
      undefined,
      '',
      'bad',
      'A'.repeat(44),
      'A'.repeat(42) + '!',
      'A'.repeat(42) + 'B',
    ])(
      'rejects missing or malformed credential %p before session lookup',
      async (token) => {
        await expect(
          service.refresh(token, 'csrf', 'csrf'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(repository.rotateRefreshSession.mock.calls).toHaveLength(0);
        expect(
          repository.findRefreshSessionForRotation.mock.calls,
        ).toHaveLength(0);
      },
    );

    it('rejects an unknown credential without attempting rotation', async () => {
      repository.findRefreshSessionForRotation.mockResolvedValue({
        outcome: 'INVALID',
      });
      await expect(
        service.refresh(presented, 'csrf', 'csrf'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(repository.rotateRefreshSession.mock.calls).toHaveLength(0);
    });

    it('preserves user-wide invalidation when a revoked credential is replayed', async () => {
      repository.findRefreshSessionForRotation.mockResolvedValue({
        outcome: 'REVOKED',
        userId: USER_ID,
        organizationId: ORG_ID,
        expiresAt: new Date(Date.now() + 60_000),
      });
      repository.rotateRefreshSession.mockResolvedValue({
        outcome: 'REPLAYED',
      });
      await expect(
        service.refresh(presented, 'csrf', 'csrf'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(repository.findAccountById.mock.calls).toHaveLength(0);
      expect(repository.rotateRefreshSession.mock.calls).toHaveLength(1);
      expect(accessTokens.signAccessToken).not.toHaveBeenCalled();
    });

    it('rejects an expired lookup before checking eligibility or rotating', async () => {
      repository.findRefreshSessionForRotation.mockResolvedValue({
        outcome: 'ACTIVE',
        userId: USER_ID,
        organizationId: ORG_ID,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(
        service.refresh(presented, 'csrf', 'csrf'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(repository.findAccountById.mock.calls).toHaveLength(0);
      expect(repository.rotateRefreshSession.mock.calls).toHaveLength(0);
    });

    it.each(['INVALID', 'REPLAYED'] as const)(
      'returns no credentials for %s rotation outcome',
      async (outcome) => {
        repository.rotateRefreshSession.mockResolvedValue({ outcome });
        await expect(
          service.refresh(presented, 'csrf', 'csrf'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(accessTokens.signAccessToken).toHaveBeenCalledTimes(1);
      },
    );

    it('returns no credentials when persistence fails after access token preparation', async () => {
      repository.rotateRefreshSession.mockRejectedValue(
        new Error('transaction failed'),
      );
      await expect(service.refresh(presented, 'csrf', 'csrf')).rejects.toThrow(
        'transaction failed',
      );
      expect(accessTokens.signAccessToken).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['missing', undefined, 'csrf'],
      ['mismatch', 'csrf', 'other'],
    ])(
      'rejects %s CSRF before token-state access',
      async (_case, cookie, header) => {
        await expect(
          service.refresh(presented, cookie, header),
        ).rejects.toBeInstanceOf(RefreshCsrfError);
        expect(repository.rotateRefreshSession.mock.calls).toHaveLength(0);
      },
    );

    it('preserves the current token when the account is no longer eligible', async () => {
      repository.findAccountById.mockResolvedValue({
        ...account,
        status: 'SUSPENDED',
      });
      await expect(
        service.refresh(presented, 'csrf', 'csrf'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(repository.rotateRefreshSession.mock.calls).toHaveLength(0);
      expect(accessTokens.signAccessToken).not.toHaveBeenCalled();
    });

    it('preserves the current token when organization eligibility lookup fails', async () => {
      organizationResolver.resolveForUser.mockResolvedValue({
        outcome: 'NO_ELIGIBLE_ORGANIZATION',
      });
      await expect(
        service.refresh(presented, 'csrf', 'csrf'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(repository.rotateRefreshSession.mock.calls).toHaveLength(0);
      expect(accessTokens.signAccessToken).not.toHaveBeenCalled();
    });

    it('preserves the current token when access-token signing fails', async () => {
      accessTokens.signAccessToken.mockImplementation(() => {
        throw new Error('signing key unavailable');
      });
      await expect(service.refresh(presented, 'csrf', 'csrf')).rejects.toThrow(
        'signing key unavailable',
      );
      expect(repository.rotateRefreshSession.mock.calls).toHaveLength(0);
    });
  });
});
