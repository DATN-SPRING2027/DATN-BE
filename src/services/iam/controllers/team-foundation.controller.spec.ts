import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedIdentity } from '../application/authentication/authentication.application.service';
import type { TeamService } from '../application/teams/team.service';
import type {
  TeamCommandResult,
  TeamRecord,
} from '../application/teams/team.repository';
import { TeamFoundationController } from './team-foundation.controller';

const actor = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  organizationId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
} as AuthenticatedIdentity;
const projectId = 'cccccccccccccccccccccccc';
const team: TeamRecord = {
  id: 'dddddddddddddddddddddddd',
  organizationId: actor.organizationId,
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

function commandResult(
  overrides: Partial<TeamCommandResult> = {},
): TeamCommandResult {
  return {
    statusCode: 200,
    team,
    etag: `"team:${team.id}:${team.version}"`,
    replayed: false,
    ...overrides,
  };
}

function responseFixture() {
  return {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
  };
}

describe('TeamFoundationController', () => {
  const auth = {
    getCurrentIdentity: jest.fn().mockResolvedValue(actor),
  };
  const teams = {
    create: jest.fn(),
    update: jest.fn(),
    list: jest.fn(),
    get: jest.fn(),
    archive: jest.fn(),
    restore: jest.fn(),
  };
  const controller = new TeamFoundationController(
    auth as never,
    teams as unknown as TeamService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a Team with no-store, the normalized body, ETag, and Location', async () => {
    teams.create.mockResolvedValue(
      commandResult({
        statusCode: 201,
        location: `/api/v1/iam/teams/${team.id}`,
      }),
    );
    const response = responseFixture();
    const result = await controller.create(
      'Bearer token',
      '__Host-csrf=csrf-token',
      'csrf-token',
      actor.organizationId,
      'create:1',
      projectId,
      { name: ' Operations ', code: 'ops', description: null },
      response as never,
    );

    expect(result).toEqual(team);
    expect(teams.create).toHaveBeenCalledWith(
      actor,
      projectId,
      { name: 'Operations', code: 'OPS', description: null },
      'create:1',
    );
    expect(response.status).toHaveBeenCalledWith(201);
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'ETag',
      `"team:${team.id}:2"`,
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Location',
      `/api/v1/iam/teams/${team.id}`,
    );
    expect(response.setHeader).not.toHaveBeenCalledWith(
      'Idempotency-Replayed',
      expect.anything(),
    );
  });

  it('requires the current CSRF cookie/header pair for writes', async () => {
    const response = responseFixture();
    await expect(
      controller.create(
        'Bearer token',
        '__Host-csrf=expected',
        'different',
        actor.organizationId,
        'create:1',
        projectId,
        { name: 'Operations', code: 'OPS' },
        response as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
    expect(teams.create).not.toHaveBeenCalled();
  });

  it('passes update concurrency headers and marks only an authorized replay', async () => {
    teams.update.mockResolvedValue(commandResult({ replayed: true }));
    const response = responseFixture();
    await controller.update(
      'Bearer token',
      '__Host-csrf=csrf-token',
      'csrf-token',
      actor.organizationId,
      'update:1',
      `"team:${team.id}:1"`,
      team.id,
      { description: null },
      response as never,
    );

    expect(teams.update).toHaveBeenCalledWith(
      actor,
      team.id,
      { description: null },
      'update:1',
      `"team:${team.id}:1"`,
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Idempotency-Replayed',
      'true',
    );
    expect(response.setHeader).not.toHaveBeenCalledWith(
      'Location',
      expect.anything(),
    );
  });

  it('returns a paginated list without an aggregate ETag', async () => {
    const listResult = {
      data: [team],
      pagination: { page: 2, pageSize: 10, totalItems: 21, totalPages: 3 },
    };
    teams.list.mockResolvedValue(listResult);
    const response = responseFixture();
    await controller.list(
      'Bearer token',
      undefined,
      actor.organizationId,
      projectId,
      { page: '2', pageSize: '10', status: 'ARCHIVED' },
      response as never,
    );
    expect(teams.list).toHaveBeenCalledWith(actor, projectId, {
      page: 2,
      pageSize: 10,
      status: 'ARCHIVED',
    });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.type).toHaveBeenCalledWith('application/json');
    expect(response.end).toHaveBeenCalledWith(JSON.stringify(listResult));
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
    expect(response.setHeader).not.toHaveBeenCalledWith(
      'ETag',
      expect.anything(),
    );
  });

  it('returns Team detail with a strong resource ETag', async () => {
    teams.get.mockResolvedValue(team);
    const response = responseFixture();
    const result = await controller.get(
      'Bearer token',
      undefined,
      actor.organizationId,
      team.id,
      {},
      response as never,
    );
    expect(result).toEqual(team);
    expect(response.setHeader).toHaveBeenCalledWith(
      'ETag',
      `"team:${team.id}:${team.version}"`,
    );
  });

  it('routes archive and restore commands with reason, key, and If-Match', async () => {
    teams.archive.mockResolvedValue(commandResult());
    teams.restore.mockResolvedValue(commandResult());
    const archiveResponse = responseFixture();
    const restoreResponse = responseFixture();
    const headers = [
      'Bearer token',
      '__Host-csrf=csrf-token',
      'csrf-token',
      actor.organizationId,
      'lifecycle:1',
      `"team:${team.id}:2"`,
      team.id,
      { reason: '  retired  ' },
    ] as const;
    await controller.archive(...headers, archiveResponse as never);
    await controller.restore(...headers, restoreResponse as never);

    expect(teams.archive).toHaveBeenCalledWith(
      actor,
      team.id,
      { reason: 'retired' },
      'lifecycle:1',
      `"team:${team.id}:2"`,
    );
    expect(teams.restore).toHaveBeenCalledWith(
      actor,
      team.id,
      { reason: 'retired' },
      'lifecycle:1',
      `"team:${team.id}:2"`,
    );
  });
});
