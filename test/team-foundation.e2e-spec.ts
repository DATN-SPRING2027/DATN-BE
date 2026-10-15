import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../src/bootstrap';
import { AuthenticationApplicationService } from '../src/services/iam/application/authentication/authentication.application.service';
import { TeamService } from '../src/services/iam/application/teams/team.service';
import { TeamFoundationController } from '../src/services/iam/controllers/team-foundation.controller';
import type {
  TeamCommandResult,
  TeamListResult,
  TeamRecord,
} from '../src/services/iam/application/teams/team.repository';

const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const organizationId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const projectId = 'cccccccccccccccccccccccc';
const teamId = 'dddddddddddddddddddddddd';
const actor = {
  id: userId,
  organizationId,
  email: 'leader@example.test',
  name: 'Project Leader',
  roles: ['TEAM_LEADER'],
};
const team: TeamRecord = {
  id: teamId,
  organizationId,
  projectId,
  name: 'Operations',
  code: 'OPS',
  description: null,
  status: 'ACTIVE',
  version: 2,
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
  archivedAt: null,
  archivedBy: null,
};
const createdTeam: TeamRecord = { ...team, version: 1 };

function commandResult(
  overrides: Partial<TeamCommandResult> = {},
): TeamCommandResult {
  return {
    statusCode: 200,
    team,
    etag: `"team:${teamId}:${team.version}"`,
    replayed: false,
    ...overrides,
  };
}

