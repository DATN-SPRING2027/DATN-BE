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
import { OrganizationProvisioningService } from '../src/services/iam/application/organizations/organization-provisioning.service';
import { IamApplicationService } from '../src/services/iam/application/iam.service';
import { PlatformAuditService } from '../src/services/iam/application/platform/platform-audit.service';
import { PlatformDashboardOverviewService } from '../src/services/iam/application/platform/platform-dashboard-overview.service';
import { PlatformServiceOperationsService } from '../src/services/iam/application/platform/platform-service-operations.service';
import { PlatformJobOperationsService } from '../src/services/iam/application/platform/platform-job-operations.service';
import { PlatformAiOperationsService } from '../src/services/iam/application/platform/platform-ai-operations.service';
import { PlatformIntegrationReadService } from '../src/services/iam/application/platform/platform-integration-read.service';
import { PlatformIntegrationOperationsService } from '../src/services/iam/application/platform/platform-integration-operations.service';
import { PlatformIncidentService } from '../src/services/iam/application/platform/platform-incident.service';

import { PLATFORM_SERVICE_OPERATIONS_REPOSITORY } from '../src/services/iam/application/platform/platform-service-operations.repository';
import { PLATFORM_JOB_OPERATIONS_REPOSITORY } from '../src/services/iam/application/platform/platform-job-operations.repository';
import { PLATFORM_AI_OPERATIONS_REPOSITORY } from '../src/services/iam/application/platform/platform-ai-operations.repository';
import { PLATFORM_INTEGRATION_READ_REPOSITORY } from '../src/services/iam/application/platform/platform-integration-read.repository';
import { PLATFORM_INTEGRATION_OPERATIONS_REPOSITORY } from '../src/services/iam/application/platform/platform-integration-operations.repository';
import { PLATFORM_INCIDENT_REPOSITORY } from '../src/services/iam/application/platform/platform-incident.repository';
import { PLATFORM_AUDIT_REPOSITORY } from '../src/services/iam/application/platform/platform-audit.repository';
const actorId = '651a2b3c4d5e6f7a8b9c0d21';
const id = '651a2b3c4d5e6f7a8b9c0d22';
const prefix = '/api/v1/iam/platform/';
const page = {
  data: [],
  pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
};
const readCases = [
  ['services', 'platform.services.service.read'],
  ['services/iam', 'platform.services.service.read'],
  ['queues', 'platform.jobs.job.read'],
  ['queues/ingestion-queue', 'platform.jobs.job.read'],
  ['jobs', 'platform.jobs.job.read'],
  ['jobs/ingestion-queue/job-1', 'platform.jobs.job.read'],
  ['ai/operations', 'platform.ai.operations.read'],
  ['integrations', 'platform.integrations.integration.read'],
  [`integrations/${id}`, 'platform.integrations.integration.read'],
  ['incidents', 'platform.incidents.incident.read'],
  [`incidents/${id}`, 'platform.incidents.incident.read'],
  [`incidents/${id}/history`, 'platform.incidents.incident.read'],
  ['audit/events', 'platform.audit.read'],
  ['audit/events/event-1', 'platform.audit.read'],
  [`audit/resources/USER/${id}/history`, 'platform.audit.read'],
  ['diagnostics/traces/request-1', 'platform.diagnostics.trace.read'],
] as const;
const writes = [
  {
    path: 'jobs/ingestion-queue/job-1/retry',
    permission: 'platform.jobs.job.manage',
    body: { expectedStatus: 'FAILED' },
    status: 200,
  },
  {
    path: 'jobs/ingestion-queue/job-1/cancel',
    permission: 'platform.jobs.job.manage',
    body: { expectedStatus: 'WAITING' },
    status: 200,
  },
  {
    path: `integrations/${id}/test`,
    permission: 'platform.integrations.integration.manage',
    body: {},
    status: 200,
  },
  {
    path: `integrations/${id}/reconnect`,
    permission: 'platform.integrations.integration.manage',
    body: { expectedUpdatedAt: '2026-10-26T00:00:00.000Z' },
    status: 200,
  },
  {
    path: 'incidents',
    permission: 'platform.incidents.incident.manage',
    body: {
      title: 'Service unavailable',
      severity: 'HIGH',
      affectedServiceId: 'iam',
    },
    status: 201,
  },
  ...['acknowledge', 'resolve', 'notes'].map((action) => ({
    path: `incidents/${id}/${action}`,
    permission: 'platform.incidents.incident.manage',
    body: { expectedVersion: 1, note: 'Operator reviewed' },
    status: 200,
  })),
];

