import { Logger, UnauthorizedException } from '@nestjs/common';
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
import { AuthorizationPolicy } from '../authorization/authorization.policy';
import type { AuthorizationEvidenceProvider } from '../authorization/authorization-evidence.provider';

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
  let authorizationEvidence: {
    loadPlatformPermission: jest.Mock;
  };
  let authorizationPolicy: AuthorizationPolicy;
  let service: AuthenticationApplicationService;

  beforeEach(() => {
    repository = {
      findAccountByEmail: jest.fn().mockResolvedValue(account),
      findAccountByGoogleSubject: jest.fn().mockResolvedValue(null),
      linkGoogleSubjectIfMissing: jest.fn().mockResolvedValue(true),
      createGoogleAccount: jest.fn(),
      findActiveOrganizationMembershipIds: jest
        .fn()
        .mockResolvedValue([ORG_ID]),
      findOrganizationRoleAssignments: jest.fn(),
      findOrganizationOptions: jest.fn(),
      findProfileById: jest
        .fn()
        .mockResolvedValue({ name: 'Test Person', status: 'ACTIVE' }),
      replacePasswordHashIfCurrent: jest.fn().mockResolvedValue(undefined),
      resetPassword: jest.fn().mockResolvedValue(true),
      revokeRefreshSessionByHash: jest.fn().mockResolvedValue(true),
      findRefreshSessionForRotation: jest.fn().mockResolvedValue({
        outcome: 'ACTIVE',
        userId: USER_ID,
        context: 'ORGANIZATION',
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
    authorizationEvidence = {
      loadPlatformPermission: jest.fn().mockResolvedValue({ assignments: [] }),
    };
    authorizationPolicy = new AuthorizationPolicy();
    service = new AuthenticationApplicationService(
      repository,
      eligibilityPolicy,
      organizationResolver,
      credentials,
      accessTokens as never,
      securityStore,
      authorizationEvidence as unknown as AuthorizationEvidenceProvider,
      authorizationPolicy,
    );
  });

  it('issues an ACCOUNT session when one Organization is available so the user can select it', async () => {
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
        context: 'ACCOUNT',
      },
    });
    expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.csrfToken).not.toBe(result.refreshToken);
    expect(repository.createRefreshSession.mock.calls[0][0]).toMatchObject({
      userId: USER_ID,
      context: 'ACCOUNT',
      tokenHash: createHash('sha256').update(result.refreshToken).digest('hex'),
    });
    const issuedExpiry =
      repository.createRefreshSession.mock.calls[0][0].expiresAt;
    expect(issuedExpiry).toBeInstanceOf(Date);
    expect(issuedExpiry.getTime() - Date.now()).toBeGreaterThan(604799000);
    expect(issuedExpiry.getTime() - Date.now()).toBeLessThanOrEqual(604800000);
    expect(organizationResolver.resolveForUser).not.toHaveBeenCalled();
    expect(accessTokens.signAccessToken).toHaveBeenCalledWith({
      sub: USER_ID,
      email: account.email,
      context: 'ACCOUNT',
    });
    expect(securityStore.clearRateLimit).toHaveBeenCalledWith(
      expect.stringMatching(/^auth:login:account:[a-f0-9]{64}$/),
    );
  });

  describe('Google login', () => {
    const googleIdentity = {
      subject: 'google-subject-123',
      email: 'person@example.com',
      emailVerified: true,
      name: 'Google Person',
    };

    it('logs a Mongoose validation failure at user persistence without logging error details', async () => {
      const validationError = Object.assign(
        new Error('Mongoose validation failed'),
        { name: 'ValidationError' },
      );
      repository.findAccountByGoogleSubject.mockResolvedValue(null);
      repository.findAccountByEmail.mockResolvedValue(null);
      repository.createGoogleAccount.mockRejectedValue(validationError);
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      await expect(service.loginWithGoogle(googleIdentity)).rejects.toBe(
        validationError,
      );

      const event = warn.mock.calls
        .map(
          ([message]) => JSON.parse(String(message)) as Record<string, unknown>,
        )
        .find((entry) => entry.stage === 'user_persistence');
      expect(event).toMatchObject({
        event: 'google_oauth.callback',
        stage: 'user_persistence',
        status: 'failed',
        errorCode: 'MONGOOSE_VALIDATION_ERROR',
      });
      expect(event?.requestId).toEqual(
        expect.stringMatching(/^[0-9a-f-]{36}$/i),
      );
      expect(JSON.stringify(event)).not.toContain('passwordHash');
      warn.mockRestore();
    });

    it('links a verified Google identity and defers Organization selection', async () => {
      repository.findAccountByGoogleSubject.mockResolvedValue(null);
      repository.findAccountByEmail.mockResolvedValue(account);
      repository.linkGoogleSubjectIfMissing.mockResolvedValue(true);

      const result = await service.loginWithGoogle(googleIdentity);

      expect(repository.linkGoogleSubjectIfMissing.mock.calls).toContainEqual([
        USER_ID,
        googleIdentity.subject,
      ]);
      expect(result.user).toEqual({
        id: USER_ID,
        email: account.email,
        name: account.name,
        context: 'ACCOUNT',
      });
      expect(repository.createRefreshSession.mock.calls).toHaveLength(1);
      expect(organizationResolver.resolveForUser).not.toHaveBeenCalled();
      expect(repository.createRefreshSession.mock.calls[0]?.[0]).toMatchObject({
        context: 'ACCOUNT',
      });
    });

    it('creates a passwordless user for a new verified Google identity without granting an Organization', async () => {
      const googleAccount = {
        ...account,
        userId: '651a2b3c4d5e6f7a8b9c0d21',
        email: googleIdentity.email,
        name: googleIdentity.name,
        passwordHash: '',
        googleSubject: googleIdentity.subject,
      };
      repository.findAccountByGoogleSubject.mockResolvedValue(null);
      repository.findAccountByEmail.mockResolvedValue(null);
      repository.createGoogleAccount.mockResolvedValue(googleAccount);
      organizationResolver.resolveForUser.mockResolvedValue({
        outcome: 'NO_ELIGIBLE_ORGANIZATION',
      });

      const result = await service.loginWithGoogle(googleIdentity);
      expect(result.user).toEqual({
        id: googleAccount.userId,
        email: googleAccount.email,
        name: googleAccount.name,
        context: 'ACCOUNT',
      });

      expect(repository.createGoogleAccount.mock.calls).toContainEqual([
        {
          email: googleIdentity.email,
          name: googleIdentity.name,
          googleSubject: googleIdentity.subject,
        },
      ]);
      expect(repository.createRefreshSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: googleAccount.userId,
          context: 'ACCOUNT',
        }),
      );
      expect(accessTokens.signAccessToken).toHaveBeenCalledWith({
        sub: googleAccount.userId,
        email: googleAccount.email,
        context: 'ACCOUNT',
      });
      expect(organizationResolver.resolveForUser).not.toHaveBeenCalled();
    });

    it('signs in an existing Google-only account in ACCOUNT context', async () => {
      const googleAccount = {
        ...account,
        userId: '651a2b3c4d5e6f7a8b9c0d21',
        email: googleIdentity.email,
        name: googleIdentity.name,
        passwordHash: '',
        googleSubject: googleIdentity.subject,
      };
      repository.findAccountByGoogleSubject.mockResolvedValue(googleAccount);
      organizationResolver.resolveForUser.mockResolvedValue({
        outcome: 'NO_ELIGIBLE_ORGANIZATION',
      });

      const result = await service.loginWithGoogle(googleIdentity);

      expect(result.user).toEqual({
        id: googleAccount.userId,
        email: googleAccount.email,
        name: googleAccount.name,
        context: 'ACCOUNT',
      });
      expect(repository.findAccountByGoogleSubject.mock.calls).toContainEqual([
        googleIdentity.subject,
      ]);
      expect(repository.findAccountByEmail.mock.calls).toHaveLength(0);
      expect(repository.createGoogleAccount.mock.calls).toHaveLength(0);
      expect(repository.createRefreshSession.mock.calls[0]?.[0]).toMatchObject({
        userId: googleAccount.userId,
        context: 'ACCOUNT',
      });
      expect(organizationResolver.resolveForUser).not.toHaveBeenCalled();
    });

    it('does not resolve or create an account when Google email is unverified', async () => {
      await expect(
        service.loginWithGoogle({ ...googleIdentity, emailVerified: false }),
      ).rejects.toMatchObject({ status: 401 });

      expect(repository.findAccountByGoogleSubject.mock.calls).toHaveLength(0);
      expect(repository.findAccountByEmail.mock.calls).toHaveLength(0);
      expect(repository.createGoogleAccount.mock.calls).toHaveLength(0);
      expect(repository.createRefreshSession.mock.calls).toHaveLength(0);
    });

    it('issues an ACCOUNT session when the linked account has multiple active memberships', async () => {
      repository.findAccountByGoogleSubject.mockResolvedValue({
        ...account,
        googleSubject: googleIdentity.subject,
      });
      organizationResolver.resolveForUser.mockResolvedValue({
        outcome: 'ORGANIZATION_SELECTION_REQUIRED',
        organizations: [
          { id: ORG_ID, name: 'Alpha' },
          { id: OTHER_ORG_ID, name: 'Beta' },
        ],
      });

      const result = await service.loginWithGoogle(googleIdentity);

      expect(result.user).toEqual({
        id: USER_ID,
        email: account.email,
        name: account.name,
        context: 'ACCOUNT',
      });
      expect(repository.createRefreshSession.mock.calls[0]?.[0]).toMatchObject({
        context: 'ACCOUNT',
      });
      expect(organizationResolver.resolveForUser).not.toHaveBeenCalled();
    });

    it('uses the explicitly requested active Organization when provided', async () => {
      repository.findAccountByGoogleSubject.mockResolvedValue({
        ...account,
        googleSubject: googleIdentity.subject,
      });
      organizationResolver.resolveForUser.mockResolvedValue({
        outcome: 'RESOLVED',
        context: { orgId: OTHER_ORG_ID, roles: ['MEMBER'] },
      });

      const result = await service.loginWithGoogle(
        googleIdentity,
        OTHER_ORG_ID,
      );

      expect(result.user).toMatchObject({
        organizationId: OTHER_ORG_ID,
        roles: ['MEMBER'],
      });
      expect(repository.createRefreshSession.mock.calls[0]?.[0]).toMatchObject({
        context: 'ORGANIZATION',
        organizationId: OTHER_ORG_ID,
      });
    });

    it('does not link a verified email to an account already linked to another Google subject', async () => {
      repository.findAccountByGoogleSubject.mockResolvedValue(null);
      repository.findAccountByEmail.mockResolvedValue({
        ...account,
        googleSubject: 'different-google-subject',
      });

      await expect(
        service.loginWithGoogle(googleIdentity),
      ).rejects.toMatchObject({
        status: 401,
      });
      expect(repository.linkGoogleSubjectIfMissing.mock.calls).toHaveLength(0);
      expect(repository.createRefreshSession.mock.calls).toHaveLength(0);
    });
  });

  it('issues a Platform session for an ACTIVE assigned user without Organization membership', async () => {
    repository.findActiveOrganizationMembershipIds.mockResolvedValue([]);
    authorizationEvidence.loadPlatformPermission.mockResolvedValue({
      assignments: [
        {
          subjectUserId: USER_ID,
          permission: 'organization.create',
          scope: 'PLATFORM',
          status: 'ACTIVE',
          grantedAt: new Date(Date.now() - 1000),
          grantedBy: OTHER_ORG_ID,
          expiresAt: null,
          revokedAt: null,
        },
      ],
    });

    const result = await service.loginPlatform({
      email: account.email,
      password: 'correct-password',
    });

    expect(result.user).toEqual({
      id: USER_ID,
      email: account.email,
      name: account.name,
    });
    expect(
      repository.findActiveOrganizationMembershipIds.mock.calls,
    ).toHaveLength(0);
    expect(organizationResolver.resolveForUser.mock.calls).toHaveLength(0);
    expect(repository.createRefreshSession.mock.calls[0][0]).toMatchObject({
      userId: USER_ID,
      context: 'PLATFORM',
      tokenHash: createHash('sha256').update(result.refreshToken).digest('hex'),
    });
    expect(
      repository.createRefreshSession.mock.calls[0][0].expiresAt,
    ).toBeInstanceOf(Date);
    expect(accessTokens.signAccessToken).toHaveBeenCalledWith({
      sub: USER_ID,
      email: account.email,
      context: 'PLATFORM',
    });
  });

  it('does not issue a Platform session without a current approved assignment', async () => {
    await expect(
      service.loginPlatform({
        email: account.email,
        password: 'correct-password',
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(repository.createRefreshSession.mock.calls).toHaveLength(0);
    expect(accessTokens.signAccessToken.mock.calls).toHaveLength(0);
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

  it('selects an active Organization from an ACCOUNT session after membership verification', async () => {
    accessTokens.verifyAccessToken.mockReturnValue({
      sub: USER_ID,
      email: account.email,
      context: 'ACCOUNT',
      iat: 100,
      exp: 1000,
      jti: 'd9428888-122b-4f20-8f3b-6f96e5be2a5a',
    });
    organizationResolver.resolveForUser.mockResolvedValue({
      outcome: 'RESOLVED',
      context: { orgId: ORG_ID, roles: ['MEMBER'] },
    });

    const result = await service.selectOrganization(
      'Bearer account-token',
      undefined,
      ORG_ID,
    );

    expect(organizationResolver.resolveForUser).toHaveBeenCalledWith(
      USER_ID,
      ORG_ID,
    );
    expect(result.user).toEqual({
      id: USER_ID,
      email: account.email,
      name: 'Test Person',
      organizationId: ORG_ID,
      roles: ['MEMBER'],
    });
    expect(repository.createRefreshSession.mock.calls[0]?.[0]).toMatchObject({
      context: 'ORGANIZATION',
      organizationId: ORG_ID,
    });
  });

  it('allows an active Organization session to switch only to another active membership', async () => {
    repository.findActiveOrganizationMembershipIds.mockResolvedValue([
      ORG_ID,
      OTHER_ORG_ID,
    ]);
    organizationResolver.resolveForUser.mockResolvedValue({
      outcome: 'RESOLVED',
      context: { orgId: OTHER_ORG_ID, roles: ['MEMBER'] },
    });

    const result = await service.selectOrganization(
      'Bearer current-organization-token',
      undefined,
      OTHER_ORG_ID,
    );

    expect(result.user).toEqual({
      id: USER_ID,
      email: account.email,
      name: 'Test Person',
      organizationId: OTHER_ORG_ID,
      roles: ['MEMBER'],
    });
    expect(repository.createRefreshSession.mock.calls[0]?.[0]).toMatchObject({
      context: 'ORGANIZATION',
      organizationId: OTHER_ORG_ID,
    });
  });

  it('rejects switching from an Organization session whose current membership is no longer active', async () => {
    repository.findActiveOrganizationMembershipIds.mockResolvedValue([
      OTHER_ORG_ID,
    ]);

    await expect(
      service.selectOrganization(
        'Bearer stale-organization-token',
        undefined,
        OTHER_ORG_ID,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(organizationResolver.resolveForUser).not.toHaveBeenCalled();
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
  ])('returns the same generic failure for %s', async (_case, arrange) => {
    arrange();
    let thrown: unknown;
    try {
      await service.login({
        email: account.email,
        password: 'supplied-secret',
        ...(_case === 'invalid organization selector'
          ? { organizationId: OTHER_ORG_ID }
          : {}),
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

  it('lets an eligible password user sign in without an Organization', async () => {
    organizationResolver.resolveForUser.mockResolvedValue({
      outcome: 'NO_ELIGIBLE_ORGANIZATION',
    });
    const result = await service.login({
      email: account.email,
      password: 'correct',
    });
    expect(result.user).toEqual({
      id: USER_ID,
      email: account.email,
      name: account.name,
      context: 'ACCOUNT',
    });
    expect(accessTokens.signAccessToken).toHaveBeenCalledWith({
      sub: USER_ID,
      email: account.email,
      context: 'ACCOUNT',
    });
    expect(organizationResolver.resolveForUser).not.toHaveBeenCalled();
  });

  it('does not allow a Google-only account to sign in with an empty password', async () => {
    repository.findAccountByEmail.mockResolvedValue({
      ...account,
      passwordHash: '',
      googleSubject: 'google-subject-123',
    });
    const realCredentials = new PasswordCredentialService();
    credentials.verifyPassword.mockImplementation((hash, password) =>
      realCredentials.verifyPassword(hash, password),
    );

    await expect(
      service.login({ email: account.email, password: '' }),
    ).rejects.toMatchObject({
      response: {
        code: 'AUTHENTICATION_FAILED',
        message: 'Authentication failed.',
      },
    });

    expect(credentials.verifyPassword.mock.calls).toContainEqual(['', '']);
    expect(repository.createRefreshSession.mock.calls).toHaveLength(0);
    expect(accessTokens.signAccessToken).not.toHaveBeenCalled();
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

  it('issues an ACCOUNT session for multiple organizations until the user selects one', async () => {
    organizationResolver.resolveForUser.mockResolvedValue({
      outcome: 'ORGANIZATION_SELECTION_REQUIRED',
      organizations: [{ id: ORG_ID, name: 'Alpha' }],
    });

    const result = await service.login({
      email: account.email,
      password: 'correct-password',
    });

    expect(result.user).toEqual({
      id: USER_ID,
      email: account.email,
      name: account.name,
      context: 'ACCOUNT',
    });
    expect(repository.createRefreshSession.mock.calls[0]?.[0]).toMatchObject({
      context: 'ACCOUNT',
    });
    expect(organizationResolver.resolveForUser).not.toHaveBeenCalled();
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

  it('does not let a Platform-context token become an Organization identity', async () => {
    accessTokens.verifyAccessToken.mockReturnValue({
      sub: USER_ID,
      email: account.email,
      context: 'PLATFORM',
      iat: 100,
      exp: 1000,
      jti: 'd9428888-122b-4f20-8f3b-6f96e5be2a5a',
    });
    await expect(
      service.getCurrentIdentity('Bearer platform-token', undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(
      repository.findActiveOrganizationMembershipIds.mock.calls,
    ).toHaveLength(0);
  });

  it('returns the Account identity at /me but denies Organization identity', async () => {
    accessTokens.verifyAccessToken.mockReturnValue({
      sub: USER_ID,
      email: account.email,
      context: 'ACCOUNT',
      iat: 100,
      exp: 1000,
      jti: 'd9428888-122b-4f20-8f3b-6f96e5be2a5a',
    });
    await expect(
      service.getCurrentSessionIdentity('Bearer account-token', undefined),
    ).resolves.toEqual({
      id: USER_ID,
      email: account.email,
      name: account.name,
      context: 'ACCOUNT',
    });
    await expect(
      service.getCurrentIdentity('Bearer account-token', undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(
      repository.findActiveOrganizationMembershipIds,
    ).not.toHaveBeenCalled();
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
      context: 'ORGANIZATION',
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
      context: 'ORGANIZATION',
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

    it('refreshes an Account session without resolving Organization membership', async () => {
      repository.findRefreshSessionForRotation.mockResolvedValueOnce({
        outcome: 'ACTIVE',
        userId: USER_ID,
        context: 'ACCOUNT',
        expiresAt: new Date(Date.now() + 60_000),
      });
      repository.rotateRefreshSession.mockResolvedValueOnce({
        outcome: 'ROTATED',
        userId: USER_ID,
        context: 'ACCOUNT',
      });
      await expect(
        service.refresh(presented, 'csrf', 'csrf'),
      ).resolves.toHaveProperty('accessToken', 'signed-access-token');
      expect(accessTokens.signAccessToken).toHaveBeenCalledWith({
        sub: USER_ID,
        email: account.email,
        context: 'ACCOUNT',
      });
      expect(organizationResolver.resolveForUser).not.toHaveBeenCalled();
    });

    it('passes only hashes to persistence and issues credentials after rotation', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();
      repository.rotateRefreshSession.mockResolvedValue({
        outcome: 'ROTATED',
        userId: USER_ID,
        context: 'ORGANIZATION',
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

    it('refreshes a Platform session only while an approved assignment remains active', async () => {
      repository.findRefreshSessionForRotation.mockResolvedValueOnce({
        outcome: 'ACTIVE',
        userId: USER_ID,
        context: 'PLATFORM',
        expiresAt: new Date(Date.now() + 60_000),
      });
      repository.rotateRefreshSession.mockResolvedValueOnce({
        outcome: 'ROTATED',
        userId: USER_ID,
        context: 'PLATFORM',
      });
      authorizationEvidence.loadPlatformPermission.mockResolvedValue({
        assignments: [
          {
            subjectUserId: USER_ID,
            permission: 'platform.health.read',
            scope: 'PLATFORM',
            status: 'ACTIVE',
            grantedAt: new Date(Date.now() - 1000),
            grantedBy: OTHER_ORG_ID,
            expiresAt: null,
            revokedAt: null,
          },
        ],
      });

      const result = await service.refresh(presented, 'csrf', 'csrf');

      expect(result.accessToken).toBe('signed-access-token');
      expect(accessTokens.signAccessToken).toHaveBeenCalledWith({
        sub: USER_ID,
        email: account.email,
        context: 'PLATFORM',
      });
      expect(organizationResolver.resolveForUser.mock.calls).toHaveLength(0);
      expect(
        authorizationEvidence.loadPlatformPermission.mock.calls.length,
      ).toBeGreaterThan(0);
    });

    it('does not rotate a Platform session after all assignments are revoked', async () => {
      repository.findRefreshSessionForRotation.mockResolvedValueOnce({
        outcome: 'ACTIVE',
        userId: USER_ID,
        context: 'PLATFORM',
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(
        service.refresh(presented, 'csrf', 'csrf'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(repository.rotateRefreshSession.mock.calls).toHaveLength(0);
      expect(accessTokens.signAccessToken.mock.calls).toHaveLength(0);
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
        context: 'ORGANIZATION',
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
        context: 'ORGANIZATION',
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