describe('Team Foundation HTTP contract', () => {
  let app: INestApplication;
  const auth = {
    getCurrentIdentity: jest.fn((authorization: string | undefined) => {
      if (authorization !== 'Bearer valid') throw new UnauthorizedException();
      return Promise.resolve(actor);
    }),
  };
  const teams = {
    create: jest.fn(),
    update: jest.fn(),
    list: jest.fn(),
    get: jest.fn(),
    archive: jest.fn(),
    restore: jest.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TeamFoundationController],
      providers: [
        { provide: AuthenticationApplicationService, useValue: auth },
        { provide: TeamService, useValue: teams },
      ],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    teams.create.mockResolvedValue(
      commandResult({
        statusCode: 201,
        team: createdTeam,
        etag: `"team:${teamId}:1"`,
        location: `/api/v1/iam/teams/${teamId}`,
      }),
    );
    teams.update.mockResolvedValue(commandResult({ replayed: true }));
    teams.list.mockResolvedValue({
      data: [team],
      pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
    });
    teams.get.mockResolvedValue(team);
    teams.archive.mockResolvedValue(
      commandResult({
        team: {
          ...team,
          status: 'ARCHIVED',
          version: 3,
          archivedAt: '2026-10-15T00:01:00.000Z',
          archivedBy: userId,
        },
        etag: `"team:${teamId}:3"`,
      }),
    );
    teams.restore.mockResolvedValue(
      commandResult({
        team: { ...team, version: 4 },
        etag: `"team:${teamId}:4"`,
        replayed: false,
      }),
    );
  });

  afterAll(async () => app.close());

  const writeHeaders = <T extends { set(name: string, value: string): T }>(
    builder: T,
    idempotencyKey = 'team-command-1',
  ): T =>
    builder
      .set('Authorization', 'Bearer valid')
      .set('Cookie', '__Host-csrf=csrf-token')
      .set('X-CSRF-Token', 'csrf-token')
      .set('X-Organization-Id', organizationId)
      .set('Idempotency-Key', idempotencyKey);

  it('creates a Team over HTTP with normalized input and contract headers', async () => {
    await writeHeaders(
      request(app.getHttpServer() as App)
        .post(`/api/v1/iam/projects/${projectId}/teams`)
        .send({ name: ' Operations ', code: 'ops' }),
    )
      .expect(201)
      .expect('Cache-Control', 'no-store')
      .expect('ETag', `"team:${teamId}:1"`)
      .expect('Location', `/api/v1/iam/teams/${teamId}`)
      .expect(({ body }) => expect(body).toEqual(createdTeam));
    expect(teams.create).toHaveBeenCalledWith(
      actor,
      projectId,
      { name: 'Operations', code: 'OPS', description: null },
      'team-command-1',
    );
  });

  it('updates with If-Match and reports an authorized idempotent replay', async () => {
    await writeHeaders(
      request(app.getHttpServer() as App)
        .patch(`/api/v1/iam/teams/${teamId}`)
        .set('If-Match', `"team:${teamId}:1"`)
        .send({ description: null }),
    )
      .expect(200)
      .expect('Cache-Control', 'no-store')
      .expect('ETag', `"team:${teamId}:2"`)
      .expect('Idempotency-Replayed', 'true');
    expect(teams.update).toHaveBeenCalledWith(
      actor,
      teamId,
      { description: null },
      'team-command-1',
      `"team:${teamId}:1"`,
    );
  });

  it('lists and reads detail with pagination, no aggregate ETag, and a detail ETag', async () => {
    const list = await request(app.getHttpServer() as App)
      .get(`/api/v1/iam/projects/${projectId}/teams`)
      .set('Authorization', 'Bearer valid')
      .set('X-Organization-Id', organizationId)
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect((list.body as TeamListResult).pagination).toEqual({
      page: 1,
      pageSize: 20,
      totalItems: 1,
      totalPages: 1,
    });
    expect(list.headers.etag).toBeUndefined();
    expect(teams.list).toHaveBeenCalledWith(actor, projectId, {
      page: 1,
      pageSize: 20,
      status: 'ACTIVE',
    });

    await request(app.getHttpServer() as App)
      .get(`/api/v1/iam/teams/${teamId}`)
      .set('Authorization', 'Bearer valid')
      .set('X-Organization-Id', organizationId)
      .expect(200)
      .expect('ETag', `"team:${teamId}:2"`)
      .expect('Cache-Control', 'no-store');
  });

  it('archives and restores with reason, idempotency key, and version precondition', async () => {
    await writeHeaders(
      request(app.getHttpServer() as App)
        .post(`/api/v1/iam/teams/${teamId}/archive`)
        .set('If-Match', `"team:${teamId}:2"`)
        .send({ reason: ' finished ' }),
    )
      .expect(200)
      .expect('ETag', `"team:${teamId}:3"`);
    await writeHeaders(
      request(app.getHttpServer() as App)
        .post(`/api/v1/iam/teams/${teamId}/restore`)
        .set('If-Match', `"team:${teamId}:3"`)
        .send({ reason: 'reopened' }),
      'restore-command-1',
    )
      .expect(200)
      .expect('ETag', `"team:${teamId}:4"`);
    expect(teams.archive).toHaveBeenCalledWith(
      actor,
      teamId,
      { reason: 'finished' },
      'team-command-1',
      `"team:${teamId}:2"`,
    );
    expect(teams.restore).toHaveBeenCalledWith(
      actor,
      teamId,
      { reason: 'reopened' },
      'restore-command-1',
      `"team:${teamId}:3"`,
    );
  });

  it('rejects missing auth, invalid CSRF, and invalid list queries with shared errors', async () => {
    await request(app.getHttpServer() as App)
      .get(`/api/v1/iam/projects/${projectId}/teams`)
      .expect(401);

    const csrf = await request(app.getHttpServer() as App)
      .post(`/api/v1/iam/projects/${projectId}/teams`)
      .set('Authorization', 'Bearer valid')
      .set('Cookie', '__Host-csrf=one')
      .set('X-CSRF-Token', 'two')
      .send({ name: 'Operations', code: 'OPS' })
      .expect(403);
    expect(csrf.body).toMatchObject({ code: 'AUTH_CSRF_INVALID' });

    const invalid = await request(app.getHttpServer() as App)
      .get(`/api/v1/iam/projects/${projectId}/teams?page=0`)
      .set('Authorization', 'Bearer valid')
      .set('X-Organization-Id', organizationId)
      .expect(422);
    expect(invalid.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(teams.create).not.toHaveBeenCalled();
    expect(teams.list).not.toHaveBeenCalled();
  });
});