// Real Nest controller, policy/guard and application services; external stores,
// BullMQ, probes and authentication identity are explicit bounded doubles.
describe('Platform operations HTTP security', () => {
  let app: INestApplication<App>;
  let permissions: Set<string>;
  const rate = jest.fn<Promise<boolean>, [string, number, number]>();
  const operations = {
    listServices: jest.fn(),
    findService: jest.fn(),
    listQueues: jest.fn(),
    findQueue: jest.fn(),
    listJobs: jest.fn(),
    findJob: jest.fn(),
    execute: jest.fn(),
    getStatus: jest.fn(),
    list: jest.fn(),
    findById: jest.fn(),
    testConnection: jest.fn(),
    reconnect: jest.fn(),
    find: jest.fn(),
    listHistory: jest.fn(),
    listEvents: jest.fn(),
    findEvent: jest.fn(),
    listResourceHistory: jest.fn(),
    findRequestTrace: jest.fn(),
  };
  const incidentExecute = jest.fn();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PlatformController],
      providers: [
        PlatformAuthorizationGuard,
        AuthorizationPolicy,
        { provide: AUTH_SECURITY_STORE, useValue: { consumeRateLimit: rate } },
        {
          provide: AuthenticationApplicationService,
          useValue: {
            getCurrentPlatformSubject: (authorization?: string) => {
              if (authorization !== 'Bearer fixture')
                throw new UnauthorizedException();
              return { id: actorId };
            },
          },
        },
        {
          provide: AUTHORIZATION_EVIDENCE_PROVIDER,
          useValue: {
            loadPlatformPermission: (
              _actor: string,
              permission: PlatformPermission,
            ) => ({
              assignments: permissions.has(permission)
                ? [
                    {
                      subjectUserId: actorId,
                      permission,
                      scope: 'PLATFORM',
                      status: 'ACTIVE',
                      grantedBy: id,
                      grantedAt: new Date(0),
                      expiresAt: null,
                      revokedAt: null,
                    },
                  ]
                : [],
            }),
          },
        },
        PlatformServiceOperationsService,
        PlatformJobOperationsService,
        PlatformAiOperationsService,
        PlatformIntegrationReadService,
        PlatformIntegrationOperationsService,
        PlatformIncidentService,
        PlatformAuditService,
        ...[
          PLATFORM_SERVICE_OPERATIONS_REPOSITORY,
          PLATFORM_JOB_OPERATIONS_REPOSITORY,
          PLATFORM_AI_OPERATIONS_REPOSITORY,
          PLATFORM_INTEGRATION_READ_REPOSITORY,
          PLATFORM_INTEGRATION_OPERATIONS_REPOSITORY,
          PLATFORM_AUDIT_REPOSITORY,
        ].map((provide) => ({ provide, useValue: operations })),
        {
          provide: PLATFORM_INCIDENT_REPOSITORY,
          useValue: { ...operations, execute: incidentExecute },
        },
        ...[
          OrganizationProvisioningService,
          IamApplicationService,
          PlatformAdministrationService,
          PlatformDashboardOverviewService,
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
      ...readCases.map((entry) => entry[1]),
      ...writes.map((entry) => entry.permission),
    ]);
    rate.mockResolvedValue(true);
    for (const mock of Object.values(operations)) mock.mockResolvedValue(page);
    operations.findService.mockResolvedValue({ id: 'iam', status: 'READY' });
    operations.findQueue.mockResolvedValue({ id: 'ingestion-queue' });
    operations.findJob.mockResolvedValue({
      id: 'job-1',
      queueId: 'ingestion-queue',
    });
    operations.find.mockResolvedValue({ id, status: 'OPEN' });
    operations.findById.mockResolvedValue({ id, provider: 'JIRA' });
    operations.findEvent.mockResolvedValue({ eventId: 'event-1' });
    operations.findRequestTrace.mockResolvedValue({
      requestId: 'request-1',
      events: [{ eventId: 'event-1' }],
    });
    operations.execute.mockResolvedValue({
      body: { outcome: 'RETRY_QUEUED' },
      replayed: false,
    });
    incidentExecute.mockImplementation(
      (input: { command: { command: string } }) =>
        Promise.resolve({
          body: { id, status: 'OPEN' },
          replayed: false,
          httpStatus: input.command.command === 'CREATE' ? 201 : 200,
        }),
    );
  });
  it.each(readCases)(
    'reads %s only with its exact current permission',
    async (path, permission) => {
      permissions = new Set([permission]);
      await request(app.getHttpServer())
        .get(prefix + path)
        .set('Authorization', 'Bearer fixture')
        .expect(200)
        .expect('Cache-Control', 'no-store');
      permissions.clear();
      await request(app.getHttpServer())
        .get(prefix + path)
        .set('Authorization', 'Bearer fixture')
        .expect(403);
      await request(app.getHttpServer())
        .get(prefix + path)
        .set('X-User-Id', actorId)
        .expect(401);
    },
  );
  it.each(writes)(
    'guards mutation $path against wrong permissions, CSRF and missing idempotency',
    async ({ path, permission, body, status }) => {
      const post = () =>
        request(app.getHttpServer())
          .post(prefix + path)
          .set('Authorization', 'Bearer fixture');
      permissions.clear();
      await post().send(body).expect(403);
      permissions.add(permission);
      await post()
        .set('Idempotency-Key', 'platform-ops-http-key-001')
        .send(body)
        .expect(403);
      await post()
        .set('Cookie', '__Host-csrf=fixture')
        .set('X-CSRF-Token', 'fixture')
        .send(body)
        .expect(422);
      await post()
        .set('Cookie', '__Host-csrf=fixture')
        .set('X-CSRF-Token', 'fixture')
        .set('Idempotency-Key', 'platform-ops-http-key-001')
        .send(body)
        .expect(status)
        .expect('Cache-Control', 'no-store');
    },
  );
  it('returns safe 404 for missing trace and maps diagnostic outages to 503', async () => {
    operations.findRequestTrace.mockResolvedValue({
      requestId: 'request-1',
      events: [],
    });
    await request(app.getHttpServer())
      .get(prefix + 'diagnostics/traces/request-1')
      .set('Authorization', 'Bearer fixture')
      .expect(404);
    operations.findRequestTrace.mockRejectedValue(
      new Error('private database details'),
    );
    const result = await request(app.getHttpServer())
      .get(prefix + 'diagnostics/traces/request-1')
      .set('Authorization', 'Bearer fixture')
      .expect(503);
    expect(result.text).not.toContain('private database details');
  });
  it.each([
    'jobs?pageSize=101',
    'incidents?status=UNKNOWN',
    'integrations?token=secret',
    'audit/events?page=0',
  ])('rejects invalid query %s', async (path) => {
    await request(app.getHttpServer())
      .get(prefix + path)
      .set('Authorization', 'Bearer fixture')
      .expect(422);
  });
  it.each(writes)(
    'blocks $path before side effects when the actor budget is exhausted',
    async ({ path, body }) => {
      rate.mockResolvedValue(false);
      await request(app.getHttpServer())
        .post(prefix + path)
        .set('Authorization', 'Bearer fixture')
        .set('Cookie', '__Host-csrf=fixture')
        .set('X-CSRF-Token', 'fixture')
        .set('Idempotency-Key', 'platform-ops-http-key-001')
        .send(body)
        .expect(429)
        .expect('Retry-After', /^[1-9][0-9]*$/);
      expect(operations.execute.mock.calls).toHaveLength(0);
      expect(operations.testConnection.mock.calls).toHaveLength(0);
      expect(operations.reconnect.mock.calls).toHaveLength(0);
      expect(incidentExecute.mock.calls).toHaveLength(0);
    },
  );
});
