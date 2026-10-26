import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AUTH_SECURITY_STORE } from '../src/services/iam/application/authentication/auth-security.store';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../src/bootstrap';
import { PlatformController } from '../src/services/iam/controllers/platform.controller';
import { AuthenticationApplicationService } from '../src/services/iam/application/authentication/authentication.application.service';
import { PlatformAuthorizationGuard } from '../src/services/iam/application/authorization/platform-authorization.guard';
import {
  AuthorizationPolicy,
  type PlatformPermission,
} from '../src/services/iam/application/authorization/authorization.policy';
import { AUTHORIZATION_EVIDENCE_PROVIDER } from '../src/services/iam/application/authorization/authorization-evidence.provider';
import { PlatformAdministrationService } from '../src/services/iam/application/platform/platform-administration.service';
import type { PlatformAdministrationRepository } from '../src/services/iam/application/platform/platform-administration.repository';
import { OrganizationProvisioningService } from '../src/services/iam/application/organizations/organization-provisioning.service';
import type { OrganizationMembershipCommandRepository } from '../src/services/iam/application/organizations/organization-membership-command.repository';
import { IamApplicationService } from '../src/services/iam/application/iam.service';
import { PlatformAuditService } from '../src/services/iam/application/platform/platform-audit.service';
import { PlatformDashboardOverviewService } from '../src/services/iam/application/platform/platform-dashboard-overview.service';
import { PlatformServiceOperationsService } from '../src/services/iam/application/platform/platform-service-operations.service';
import { PlatformJobOperationsService } from '../src/services/iam/application/platform/platform-job-operations.service';
import { PlatformAiOperationsService } from '../src/services/iam/application/platform/platform-ai-operations.service';
import { PlatformIntegrationReadService } from '../src/services/iam/application/platform/platform-integration-read.service';
import { PlatformIntegrationOperationsService } from '../src/services/iam/application/platform/platform-integration-operations.service';
import { PlatformIncidentService } from '../src/services/iam/application/platform/platform-incident.service';

const actorId = '651a2b3c4d5e6f7a8b9c0d21';
const userId = '651a2b3c4d5e6f7a8b9c0d22';
const sessionId = '9a15f9ed-206d-450d-8522-6d1b8cb9e5cd';
const prefix = `/api/v1/iam/platform/users/${userId}/sessions`;
const body = {
  expectedUpdatedAt: '2026-10-26T00:00:00.000Z',
  reasonCode: 'ACCESS_REVIEW',
};
const safeSession = {
  id: sessionId,
  userId,
  context: 'ACCOUNT',
  organizationId: null,
  status: 'ACTIVE',
  createdAt: body.expectedUpdatedAt,
  updatedAt: body.expectedUpdatedAt,
  expiresAt: '2026-11-26T00:00:00.000Z',
};

