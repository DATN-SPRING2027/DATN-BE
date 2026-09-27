import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AccessTokenError } from './access-token.service';
import type {
  AuthenticationAccount,
  AuthenticationRepositoryPort,
} from './authentication.repository';
import {
  AuthenticationApplicationService,
  extractAccessToken,
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
  let service: AuthenticationApplicationService;

  beforeEach(() => {
    repository = {
      findAccountByEmail: jest.fn().mockResolvedValue(account),
      findOrganizationRoleAssignments: jest.fn(),
      findProfileById: jest
        .fn()
        .mockResolvedValue({ name: 'Test Person', status: 'ACTIVE' }),
      revokeRefreshSessionByHash: jest.fn().mockResolvedValue(true),
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
    service = new AuthenticationApplicationService(
      repository,
      eligibilityPolicy,
      organizationResolver,
      credentials,
      accessTokens as never,
    );
  });

  it('authenticates an ACTIVE user and signs only the selected organization context', async () => {
    await expect(
      service.login({ email: account.email, password: 'correct-password' }),
    ).resolves.toEqual({
      accessToken: 'signed-access-token',
      user: {
        id: USER_ID,
        email: account.email,
        name: account.name,
        organizationId: ORG_ID,
        roles: ['ADMIN', 'MEMBER'],
      },
    });
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
    });

    await expect(
      service.login({ email: account.email, password: 'correct-password' }),
    ).rejects.toBeInstanceOf(ConflictException);
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

  it('rejects a still-valid token after the user is suspended', async () => {
    repository.findProfileById.mockResolvedValue({
      name: 'Test Person',
      status: 'SUSPENDED',
    });
    await expect(
      service.getCurrentIdentity('Bearer any.valid-token', undefined),
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
    await service.logout('continuum_refresh=refresh-secret');
    expect(repository.revokeRefreshSessionByHash.mock.calls).toContainEqual([
      createHash('sha256').update('refresh-secret').digest('hex'),
    ]);

    repository.revokeRefreshSessionByHash.mockResolvedValue(false);
    await expect(
      service.logout('continuum_refresh=refresh-secret'),
    ).resolves.toBeUndefined();
    const callsAfterToken =
      repository.revokeRefreshSessionByHash.mock.calls.length;
    await expect(service.logout(undefined)).resolves.toBeUndefined();
    expect(repository.revokeRefreshSessionByHash.mock.calls).toHaveLength(
      callsAfterToken,
    );
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
});
