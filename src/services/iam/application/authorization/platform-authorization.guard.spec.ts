import {
  Controller,
  Get,
  INestApplication,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthenticationApplicationService } from '../authentication/authentication.application.service';
import {
  AUTHORIZATION_EVIDENCE_PROVIDER,
  type PlatformPermissionEvidence,
} from './authorization-evidence.provider';
import { AuthorizationPolicy } from './authorization.policy';
import { PlatformAuthorizationGuard } from './platform-authorization.guard';
import { RequirePlatformPermission } from './platform-permission.decorator';

const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
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

@Controller('platform-authorization-test')
@UseGuards(PlatformAuthorizationGuard)
class PlatformAuthorizationHarnessController {
  @Post('organization')
  @RequirePlatformPermission('organization.create')
  createOrganization() {
    return { allowed: true };
  }

  @Get('health')
  @RequirePlatformPermission('platform.health.read')
  readHealth() {
    return { status: 'ok' };
  }

  @Get('audit')
  @RequirePlatformPermission('platform.audit.read')
  readAudit() {
    return [];
  }
}

describe('PlatformAuthorizationGuard', () => {
  let app: INestApplication;
  let facts: PlatformPermissionEvidence | null;
  const identity = {
    id: userId,
    email: 'operator@example.test',
    name: 'Operator',
    organizationId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    // Display/token role claims never establish Platform authority.
    roles: ['ADMIN', 'PLATFORM_OPERATOR'],
  };
  const platformSubject = {
    id: userId,
    email: 'operator@example.test',
    name: 'Operator',
  };
  const authentication = {
    getCurrentPlatformSubject: jest.fn((authorization: string | undefined) => {
      if (authorization !== 'Bearer valid')
        return Promise.reject(new UnauthorizedException());
      return Promise.resolve(platformSubject);
    }),
  };
  const evidence = {
    loadPlatformPermission: jest.fn(() => Promise.resolve(facts)),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PlatformAuthorizationHarnessController],
      providers: [
        PlatformAuthorizationGuard,
        AuthorizationPolicy,
        { provide: AuthenticationApplicationService, useValue: authentication },
        { provide: AUTHORIZATION_EVIDENCE_PROVIDER, useValue: evidence },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  beforeEach(() => {
    facts = { assignments: [] };
    identity.roles = ['ADMIN', 'PLATFORM_OPERATOR'];
    evidence.loadPlatformPermission.mockClear();
  });

  afterAll(async () => app.close());

  it.each([
    ['organization.create', 'POST', '/organization'],
    ['platform.health.read', 'GET', '/health'],
    ['platform.audit.read', 'GET', '/audit'],
  ] as const)(
    'allows the exact assigned permission %s',
    async (permission, method, path) => {
      facts = { assignments: [assignment(permission)] };
      let call = request(app.getHttpServer() as App)
        [method.toLowerCase() as 'get' | 'post'](
          `/api/v1/platform-authorization-test${path}`,
        )
        .set('Authorization', 'Bearer valid');
      if (method === 'POST') call = call.send({});
      await call.expect(method === 'POST' ? 201 : 200);
      expect(evidence.loadPlatformPermission).toHaveBeenCalledWith(
        userId,
        permission,
      );
    },
  );

  it('returns 401 when the subject is unauthenticated', async () => {
    await request(app.getHttpServer() as App)
      .get('/api/v1/platform-authorization-test/health')
      .expect(401);
  });

  it.each(['MEMBER', 'TEAM_LEADER', 'ADMIN'] as const)(
    'does not allow Organization role %s without an assignment',
    async (role) => {
      identity.roles = [role];
      await request(app.getHttpServer() as App)
        .get('/api/v1/platform-authorization-test/health')
        .set('Authorization', 'Bearer valid')
        .expect(403);
    },
  );

  it('does not allow forged display or request-header roles without an assignment', async () => {
    await request(app.getHttpServer() as App)
      .get('/api/v1/platform-authorization-test/health')
      .set('Authorization', 'Bearer valid')
      .set('X-Platform-Role', 'PLATFORM_OPERATOR')
      .set('X-Role', 'PLATFORM_OPERATOR')
      .expect(403);
  });

  it('returns 401 for an invalid or unverified access token', async () => {
    await request(app.getHttpServer() as App)
      .get('/api/v1/platform-authorization-test/health')
      .set('Authorization', 'Bearer forged')
      .expect(401);
  });

  it.each([
    [
      'wrong scope',
      assignment('platform.health.read', { scope: 'ORGANIZATION' }),
    ],
    [
      'revoked status',
      assignment('platform.health.read', { status: 'REVOKED' }),
    ],
    [
      'revocation timestamp',
      assignment('platform.health.read', { revokedAt: new Date() }),
    ],
    [
      'expired assignment',
      assignment('platform.health.read', {
        expiresAt: new Date(Date.now() - 1000),
      }),
    ],
    [
      'wrong subject',
      assignment('platform.health.read', {
        subjectUserId: 'cccccccccccccccccccccccc',
      }),
    ],
    ['self grant', assignment('platform.health.read', { grantedBy: userId })],
  ])('denies %s on fresh request evidence', async (_case, row) => {
    facts = { assignments: [row] };
    await request(app.getHttpServer() as App)
      .get('/api/v1/platform-authorization-test/health')
      .set('Authorization', 'Bearer valid')
      .expect(403);
  });

  it('fails closed when authorization evidence cannot be loaded', async () => {
    evidence.loadPlatformPermission.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await request(app.getHttpServer() as App)
      .get('/api/v1/platform-authorization-test/health')
      .set('Authorization', 'Bearer valid')
      .expect(403);
  });

  it('does not preserve a formerly valid authority after fresh evidence shows revocation', async () => {
    facts = { assignments: [assignment('platform.health.read')] };
    await request(app.getHttpServer() as App)
      .get('/api/v1/platform-authorization-test/health')
      .set('Authorization', 'Bearer valid')
      .expect(200);

    facts = {
      assignments: [
        assignment('platform.health.read', {
          status: 'REVOKED',
          revokedAt: new Date(),
        }),
      ],
    };
    await request(app.getHttpServer() as App)
      .get('/api/v1/platform-authorization-test/health')
      .set('Authorization', 'Bearer valid')
      .expect(403);
    expect(evidence.loadPlatformPermission).toHaveBeenCalledTimes(2);
  });

  it('does not turn Platform Operator display state into private Project access', () => {
    const policy = new AuthorizationPolicy();
    const organizationId = identity.organizationId;
    const projectId = 'dddddddddddddddddddddddd';
    const decision = policy.evaluateProjectAccess({
      permission: 'project.members.list',
      subject: { userId, organizationId, status: 'ACTIVE' },
      requestedOrganizationId: organizationId,
      requestedProjectId: projectId,
      project: { id: projectId, organizationId, status: 'ACTIVE' },
      membership: { userId, organizationId, status: 'ACTIVE' },
      projectMembership: {
        userId,
        organizationId,
        projectId,
        status: 'ACTIVE',
      },
      assignments: [],
      explicitDeny: 'CLEAR',
    });
    expect(decision.allowed).toBe(false);
  });
});
