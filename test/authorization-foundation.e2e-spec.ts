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
  const authentication = {
    getCurrentIdentity: jest.fn((authorization: string | undefined) => {
      if (authorization !== 'Bearer valid') throw new UnauthorizedException();
      return Promise.resolve({
        id: userId,
        email: 'user@example.test',
        name: 'User',
        organizationId: orgId,
        roles: ['ADMIN'],
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
      roleAssignments: [{ userId, organizationId: orgId, roleCode: 'ADMIN' }],
      grants: [],
      explicitDeny: 'CLEAR',
    };
    evidence.loadProjectCreate.mockClear();
  });

  afterAll(async () => app.close());

  it('returns 401 when no authenticated subject exists', async () => {
    await request(app.getHttpServer() as App)
      .get(`/api/v1/authorization-foundation-test/${orgId}`)
      .expect(401);
  });

  it('allows documented ADMIN permission with active membership and clear deny evidence', async () => {
    await request(app.getHttpServer() as App)
      .get(`/api/v1/authorization-foundation-test/${orgId}`)
      .set('Authorization', 'Bearer valid')
      .expect(200, { allowed: true });
  });

  it('allows a leader only when the grant has a future expiry', async () => {
    facts!.roleAssignments = [
      { userId, organizationId: orgId, roleCode: 'TEAM_LEADER' },
    ];
    facts!.grants = [
      {
        userId,
        organizationId: orgId,
        capability: 'project.create',
        expiresAt: null,
      },
    ];
    await request(app.getHttpServer() as App)
      .get(`/api/v1/authorization-foundation-test/${orgId}`)
      .set('Authorization', 'Bearer valid')
      .expect(403);

    facts!.grants = [
      {
        userId,
        organizationId: orgId,
        capability: 'project.create',
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];
    await request(app.getHttpServer() as App)
      .get(`/api/v1/authorization-foundation-test/${orgId}`)
      .set('Authorization', 'Bearer valid')
      .expect(200, { allowed: true });
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

  it('returns 403 for inactive membership, missing deny evidence, or project-scoped role', async () => {
    facts!.membership = { userId, organizationId: orgId, status: 'SUSPENDED' };
    await request(app.getHttpServer() as App)
      .get(`/api/v1/authorization-foundation-test/${orgId}`)
      .set('Authorization', 'Bearer valid')
      .expect(403);

    facts!.membership = { userId, organizationId: orgId, status: 'ACTIVE' };
    facts!.explicitDeny = 'UNKNOWN';
    await request(app.getHttpServer() as App)
      .get(`/api/v1/authorization-foundation-test/${orgId}`)
      .set('Authorization', 'Bearer valid')
      .expect(403);

    facts!.explicitDeny = 'CLEAR';
    facts!.roleAssignments = [
      {
        userId,
        organizationId: orgId,
        projectId: 'dddddddddddddddddddddddd',
        roleCode: 'ADMIN',
      },
    ];
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
