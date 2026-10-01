import {
  Controller,
  Get,
  INestApplication,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { configureApplication } from '../src/bootstrap';
import { AuthenticationApplicationService } from '../src/services/iam/application/authentication/authentication.application.service';
import {
  AUTHORIZATION_EVIDENCE_PROVIDER,
  type ProjectCreateEvidence,
} from '../src/services/iam/application/authorization/authorization-evidence.provider';
import { AuthorizationPolicy } from '../src/services/iam/application/authorization/authorization.policy';
import { ProjectCreateAuthorizationGuard } from '../src/services/iam/application/authorization/project-create-authorization.guard';

const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const orgId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const otherOrgId = 'cccccccccccccccccccccccc';

@Controller('authorization-foundation-test')
class AuthorizationHarnessController {
  @Get(':organizationId')
  @UseGuards(ProjectCreateAuthorizationGuard)
  check() {
    return { allowed: true };
  }
}

describe('Authorization foundation guard (isolated HTTP harness)', () => {
  let app: INestApplication;
  let facts: ProjectCreateEvidence | null;
  let authenticatedRole = 'ADMIN';
  const authentication = {
    getCurrentIdentity: jest.fn((authorization: string | undefined) => {
      if (authorization !== 'Bearer valid') throw new UnauthorizedException();
      return Promise.resolve({
        id: userId,
        email: 'user@example.test',
        name: 'User',
        organizationId: orgId,
        roles: [authenticatedRole],
      });
    }),
  };
  const evidence = {
    loadProjectCreate: jest.fn(() => Promise.resolve(facts)),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AuthorizationHarnessController],
      providers: [
        ProjectCreateAuthorizationGuard,
        AuthorizationPolicy,
        { provide: AuthenticationApplicationService, useValue: authentication },
        { provide: AUTHORIZATION_EVIDENCE_PROVIDER, useValue: evidence },
      ],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  beforeEach(() => {
    facts = {
      membership: { userId, organizationId: orgId, status: 'ACTIVE' },
      explicitDeny: 'CLEAR',
    };
    authenticatedRole = 'ADMIN';
    evidence.loadProjectCreate.mockClear();
  });

  afterAll(async () => app.close());

  it('returns 401 when no authenticated subject exists', async () => {
    await request(app.getHttpServer() as App)
      .get(`/api/v1/authorization-foundation-test/${orgId}`)
      .expect(401);
  });

  it.each(['MEMBER', 'TEAM_LEADER', 'ADMIN'])(
    'allows an ACTIVE %s without a role assignment or project.create grant',
    async (role) => {
      authenticatedRole = role;
      await request(app.getHttpServer() as App)
        .get(`/api/v1/authorization-foundation-test/${orgId}`)
        .set('Authorization', 'Bearer valid')
        .expect(200, { allowed: true });
    },
  );

  it('returns 403 when the user has no ACTIVE Organization Membership', async () => {
    facts!.membership = null;
    await request(app.getHttpServer() as App)
      .get(`/api/v1/authorization-foundation-test/${orgId}`)
      .set('Authorization', 'Bearer valid')
      .expect(403);
  });

  it('returns 403 for cross-organization selector even if the token says ADMIN', async () => {
    await request(app.getHttpServer() as App)
      .get(`/api/v1/authorization-foundation-test/${otherOrgId}`)
      .set('Authorization', 'Bearer valid')
      .expect(403);
    expect(evidence.loadProjectCreate).not.toHaveBeenCalled();
  });

  it('rejects an organization selector supplied in the query even when the route uses the trusted organization', async () => {
    await request(app.getHttpServer() as App)
      .get(`/api/v1/authorization-foundation-test/${orgId}`)
      .query({ organizationId: otherOrgId })
      .set('Authorization', 'Bearer valid')
      .expect(403);
    expect(evidence.loadProjectCreate).not.toHaveBeenCalled();
  });

  it('rejects an organization selector supplied in the header', async () => {
    await request(app.getHttpServer() as App)
      .get(`/api/v1/authorization-foundation-test/${orgId}`)
      .set('Authorization', 'Bearer valid')
      .set('x-organization-id', otherOrgId)
      .expect(403);
    expect(evidence.loadProjectCreate).not.toHaveBeenCalled();
  });

  it.each(['PENDING_INVITE', 'SUSPENDED', 'REMOVED'])(
    'returns 403 for %s Organization Membership',
    async (status) => {
      facts!.membership = { userId, organizationId: orgId, status };
      await request(app.getHttpServer() as App)
        .get(`/api/v1/authorization-foundation-test/${orgId}`)
        .set('Authorization', 'Bearer valid')
        .expect(403);
    },
  );

  it('returns 403 when membership evidence belongs to another Organization', async () => {
    facts!.membership = {
      userId,
      organizationId: otherOrgId,
      status: 'ACTIVE',
    };
    await request(app.getHttpServer() as App)
      .get(`/api/v1/authorization-foundation-test/${orgId}`)
      .set('Authorization', 'Bearer valid')
      .expect(403);
  });

  it('returns 403 when deny evidence is unknown', async () => {
    facts!.explicitDeny = 'UNKNOWN';
    await request(app.getHttpServer() as App)
      .get(`/api/v1/authorization-foundation-test/${orgId}`)
      .set('Authorization', 'Bearer valid')
      .expect(403);
  });

  it('returns 403 if the authorization evidence provider fails', async () => {
    evidence.loadProjectCreate.mockRejectedValueOnce(new Error('unavailable'));
    await request(app.getHttpServer() as App)
      .get(`/api/v1/authorization-foundation-test/${orgId}`)
      .set('Authorization', 'Bearer valid')
      .expect(403);
  });
});
