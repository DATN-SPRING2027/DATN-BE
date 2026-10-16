import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { configureApplication } from '../src/bootstrap';
import { AUTH_SECURITY_STORE } from '../src/services/iam/application/authentication/auth-security.store';
import type { AuthenticationRepositoryPort } from '../src/services/iam/application/authentication/authentication.repository';
import { AuthenticationApplicationService } from '../src/services/iam/application/authentication/authentication.application.service';
import { GoogleOAuthService } from '../src/services/iam/application/authentication/google-oauth.service';
import { PasswordResetService } from '../src/services/iam/application/authentication/password-reset.service';
import { AccessTokenService } from '../src/services/iam/application/authentication/access-token.service';
import { LOGIN_ELIGIBILITY_POLICY } from '../src/services/iam/application/authentication/login-eligibility.policy';
import { ORGANIZATION_CONTEXT_RESOLVER } from '../src/services/iam/application/authentication/organization-context.resolver';
import { PasswordCredentialService } from '../src/services/iam/application/credentials/password-credential.service';
import { AUTHENTICATION_REPOSITORY } from '../src/services/iam/application/authentication/authentication.repository';
import { AUTHORIZATION_EVIDENCE_PROVIDER } from '../src/services/iam/application/authorization/authorization-evidence.provider';
import { AuthorizationPolicy } from '../src/services/iam/application/authorization/authorization.policy';
import { PlatformAuthorizationGuard } from '../src/services/iam/application/authorization/platform-authorization.guard';
import { IamApplicationService } from '../src/services/iam/application/iam.service';
import { OrganizationProvisioningService } from '../src/services/iam/application/organizations/organization-provisioning.service';
import { ORGANIZATION_PROVISIONING_REPOSITORY } from '../src/services/iam/application/organizations/organization-provisioning.repository';
import { PlatformAuditService } from '../src/services/iam/application/platform/platform-audit.service';
import { AuthenticationController } from '../src/services/iam/controllers/authentication.controller';
import { PlatformController } from '../src/services/iam/controllers/platform.controller';
import { LeaderDirectedLoginEligibilityPolicy } from '../src/services/iam/application/authentication/leader-directed-login-eligibility.policy';

const USER_ID = '651a2b3c4d5e6f7a8b9c0d1e';
const ADMIN_ID = '651a2b3c4d5e6f7a8b9c0d20';
const SECRET = 'platform-e2e-secret-at-least-32-characters';

