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
import { PlatformAdministrationService } from '../src/services/iam/application/platform/platform-administration.service';
import { PlatformDashboardOverviewService } from '../src/services/iam/application/platform/platform-dashboard-overview.service';
import { PlatformServiceOperationsService } from '../src/services/iam/application/platform/platform-service-operations.service';
import { PlatformJobOperationsService } from '../src/services/iam/application/platform/platform-job-operations.service';
import { PlatformAiOperationsService } from '../src/services/iam/application/platform/platform-ai-operations.service';
import { PlatformIntegrationReadService } from '../src/services/iam/application/platform/platform-integration-read.service';
import { PlatformIntegrationOperationsService } from '../src/services/iam/application/platform/platform-integration-operations.service';
import { PlatformIncidentService } from '../src/services/iam/application/platform/platform-incident.service';
import { AuthenticationController } from '../src/services/iam/controllers/authentication.controller';
import { PlatformController } from '../src/services/iam/controllers/platform.controller';
import { LeaderDirectedLoginEligibilityPolicy } from '../src/services/iam/application/authentication/leader-directed-login-eligibility.policy';

const USER_ID = '651a2b3c4d5e6f7a8b9c0d1e';
const ADMIN_ID = '651a2b3c4d5e6f7a8b9c0d20';
const SESSION_ID = '751a2b3c4d5e6f7a8b9c0d1e';
const SECRET = 'platform-e2e-secret-at-least-32-characters';