// Real HTTP parsing, Platform guard/policy and application service. Identity and
// persistence are bounded doubles; Mongo transaction behavior is tested separately.
describe('Platform session HTTP security boundary', () => {
  let app: INestApplication<App>;
  let permissions: Set<string>;
  const repository = {
    listUserSessions: jest.fn(),
    findUserSession: jest.fn(),
    revokeUserSession: jest.fn(),
    revokeUserSessions: jest.fn(),
    revokeAllUserSessions: jest.fn(),
  };
  beforeAll(async () => {
    const administration = new PlatformAdministrationService(
      repository as unknown as PlatformAdministrationRepository,
      {} as OrganizationMembershipCommandRepository,
      { isReady: () => Promise.resolve(false) },
    );
    const module = await Test.createTestingModule({
      controllers: [PlatformController],
      providers: [
        PlatformAuthorizationGuard,
        {
          provide: AUTH_SECURITY_STORE,
          useValue: { consumeRateLimit: () => Promise.resolve(true) },
        },
        AuthorizationPolicy,
        {
          provide: AuthenticationApplicationService,
          useValue: {
            getCurrentPlatformSubject: (
              authorization?: string,
              cookie?: string,
            ) => {
              if (
                authorization !== undefined
                  ? authorization !== 'Bearer valid-fixture'
                  : !cookie?.includes('continuum_access=valid-fixture')
              )
                throw new UnauthorizedException();
              return { id: actorId };
            },
          },
        },
        {
          provide: AUTHORIZATION_EVIDENCE_PROVIDER,
          useValue: {
            loadPlatformPermission: (
              _id: string,
              permission: PlatformPermission,
            ) => ({
              assignments: permissions.has(permission)
                ? [
                    {
                      subjectUserId: actorId,
                      permission,
                      scope: 'PLATFORM',
                      status: 'ACTIVE',
                      grantedBy: userId,
                      grantedAt: new Date(0),
                      expiresAt: null,
                      revokedAt: null,
                    },
                  ]
                : [],
            }),
          },
        },
        { provide: PlatformAdministrationService, useValue: administration },
        ...[
          OrganizationProvisioningService,
          IamApplicationService,
          PlatformAuditService,
          PlatformDashboardOverviewService,
          PlatformServiceOperationsService,
          PlatformJobOperationsService,
          PlatformAiOperationsService,
          PlatformIntegrationReadService,
          PlatformIntegrationOperationsService,
          PlatformIncidentService,
        ].map((provide) => ({ provide, useValue: {} })),
      ],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    permissions = new Set([
      'platform.sessions.session.read',
      'platform.sessions.session.manage',
    ]);
    repository.listUserSessions.mockResolvedValue({
      data: [safeSession],
      pagination: { page: 1, pageSize: 10, totalItems: 1, totalPages: 1 },
    });
    repository.findUserSession.mockResolvedValue(safeSession);
    repository.revokeUserSession.mockResolvedValue({
      ...safeSession,
      status: 'REVOKED',
    });
    repository.revokeUserSessions.mockResolvedValue({
      revokedCount: 1,
      data: [{ ...safeSession, status: 'REVOKED' }],
    });
    repository.revokeAllUserSessions.mockResolvedValue(1);
  });

  it('lists safe metadata using the session permission, no-store and bounded paging', async () => {
    const response = await request(app.getHttpServer())
      .get(`${prefix}?page=1&pageSize=10&status=ACTIVE`)
      .set('Authorization', 'Bearer valid-fixture')
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(response.body).toMatchObject({ data: [safeSession] });
    expect(repository.listUserSessions).toHaveBeenCalledWith({
      userId,
      page: 1,
      pageSize: 10,
      status: 'ACTIVE',
    });
  });
  it('checks current assignments on every request and rejects account-manage as a substitute', async () => {
    permissions = new Set(['platform.users.account.manage']);
    await request(app.getHttpServer())
      .get(prefix)
      .set('Authorization', 'Bearer valid-fixture')
      .expect(403);
    await request(app.getHttpServer())
      .post(`${prefix}/${sessionId}/revoke`)
      .set('Authorization', 'Bearer valid-fixture')
      .send(body)
      .expect(403);
    expect(repository.listUserSessions).not.toHaveBeenCalled();
    expect(repository.revokeUserSession).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated requests even with forged actor/role headers', async () => {
    await request(app.getHttpServer())
      .get(prefix)
      .set('X-User-Id', actorId)
      .set('X-Role', 'PLATFORM_OPERATOR')
      .expect(401);
    expect(repository.listUserSessions).not.toHaveBeenCalled();
  });
  it.each([
    'page=0',
    'pageSize=101',
    'pageSize=1&pageSize=2',
    'status=UNKNOWN',
    'userId=forged',
  ])('rejects invalid list query %s', async (query) => {
    await request(app.getHttpServer())
      .get(`${prefix}?${query}`)
      .set('Authorization', 'Bearer valid-fixture')
      .expect(422);
    expect(repository.listUserSessions).not.toHaveBeenCalled();
  });
  it('requires manage permission even when the actor can read sessions', async () => {
    permissions.delete('platform.sessions.session.manage');
    await request(app.getHttpServer())
      .post(`${prefix}/${sessionId}/revoke`)
      .set('Authorization', 'Bearer valid-fixture')
      .send(body)
      .expect(403);
    expect(repository.revokeUserSession).not.toHaveBeenCalled();
  });
  it.each(['', 'wrong'])(
    'rejects cookie mutation without matching CSRF (%s)',
    async (csrf) => {
      await request(app.getHttpServer())
        .post(`${prefix}/${sessionId}/revoke`)
        .set(
          'Cookie',
          'continuum_access=valid-fixture; __Host-csrf=fixture-csrf',
        )
        .set('X-CSRF-Token', csrf)
        .send(body)
        .expect(403);
      expect(repository.revokeUserSession).not.toHaveBeenCalled();
    },
  );
  it('derives the actor server-side and forwards CAS, reason and request correlation', async () => {
    await request(app.getHttpServer())
      .post(`${prefix}/${sessionId}/revoke`)
      .set('Cookie', 'continuum_access=valid-fixture; __Host-csrf=fixture-csrf')
      .set('X-CSRF-Token', 'fixture-csrf')
      .set('X-Request-ID', 'session-test-1')
      .send(body)
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(repository.revokeUserSession).toHaveBeenCalledWith({
      actorUserId: actorId,
      userId,
      sessionId,
      expectedUpdatedAt: new Date(body.expectedUpdatedAt),
      reasonCode: 'ACCESS_REVIEW',
      correlationId: 'session-test-1',
      now: expect.any(Date) as Date,
    });
  });
  it.each([
    { reasonCode: 'ACCESS_REVIEW' },
    { ...body, expectedUpdatedAt: 'invalid' },
    { ...body, actorUserId: userId },
    { ...body, reasonCode: 'OTHER' },
  ])('rejects malformed revoke input %p', async (payload) => {
    await request(app.getHttpServer())
      .post(`${prefix}/${sessionId}/revoke`)
      .set('Authorization', 'Bearer valid-fixture')
      .send(payload)
      .expect(422);
    expect(repository.revokeUserSession).not.toHaveBeenCalled();
  });
  it('returns a scoped 404 when a session does not belong to the target user', async () => {
    repository.findUserSession.mockResolvedValue(null);
    const response = await request(app.getHttpServer())
      .get(`${prefix}/${sessionId}`)
      .set('Authorization', 'Bearer valid-fixture')
      .expect(404);
    expect(response.body).toMatchObject({
      code: 'SESSION_NOT_FOUND',
      requestId: expect.any(String) as string,
    });
  });
  it('supports bulk and all-session revocation only on their contracted routes', async () => {
    await request(app.getHttpServer())
      .post(`${prefix}/revoke-bulk`)
      .set('Authorization', 'Bearer valid-fixture')
      .send({
        sessions: [{ sessionId, expectedUpdatedAt: body.expectedUpdatedAt }],
        reasonCode: 'ACCESS_REVIEW',
      })
      .expect(200);
    await request(app.getHttpServer())
      .post(`${prefix}/revoke-all`)
      .set('Authorization', 'Bearer valid-fixture')
      .send({ reasonCode: 'SECURITY_INCIDENT' })
      .expect(200);
    expect(repository.revokeUserSessions).toHaveBeenCalledTimes(1);
    expect(repository.revokeAllUserSessions).toHaveBeenCalledTimes(1);
  });
  it.each(
    [
      [null],
      [],
      Array.from({ length: 101 }, () => ({
        sessionId,
        expectedUpdatedAt: body.expectedUpdatedAt,
      })),
      [
        { sessionId, expectedUpdatedAt: body.expectedUpdatedAt },
        { sessionId, expectedUpdatedAt: body.expectedUpdatedAt },
      ],
    ].map((sessions) => ({ sessions })),
  )(
    'rejects malformed/oversized/duplicate bulk entries',
    async ({ sessions }) => {
      await request(app.getHttpServer())
        .post(`${prefix}/revoke-bulk`)
        .set('Authorization', 'Bearer valid-fixture')
        .send({ sessions, reasonCode: 'ACCESS_REVIEW' })
        .expect(422);
      expect(repository.revokeUserSessions).not.toHaveBeenCalled();
    },
  );
});