describe('Platform Operator login and provisioning (e2e)', () => {
  let app: INestApplication;
  let assignmentActive: boolean;
  let assignedPermission: string;
  let repository: jest.Mocked<AuthenticationRepositoryPort>;
  let createOrganization: jest.Mock;
  let loadPlatformPermission: jest.Mock;

  beforeAll(async () => {
    assignmentActive = true;
    assignedPermission = 'organization.create';
    repository = {
      findAccountByEmail: jest.fn().mockResolvedValue({
        userId: USER_ID,
        email: 'operator@example.test',
        name: 'Platform Operator',
        passwordHash: 'fixture-password-hash',
        status: 'ACTIVE',
        twoFactorEnabled: false,
      }),
      findAccountByGoogleSubject: jest.fn().mockResolvedValue(null),
      linkGoogleSubjectIfMissing: jest.fn().mockResolvedValue(false),
      createGoogleAccount: jest.fn(),
      findActiveOrganizationMembershipIds: jest.fn().mockResolvedValue([]),
      findOrganizationRoleAssignments: jest.fn(),
      findOrganizationOptions: jest.fn(),
      findProfileById: jest.fn().mockResolvedValue({
        name: 'Platform Operator',
        status: 'ACTIVE',
      }),
      replacePasswordHashIfCurrent: jest.fn().mockResolvedValue(undefined),
      resetPassword: jest.fn().mockResolvedValue(true),
      revokeRefreshSessionByHash: jest.fn().mockResolvedValue(true),
      findRefreshSessionForRotation: jest.fn(),
      rotateRefreshSession: jest.fn(),
      findAccountById: jest.fn(),
      createRefreshSession: jest.fn().mockResolvedValue(undefined),
    };

    const assignment = {
      subjectUserId: USER_ID,
      permission: 'organization.create',
      scope: 'PLATFORM',
      status: 'ACTIVE',
      grantedAt: new Date(Date.now() - 60_000),
      grantedBy: ADMIN_ID,
      expiresAt: null,
      revokedAt: null,
    };
    loadPlatformPermission = jest
      .fn()
      .mockImplementation((userId: string, permission: string) => ({
        assignments:
          assignmentActive &&
          userId === USER_ID &&
          permission === assignedPermission
            ? [{ ...assignment, permission }]
            : [],
      }));
    createOrganization = jest.fn().mockResolvedValue({
      id: '651a2b3c4d5e6f7a8b9c0d21',
      name: 'First Organization',
      slug: 'first-organization',
      plan: 'FREE',
      createdAt: '2026-10-08T00:00:00.000Z',
      updatedAt: '2026-10-08T00:00:00.000Z',
    });

    const module = await Test.createTestingModule({
      controllers: [AuthenticationController, PlatformController],
      providers: [
        AuthenticationApplicationService,
        { provide: GoogleOAuthService, useValue: {} },
        { provide: PasswordResetService, useValue: {} },
        AccessTokenService,
        AuthorizationPolicy,
        PlatformAuthorizationGuard,
        IamApplicationService,
        { provide: ConfigService, useValue: { get: () => SECRET } },
        { provide: AUTHENTICATION_REPOSITORY, useValue: repository },
        {
          provide: AUTH_SECURITY_STORE,
          useValue: {
            consumeRateLimit: jest.fn().mockResolvedValue(true),
            clearRateLimit: jest.fn().mockResolvedValue(undefined),
            isTokenRevoked: jest.fn().mockResolvedValue(false),
            revokeToken: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: LOGIN_ELIGIBILITY_POLICY,
          useValue: new LeaderDirectedLoginEligibilityPolicy(),
        },
        {
          provide: ORGANIZATION_CONTEXT_RESOLVER,
          useValue: { resolveForUser: jest.fn() },
        },
        {
          provide: PasswordCredentialService,
          useValue: {
            verifyPassword: jest.fn().mockResolvedValue({
              verified: true,
              needsRehash: false,
            }),
            hashPassword: jest.fn(),
          },
        },
        {
          provide: AUTHORIZATION_EVIDENCE_PROVIDER,
          useValue: {
            loadPlatformPermission,
            loadProjectCreate: jest.fn(),
            loadProjectAccess: jest.fn(),
          },
        },
        OrganizationProvisioningService,
        {
          provide: ORGANIZATION_PROVISIONING_REPOSITORY,
          useValue: { create: createOrganization },
        },
        {
          provide: PlatformAuditService,
          useValue: {
            listOperationalMetadata: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    assignmentActive = true;
    assignedPermission = 'organization.create';
    jest.clearAllMocks();
    repository.findAccountByEmail.mockResolvedValue({
      userId: USER_ID,
      email: 'operator@example.test',
      name: 'Platform Operator',
      passwordHash: 'fixture-password-hash',
      status: 'ACTIVE',
      twoFactorEnabled: false,
    });
    repository.findActiveOrganizationMembershipIds.mockResolvedValue([]);
    repository.findProfileById.mockResolvedValue({
      name: 'Platform Operator',
      status: 'ACTIVE',
    });
    repository.createRefreshSession.mockResolvedValue(undefined);
    createOrganization.mockResolvedValue({
      id: '651a2b3c4d5e6f7a8b9c0d21',
      name: 'First Organization',
      slug: 'first-organization',
      plan: 'FREE',
      createdAt: '2026-10-08T00:00:00.000Z',
      updatedAt: '2026-10-08T00:00:00.000Z',
    });
  });

  it('logs in an ACTIVE assigned user without Organization Membership and provisions an Organization', async () => {
    const server = app.getHttpServer() as App;
    const login = await request(server)
      .post('/api/v1/auth/platform/login')
      .send({ email: 'operator@example.test', password: 'correct-password' })
      .expect(200);

    expect(login.body).toEqual({
      context: 'PLATFORM',
      user: {
        id: USER_ID,
        email: 'operator@example.test',
        name: 'Platform Operator',
      },
    });
    expect(login.headers['set-cookie']).toHaveLength(3);
    expect(
      repository.findActiveOrganizationMembershipIds.mock.calls,
    ).toHaveLength(0);

    const cookies = login.headers['set-cookie'] as unknown as string[];
    const accessCookie = cookies.find((cookie: string) =>
      cookie.startsWith('continuum_access='),
    ) as string;
    const provision = await request(server)
      .post('/api/v1/iam/platform/organizations')
      .set('Cookie', accessCookie.split(';', 1)[0])
      .send({
        name: 'First Organization',
        slug: 'first-organization',
        plan: 'FREE',
        firstAdminUserId: ADMIN_ID,
      })
      .expect(201);

    expect(provision.body).toMatchObject({ id: '651a2b3c4d5e6f7a8b9c0d21' });
    expect(createOrganization).toHaveBeenCalledWith(USER_ID, {
      name: 'First Organization',
      slug: 'first-organization',
      plan: 'FREE',
      firstAdminUserId: ADMIN_ID,
    });
    expect(loadPlatformPermission).toHaveBeenCalledWith(
      USER_ID,
      'organization.create',
    );
  });

  it('rechecks platform assignment on each request after login', async () => {
    const server = app.getHttpServer() as App;
    const login = await request(server)
      .post('/api/v1/auth/platform/login')
      .send({ email: 'operator@example.test', password: 'correct-password' })
      .expect(200);
    const cookies = login.headers['set-cookie'] as unknown as string[];
    const accessCookie = cookies.find((cookie: string) =>
      cookie.startsWith('continuum_access='),
    ) as string;

    assignmentActive = false;
    await request(server)
      .post('/api/v1/iam/platform/organizations')
      .set('Cookie', accessCookie.split(';', 1)[0])
      .send({
        name: 'Denied Organization',
        slug: 'denied-organization',
        plan: 'FREE',
        firstAdminUserId: ADMIN_ID,
      })
      .expect(403);

    expect(createOrganization).not.toHaveBeenCalled();
  });

  it('serves the documented IAM liveness response for a health-only Platform assignment', async () => {
    assignedPermission = 'platform.health.read';
    const server = app.getHttpServer() as App;
    const login = await request(server)
      .post('/api/v1/auth/platform/login')
      .send({ email: 'operator@example.test', password: 'correct-password' })
      .expect(200);
    const cookies = login.headers['set-cookie'] as unknown as string[];
    const accessCookie = cookies.find((cookie) =>
      cookie.startsWith('continuum_access='),
    ) as string;

    const response = await request(server)
      .get('/api/v1/iam/platform/health')
      .set('Cookie', accessCookie.split(';', 1)[0])
      .expect(200);

    expect(response.body).toEqual({ status: 'ok' });
    expect(loadPlatformPermission).toHaveBeenCalledWith(
      USER_ID,
      'platform.health.read',
    );
  });

  const validInput = {
    name: 'First Organization',
    slug: 'first-organization',
    plan: 'FREE',
    firstAdminUserId: ADMIN_ID,
  };

  function operatorToken() {
    return app.get(AccessTokenService).signAccessToken({
      sub: USER_ID,
      email: 'operator@example.test',
      context: 'PLATFORM',
    });
  }

  it.each([
    ['empty body', {}],
    ['array body', []],
    ['blank name', { ...validInput, name: '  ' }],
    ['long name', { ...validInput, name: 'n'.repeat(201) }],
    ['non-string name', { ...validInput, name: 123 }],
    ['blank slug', { ...validInput, slug: '  ' }],
    ['long slug', { ...validInput, slug: 's'.repeat(101) }],
    ['invalid plan', { ...validInput, plan: 'PAID' }],
    ['invalid admin ID', { ...validInput, firstAdminUserId: 'invalid' }],
    ['missing admin ID', { name: 'Organization', slug: 'org', plan: 'FREE' }],
    ['injected role', { ...validInput, roleCode: 'ADMIN' }],
    ['injected membership', { ...validInput, status: 'ACTIVE' }],
    ['injected tenant', { ...validInput, organizationId: ADMIN_ID }],
  ])('rejects %s before persistence', async (_label, body) => {
    const response = await request(app.getHttpServer() as App)
      .post('/api/v1/iam/platform/organizations')
      .set('Authorization', `Bearer ${operatorToken()}`)
      .send(body)
      .expect(422);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: {},
      requestId: expect.any(String) as string,
    });
    expect(createOrganization).not.toHaveBeenCalled();
  });

  it('normalizes input and accepts documented length limits', async () => {
    const body = {
      ...validInput,
      name: 'n'.repeat(200),
      slug: 'S'.repeat(100),
    };
    await request(app.getHttpServer() as App)
      .post('/api/v1/iam/platform/organizations')
      .set('Authorization', `Bearer ${operatorToken()}`)
      .send({ ...body, name: ` ${body.name} `, slug: ` ${body.slug} ` })
      .expect(201);
    expect(createOrganization).toHaveBeenCalledWith(USER_ID, {
      ...body,
      slug: body.slug.toLowerCase(),
    });
  });

  it('rejects operator self-bootstrap without calling persistence', async () => {
    const response = await request(app.getHttpServer() as App)
      .post('/api/v1/iam/platform/organizations')
      .set('Authorization', `Bearer ${operatorToken()}`)
      .send({ ...validInput, firstAdminUserId: USER_ID.toUpperCase() })
      .expect(409);
    expect(response.body).toMatchObject({
      code: 'PLATFORM_OPERATOR_CANNOT_BE_FIRST_ADMIN',
    });
    expect(createOrganization).not.toHaveBeenCalled();
  });

  it.each(['platform.health.read', 'platform.audit.read'])(
    'does not allow provisioning with only %s',
    async (permission) => {
      assignedPermission = permission;
      const token = operatorToken();
      const response = await request(app.getHttpServer() as App)
        .post('/api/v1/iam/platform/organizations')
        .set('Authorization', `Bearer ${token}`)
        .send(validInput)
        .expect(403);
      expect(response.text).not.toContain(token);
      expect(response.text).not.toContain(validInput.name);
      expect(response.text).not.toContain(validInput.slug);
      expect(response.text).not.toContain(validInput.firstAdminUserId);
      expect(createOrganization).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'Bearer malformed'])(
    'rejects missing or invalid credentials (%s) before persistence',
    async (authorization) => {
      const pending = request(app.getHttpServer() as App).post(
        '/api/v1/iam/platform/organizations',
      );
      if (authorization) pending.set('Authorization', authorization);
      await pending.send(validInput).expect(401);
      expect(createOrganization).not.toHaveBeenCalled();
    },
  );
});
