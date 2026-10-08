import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { configureApplication } from '../src/bootstrap';
import { AUTH_SECURITY_STORE } from '../src/services/iam/application/authentication/auth-security.store';
import type { AuthenticationRepositoryPort } from '../src/services/iam/application/authentication/authentication.repository';
import { AuthenticationApplicationService } from '../src/services/iam/application/authentication/authentication.application.service';
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
      findActiveOrganizationMembershipIds: jest.fn().mockResolvedValue([]),
      findOrganizationRoleAssignments: jest.fn(),
      findOrganizationOptions: jest.fn(),
      findProfileById: jest.fn().mockResolvedValue({
        name: 'Platform Operator',
        status: 'ACTIVE',
      }),
      replacePasswordHashIfCurrent: jest.fn().mockResolvedValue(undefined),
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
        {
          provide: OrganizationProvisioningService,
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
    await app.close();
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
    expect(createOrganization).toHaveBeenCalledWith(
      {
        id: USER_ID,
        email: 'operator@example.test',
        name: 'Platform Operator',
      },
      {
        name: 'First Organization',
        slug: 'first-organization',
        plan: 'FREE',
        firstAdminUserId: ADMIN_ID,
      },
    );
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
});
