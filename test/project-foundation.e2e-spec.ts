import {
  INestApplication,
  NotFoundException,
  UnauthorizedException,
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
import { ProjectService } from '../src/services/iam/application/projects/project.service';
import { ProjectController } from '../src/services/iam/controllers/project.controller';

const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const orgId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const otherOrg = 'cccccccccccccccccccccccc';
const projectId = 'dddddddddddddddddddddddd';
const actor = {
  id: userId,
  organizationId: orgId,
  email: 'admin@example.test',
  name: 'Admin',
  roles: ['ADMIN'],
};

describe('Project Foundation HTTP contract', () => {
  let app: INestApplication;
  let facts: ProjectCreateEvidence;
  const auth = {
    getCurrentIdentity: jest.fn((authorization: string | undefined) => {
      if (authorization !== 'Bearer valid') throw new UnauthorizedException();
      return Promise.resolve(actor);
    }),
  };
  const evidence = { loadProjectCreate: jest.fn(() => Promise.resolve(facts)) };
  const projects = {
    create: jest
      .fn()
      .mockResolvedValue({ id: projectId, organizationId: orgId }),
    list: jest.fn().mockResolvedValue({
      data: [],
      pagination: {
        page: 1,
        pageSize: 20,
        totalItems: 0,
        totalPages: 0,
      },
    }),
    get: jest.fn().mockRejectedValue(
      new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      }),
    ),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ProjectController],
      providers: [
        ProjectCreateAuthorizationGuard,
        AuthorizationPolicy,
        { provide: AuthenticationApplicationService, useValue: auth },
        { provide: AUTHORIZATION_EVIDENCE_PROVIDER, useValue: evidence },
        { provide: ProjectService, useValue: projects },
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
    actor.roles = ['ADMIN'];
    jest.clearAllMocks();
  });

  afterAll(async () => app.close());

  it('returns 401 before create/list/detail without authentication', async () => {
    await request(app.getHttpServer() as App)
      .post('/api/v1/iam/projects')
      .send({ name: 'Example', code: 'EX' })
      .expect(401);
    await request(app.getHttpServer() as App)
      .get('/api/v1/iam/projects')
      .expect(401);
    await request(app.getHttpServer() as App)
      .get(`/api/v1/iam/projects/${projectId}`)
      .expect(401);
    expect(projects.create).not.toHaveBeenCalled();
  });

  it('allows an ACTIVE MEMBER to create without a role grant and validates payload', async () => {
    actor.roles = ['MEMBER'];
    await request(app.getHttpServer() as App)
      .post('/api/v1/iam/projects')
      .set('Authorization', 'Bearer valid')
      .send({ name: ' Example ', code: 'EX' })
      .expect(201);
    expect(projects.create).toHaveBeenCalledWith(actor, {
      name: 'Example',
      code: 'EX',
    });
    await request(app.getHttpServer() as App)
      .post('/api/v1/iam/projects')
      .set('Authorization', 'Bearer valid')
      .send({ name: 'Example', code: 'ex' })
      .expect(422);
    await request(app.getHttpServer() as App)
      .post('/api/v1/iam/projects')
      .set('Authorization', 'Bearer valid')
      .send({ name: 'Example', code: 'EX', organizationId: otherOrg })
      .expect(422);
  });

  it('rejects inactive membership and forged Organization header before mutation', async () => {
    facts.membership = { userId, organizationId: orgId, status: 'SUSPENDED' };
    await request(app.getHttpServer() as App)
      .post('/api/v1/iam/projects')
      .set('Authorization', 'Bearer valid')
      .send({ name: 'Example', code: 'EX' })
      .expect(403);
    facts.membership = { userId, organizationId: orgId, status: 'ACTIVE' };
    await request(app.getHttpServer() as App)
      .post('/api/v1/iam/projects')
      .set('Authorization', 'Bearer valid')
      .set('x-organization-id', otherOrg)
      .send({ name: 'Example', code: 'EX' })
      .expect(403);
    expect(projects.create).not.toHaveBeenCalled();
  });

  it('lists through the service and conceals unauthorized detail as 404', async () => {
    await request(app.getHttpServer() as App)
      .get('/api/v1/iam/projects')
      .set('Authorization', 'Bearer valid')
      .expect(200);
    expect(projects.list).toHaveBeenCalledWith(actor, {
      page: 1,
      pageSize: 20,
    });
    await request(app.getHttpServer() as App)
      .get(`/api/v1/iam/projects/${projectId}`)
      .set('Authorization', 'Bearer valid')
      .expect(404);
  });
});