describe('Platform Operator login and provisioning (e2e)', () => {
  let app: INestApplication;
  let assignmentActive: boolean;
  let assignedPermission: string;
  let repository: jest.Mocked<AuthenticationRepositoryPort>;
  let createOrganization: jest.Mock;
  let loadPlatformPermission: jest.Mock;
  let listOperationalMetadata: jest.Mock;
  let administration: jest.Mocked<
    Pick<
      PlatformAdministrationService,
      | 'listOrganizations'
      | 'findOrganization'
      | 'lookupActiveUser'
      | 'listOrganizationMemberships'
      | 'suspendMembership'
      | 'executePlatformInvitationCommand'
      | 'listPlatformMemberships'
    >
  >;

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
      hasActiveRefreshSession: jest.fn().mockResolvedValue(true),
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
    listOperationalMetadata = jest.fn().mockResolvedValue([]);
    administration = {
      executePlatformInvitationCommand: jest.fn().mockResolvedValue({
        httpStatus: 201,
        replayed: false,
        body: {
          operationId: '851a2b3c4d5e6f7a8b9c0d1f',
          invitation: {
            id: ADMIN_ID,
            status: 'PENDING',
            version: 1,
            expiresAt: '2026-11-01T00:00:00.000Z',
          },
        },
      }),
      listPlatformMemberships: jest.fn().mockResolvedValue({
        data: [],
        pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      }),
      listOrganizations: jest.fn().mockResolvedValue({
        data: [],
        pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      }),
      findOrganization: jest.fn(),
      lookupActiveUser: jest.fn(),
      listOrganizationMemberships: jest.fn().mockResolvedValue({
        data: [],
        pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      }),
      suspendMembership: jest.fn().mockResolvedValue({
        httpStatus: 200,
        replayed: false,
        body: {
          operationId: '851a2b3c4d5e6f7a8b9c0d1f',
          membership: {
            id: '951a2b3c4d5e6f7a8b9c0d1f',
            organizationId: '651a2b3c4d5e6f7a8b9c0d1f',
            userId: 'a51a2b3c4d5e6f7a8b9c0d1f',
            status: 'SUSPENDED',
            version: 2,
          },
        },
      }),
    };

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
          useValue: { listOperationalMetadata },
        },
        { provide: PlatformAdministrationService, useValue: administration },
        { provide: PlatformDashboardOverviewService, useValue: {} },
        { provide: PlatformServiceOperationsService, useValue: {} },
        { provide: PlatformJobOperationsService, useValue: {} },
        { provide: PlatformAiOperationsService, useValue: {} },
        { provide: PlatformIntegrationReadService, useValue: {} },
        { provide: PlatformIntegrationOperationsService, useValue: {} },
        { provide: PlatformIncidentService, useValue: {} },
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
    listOperationalMetadata.mockResolvedValue([]);
    administration.listOrganizations.mockResolvedValue({
      data: [],
      pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
    });
    administration.lookupActiveUser.mockReset();
    administration.listOrganizationMemberships.mockResolvedValue({
      data: [],
      pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
    });
    administration.suspendMembership.mockClear();
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
    const csrfCookie = cookies.find((cookie: string) =>
      cookie.startsWith('__Host-csrf='),
    ) as string;
    const accessCookieValue = accessCookie.split(';', 1)[0];
    const csrfCookieValue = csrfCookie.split(';', 1)[0];
    const csrfToken = csrfCookieValue.slice('__Host-csrf='.length);

    await request(server)
      .post('/api/v1/iam/platform/organizations')
      .type('form')
      .set('Cookie', `${accessCookieValue}; ${csrfCookieValue}`)
      .send({
        name: 'Forged Organization',
        slug: 'forged-organization',
        plan: 'FREE',
        firstAdminUserId: ADMIN_ID,
      })
      .expect(403);
    expect(createOrganization).not.toHaveBeenCalled();

    const provision = await request(server)
      .post('/api/v1/iam/platform/organizations')
      .set('Cookie', `${accessCookieValue}; ${csrfCookieValue}`)
      .set('X-CSRF-Token', csrfToken)
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
    const csrfCookie = cookies.find((cookie: string) =>
      cookie.startsWith('__Host-csrf='),
    ) as string;
    const csrfCookieValue = csrfCookie.split(';', 1)[0];

    assignmentActive = false;
    await request(server)
      .post('/api/v1/iam/platform/organizations')
      .set('Cookie', `${accessCookie.split(';', 1)[0]}; ${csrfCookieValue}`)
      .set('X-CSRF-Token', csrfCookieValue.slice('__Host-csrf='.length))
      .send({
        name: 'Denied Organization',
        slug: 'denied-organization',
        plan: 'FREE',
        firstAdminUserId: ADMIN_ID,
      })
      .expect(403);

    expect(createOrganization).not.toHaveBeenCalled();
  });

  it('returns only current exact permissions to the signed-in Platform principal', async () => {
    assignedPermission = 'platform.organizations.organization.read';
    const response = await request(app.getHttpServer() as App)
      .get('/api/v1/auth/platform/me')
      .set('Authorization', `Bearer ${operatorToken()}`)
      .expect(200);

    expect(response.body).toEqual({
      id: USER_ID,
      email: 'operator@example.test',
      name: 'Platform Operator',
      context: 'PLATFORM',
      permissions: ['platform.organizations.organization.read'],
    });
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.text).not.toContain(SECRET);
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
    expect(response.headers['cache-control']).toContain('no-store');
    expect(loadPlatformPermission).toHaveBeenCalledWith(
      USER_ID,
      'platform.health.read',
    );
  });

  it('serves the fixed audit projection with the exact audit permission', async () => {
    assignedPermission = 'platform.audit.read';
    const auditRows = [
      {
        action: 'organization.create',
        targetResource: 'ORGANIZATION',
        targetResourceId: '651a2b3c4d5e6f7a8b9c0d21',
        actorUserId: USER_ID,
        occurredAt: '2026-10-08T00:00:00.000Z',
      },
    ];
    listOperationalMetadata.mockResolvedValue(auditRows);

    const response = await request(app.getHttpServer() as App)
      .get('/api/v1/iam/platform/audit')
      .set('Authorization', `Bearer ${operatorToken()}`)
      .expect(200);

    expect(response.body).toEqual(auditRows);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(loadPlatformPermission).toHaveBeenCalledWith(
      USER_ID,
      'platform.audit.read',
    );
    expect(listOperationalMetadata).toHaveBeenCalledTimes(1);
  });

  it('serves the minimal administration projections only with their exact permissions', async () => {
    assignedPermission = 'platform.organizations.organization.read';
    administration.listOrganizations.mockResolvedValue({
      data: [
        {
          id: '651a2b3c4d5e6f7a8b9c0d21',
          name: 'Organization A',
          slug: 'organization-a',
          plan: 'FREE',
          createdAt: '2026-10-08T00:00:00.000Z',
          updatedAt: '2026-10-08T00:00:00.000Z',
        },
      ],
      pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
    });
    const server = app.getHttpServer() as App;
    const organizationResponse = await request(server)
      .get('/api/v1/iam/platform/organizations')
      .set('Authorization', `Bearer ${operatorToken()}`)
      .expect(200);
    expect(organizationResponse.body).toMatchObject({
      data: [
        {
          id: '651a2b3c4d5e6f7a8b9c0d21',
          name: 'Organization A',
          slug: 'organization-a',
          plan: 'FREE',
        },
      ],
    });
    expect(organizationResponse.headers['cache-control']).toContain('no-store');
    expect(administration.listOrganizations).toHaveBeenCalledWith(1, 20);

    assignedPermission = 'platform.users.account.read';
    administration.lookupActiveUser.mockResolvedValue({
      id: ADMIN_ID,
      email: 'admin@example.test',
      fullName: 'First Admin',
      status: 'ACTIVE',
    });
    const lookupResponse = await request(server)
      .post('/api/v1/iam/platform/users/lookup')
      .set('Authorization', `Bearer ${operatorToken()}`)
      .set('Cookie', '__Host-csrf=csrf-value')
      .set('X-CSRF-Token', 'csrf-value')
      .send({ email: ' Admin@Example.test ' })
      .expect(200);
    expect(lookupResponse.body).toEqual({
      id: ADMIN_ID,
      email: 'admin@example.test',
      fullName: 'First Admin',
      status: 'ACTIVE',
    });
    expect(lookupResponse.headers['cache-control']).toContain('no-store');
    expect(administration.lookupActiveUser).toHaveBeenCalledWith(
      ' Admin@Example.test ',
    );
  });

  it('requires exact membership permission and CSRF before suspending a scoped membership', async () => {
    assignedPermission = 'platform.memberships.membership.read';
    const server = app.getHttpServer() as App;
    const denied = await request(server)
      .post(
        `/api/v1/iam/platform/organizations/${ADMIN_ID}/memberships/${USER_ID}/suspend`,
      )
      .set('Authorization', `Bearer ${operatorToken()}`)
      .set('Cookie', '__Host-csrf=csrf-value')
      .set('X-CSRF-Token', 'csrf-value')
      .send({ expectedMembershipVersion: 1, reasonCode: 'ACCESS_REVIEW' })
      .expect(403);
    expect(denied.body).toMatchObject({
      code: expect.any(String) as string,
      message: 'Insufficient authorization.',
      details: {},
      requestId: expect.any(String) as string,
    });
    expect(administration.suspendMembership).not.toHaveBeenCalled();

    assignedPermission = 'platform.memberships.lifecycle.manage';
    await request(server)
      .post(
        `/api/v1/iam/platform/organizations/${ADMIN_ID}/memberships/${USER_ID}/suspend`,
      )
      .set('Authorization', `Bearer ${operatorToken()}`)
      .set('Cookie', '__Host-csrf=csrf-value')
      .set('X-CSRF-Token', 'csrf-value')
      .set('Idempotency-Key', 'platform-suspend-membership-001')
      .send({ expectedMembershipVersion: 1, reasonCode: 'ACCESS_REVIEW' })
      .expect(200)
      .expect(({ body, headers }) => {
        expect(body).toMatchObject({
          membership: { status: 'SUSPENDED' },
        });
        expect(headers['cache-control']).toContain('no-store');
        expect(headers['x-idempotent-replay']).toBe('false');
      });
    expect(administration.suspendMembership).toHaveBeenCalledWith({
      actorUserId: USER_ID,
      organizationId: ADMIN_ID,
      membershipId: USER_ID,
      idempotencyKey: 'platform-suspend-membership-001',
      expectedMembershipVersion: 1,
      reasonCode: 'ACCESS_REVIEW',
    });
  });

  it('requires the exact read permission for the global membership directory', async () => {
    const read = () =>
      request(app.getHttpServer() as App)
        .get('/api/v1/iam/platform/memberships')
        .set('Authorization', `Bearer ${operatorToken()}`);
    assignedPermission = 'platform.memberships.invitation.manage';
    await read().expect(403);
    expect(administration.listPlatformMemberships).not.toHaveBeenCalled();
    assignedPermission = 'platform.memberships.membership.read';
    await read().expect(200).expect('Cache-Control', 'no-store');
    expect(administration.listPlatformMemberships).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
    });
    await read().query({ pageSize: 101 }).expect(422);
    await read().query({ organizationId: 'invalid' }).expect(422);
    await read().query({ roleCode: 'PLATFORM_OPERATOR' }).expect(422);
    expect(administration.listPlatformMemberships).toHaveBeenCalledTimes(1);
  });

  const platformInvitationCases = [
    {
      action: '',
      body: { email: 'invitee@example.test', reasonCode: 'ACCESS_REQUEST' },
      command: 'INVITE',
    },
    {
      action: `/${ADMIN_ID}/resend`,
      body: {
        expectedMembershipVersion: 0,
        expectedInvitationVersion: 1,
        reasonCode: 'ACCESS_REVIEW',
      },
      command: 'RESEND',
    },
    {
      action: `/${ADMIN_ID}/cancel`,
      body: {
        expectedMembershipVersion: 0,
        expectedInvitationVersion: 1,
        reasonCode: 'INVITATION_CANCELLED',
      },
      command: 'CANCEL',
    },
  ];

  it.each(platformInvitationCases)(
    'requires exact authority and CSRF for $command',
    async ({ action, body, command }) => {
      const post = () =>
        request(app.getHttpServer() as App)
          .post(
            `/api/v1/iam/platform/organizations/${ADMIN_ID}/invitations${action}`,
          )
          .set('Authorization', `Bearer ${operatorToken()}`)
          .set('Idempotency-Key', 'platform-invitation-http-test');
      assignedPermission = 'platform.memberships.membership.read';
      await post()
        .set('Cookie', '__Host-csrf=csrf-value')
        .set('X-CSRF-Token', 'csrf-value')
        .send(body)
        .expect(403);
      assignedPermission = 'platform.memberships.invitation.manage';
      await post().send(body).expect(403);
      await post()
        .set('Cookie', '__Host-csrf=csrf-value')
        .set('X-CSRF-Token', 'wrong')
        .send(body)
        .expect(403);
      expect(
        administration.executePlatformInvitationCommand,
      ).not.toHaveBeenCalled();
      administration.executePlatformInvitationCommand.mockResolvedValueOnce({
        httpStatus: command === 'INVITE' ? 201 : 200,
        replayed: false,
        body: {
          operationId: '851a2b3c4d5e6f7a8b9c0d1f',
          invitation: {
            id: ADMIN_ID,
            status: command === 'CANCEL' ? 'CANCELLED' : 'PENDING',
            version: 1,
            expiresAt: '2026-11-01T00:00:00.000Z',
          },
        },
      });
      const response = await post()
        .set('Cookie', '__Host-csrf=csrf-value')
        .set('X-CSRF-Token', 'csrf-value')
        .send(body)
        .expect(command === 'INVITE' ? 201 : 200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-idempotent-replay']).toBe('false');
      expect(
        administration.executePlatformInvitationCommand,
      ).toHaveBeenCalledWith({
        actorUserId: USER_ID,
        organizationId: ADMIN_ID,
        idempotencyKey: 'platform-invitation-http-test',
        command: {
          ...body,
          command,
          ...(command === 'INVITE' ? {} : { invitationId: ADMIN_ID }),
        },
      });
    },
  );

  it.each(platformInvitationCases)(
    'rejects injected authority and invalid request IDs for $command',
    async ({ action, body }) => {
      assignedPermission = 'platform.memberships.invitation.manage';
      const post = () =>
        request(app.getHttpServer() as App)
          .post(
            `/api/v1/iam/platform/organizations/${ADMIN_ID}/invitations${action}`,
          )
          .set('Authorization', `Bearer ${operatorToken()}`)
          .set('Cookie', '__Host-csrf=csrf-value')
          .set('X-CSRF-Token', 'csrf-value')
          .set('Idempotency-Key', 'platform-invitation-http-test');
      await post()
        .send({ ...body, roleCode: 'ADMIN' })
        .expect(422);
      await post()
        .send({ ...body, actorUserId: ADMIN_ID })
        .expect(422);
      await post()
        .set('X-Request-ID', 'invalid request id')
        .send(body)
        .expect(422);
      expect(
        administration.executePlatformInvitationCommand,
      ).not.toHaveBeenCalled();
    },
  );

  it('denies audit access when the current assignment grants only health read', async () => {
    assignedPermission = 'platform.health.read';
    const token = operatorToken();

    const response = await request(app.getHttpServer() as App)
      .get('/api/v1/iam/platform/audit')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(response.body).toEqual({
      code: expect.any(String) as string,
      message: 'Insufficient authorization.',
      details: {},
      requestId: expect.any(String) as string,
    });
    expect(loadPlatformPermission).toHaveBeenCalledWith(
      USER_ID,
      'platform.audit.read',
    );
    expect(listOperationalMetadata).not.toHaveBeenCalled();
    expect(response.text).not.toContain(token);
    expect(response.text).not.toContain('organization.create');
    expect(response.text).not.toContain('651a2b3c4d5e6f7a8b9c0d21');
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
      sid: SESSION_ID,
      userFence: 0,
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
