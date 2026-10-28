import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { WorkNotesAuthorizationService } from './work-notes-authorization.service';

describe('WorkNotesAuthorizationService', () => {
  const userId = new Types.ObjectId().toHexString();
  const organizationId = new Types.ObjectId().toHexString();
  const projectId = new Types.ObjectId().toHexString();
  const taskId = new Types.ObjectId().toHexString();
  let service: WorkNotesAuthorizationService;
  let fetchSpy: jest.SpyInstance;

  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  beforeEach(() => {
    service = new WorkNotesAuthorizationService({
      getOrThrow: () => 'http://iam.internal',
      get: (key: string) =>
        key === 'BACKEND_TIMEOUT_MS' ? 2_000 : 'http://task.internal',
    } as unknown as ConfigService);
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => fetchSpy.mockRestore());

  const scopedTaskResponse = (patch: Record<string, unknown> = {}) => {
    fetchSpy
      .mockResolvedValueOnce(
        response({ id: userId, organizationId, name: 'Author' }),
      )
      .mockResolvedValueOnce(
        response({ id: projectId, organizationId, status: 'ACTIVE' }),
      )
      .mockResolvedValueOnce(response({ canUpdateProject: true }))
      .mockResolvedValueOnce(
        response({
          id: taskId,
          projectId,
          title: 'Existing task',
          description: null,
          status: 'DONE',
          version: 4,
          steps: [],
          ...patch,
        }),
      );
  };

  it.each([
    ['description object', { description: { text: 'lost by projection' } }],
    ['description number', { description: 42 }],
    ['non-string status', { status: 42 }],
    ['blank status', { status: '  ' }],
    ['nonpositive version', { version: 0 }],
    ['fractional version', { version: 1.5 }],
    ['string version', { version: '4' }],
    ['null version', { version: null }],
  ])(
    'marks malformed Task %s as an acquisition error instead of missing authored requirements',
    async (_label, patch) => {
      scopedTaskResponse(patch);
      const actor = await service.resolveTask({}, projectId, taskId);
      expect(actor.taskContextInvalid).toBe(true);
      if (Object.hasOwn(patch, 'version'))
        expect(actor.taskContextVersion).toBeUndefined();
    },
  );

  it('keeps a genuinely sparse authored task valid and preserves the current Task version', async () => {
    scopedTaskResponse();
    expect(await service.resolveTask({}, projectId, taskId)).toMatchObject({
      taskContextInvalid: false,
      taskContextVersion: '4',
      taskContext: {
        title: 'Existing task',
        description: null,
        status: 'DONE',
        steps: [],
      },
    });
  });

  it('resolves Project access and review permission from IAM using the caller session', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        response({ id: userId, organizationId, name: 'Mina Member' }),
      )
      .mockResolvedValueOnce(response({ id: projectId, organizationId }))
      .mockResolvedValueOnce(response({ canUpdateProject: true }));

    const actor = await service.resolveProject(
      {
        authorization: 'Bearer session-proof',
        cookie: '__Host-session=session-proof',
        organizationId,
        requestId: 'request-1',
      },
      projectId,
    );

    expect(actor).toMatchObject({
      userId,
      organizationId,
      projectId,
      canReview: true,
      canConfigure: true,
    });
    const firstCall = fetchSpy.mock.calls[0] as unknown as [
      unknown,
      RequestInit | undefined,
    ];
    const firstRequest = firstCall?.[1] ?? {};
    expect(new Headers(firstRequest.headers).get('authorization')).toBe(
      'Bearer session-proof',
    );
    expect(new Headers(firstRequest.headers).get('cookie')).toBe(
      '__Host-session=session-proof',
    );
    expect(new Headers(firstRequest.headers).get('x-organization-id')).toBe(
      organizationId,
    );
  });

  it('denies Project access when the selected organization scope does not match', async () => {
    fetchSpy.mockResolvedValueOnce(
      response({ id: userId, organizationId, name: 'Mina Member' }),
    );
    await expect(
      service.resolveProject(
        { organizationId: new Types.ObjectId().toHexString() },
        projectId,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('allows a current Organization Manager to review an active Project without Project membership', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        response({
          id: userId,
          organizationId,
          name: 'Manager',
          roles: ['ADMIN'],
        }),
      )
      .mockResolvedValueOnce(
        response({
          id: projectId,
          organizationId,
          status: 'ACTIVE',
          createdAt: '2026-10-01T00:00:00.000Z',
        }),
      )
      .mockResolvedValueOnce(response({}, 403));

    await expect(
      service.resolveProject({ organizationId }, projectId),
    ).resolves.toMatchObject({
      userId,
      organizationId,
      projectId,
      isManager: true,
      isLeader: false,
      canReview: true,
    });
    expect(
      fetchSpy.mock.calls.some(([url]) => String(url).includes('/memberships')),
    ).toBe(false);
  });

  it('does not extend Manager review authority to another Organization', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        response({
          id: userId,
          organizationId,
          name: 'Manager',
          roles: ['ADMIN'],
        }),
      )
      .mockResolvedValueOnce(
        response({
          id: projectId,
          organizationId: new Types.ObjectId().toHexString(),
          status: 'ACTIVE',
        }),
      );
    await expect(service.resolveProject({}, projectId)).rejects.toMatchObject({
      status: 404,
      response: { code: 'PROJECT_NOT_FOUND' },
    });
  });

  it('denies an unprivileged member a task from another Project', async () => {
    const joinedAt = '2026-10-20T00:00:00.000Z';
    fetchSpy
      .mockResolvedValueOnce(
        response({ id: userId, organizationId, name: 'Mina Member' }),
      )
      .mockResolvedValueOnce(
        response({ id: projectId, organizationId, status: 'ACTIVE' }),
      )
      .mockResolvedValueOnce(response({}, 403))
      .mockResolvedValueOnce(
        response({
          data: [{ userId, joinedAt }],
          pagination: { totalPages: 1 },
        }),
      )
      .mockResolvedValueOnce(
        response({
          id: taskId,
          projectId: new Types.ObjectId().toHexString(),
        }),
      );

    await expect(
      service.resolveTask({}, projectId, taskId),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('resolves existing Tasks through the configured Task service route and preserves member joinedAt', async () => {
    const joinedAt = '2026-10-20T00:00:00.000Z';
    fetchSpy
      .mockResolvedValueOnce(
        response({ id: userId, organizationId, name: 'Mina Member' }),
      )
      .mockResolvedValueOnce(
        response({ id: projectId, organizationId, status: 'ACTIVE' }),
      )
      .mockResolvedValueOnce(response({}, 403))
      .mockResolvedValueOnce(
        response({
          data: [{ userId, joinedAt }],
          pagination: { totalPages: 1 },
        }),
      )
      .mockResolvedValueOnce(
        response({
          id: taskId,
          projectId,
          key: 'FE-12',
          title: 'Authentication & session handling',
        }),
      );

    const actor = await service.resolveTask({}, projectId, taskId);

    expect(actor).toMatchObject({
      userId,
      organizationId,
      projectId,
      canReview: false,
      joinedAt,
      taskKey: 'FE-12',
      taskTitle: 'Authentication & session handling',
    });
    const taskCall = fetchSpy.mock.calls[4] as unknown as
      [unknown, RequestInit | undefined] | undefined;
    expect(String(taskCall?.[0])).toBe(
      `http://task.internal/internal/tasks/projects/${projectId}/tasks/${taskId}`,
    );
  });

  it('uses the versioned Task route when the modular monolith is the Task fallback', async () => {
    const joinedAt = '2026-10-20T00:00:00.000Z';
    service = new WorkNotesAuthorizationService({
      getOrThrow: (key: string) =>
        key === 'IAM_SERVICE_URL' ? 'http://monolith.internal' : undefined,
      get: (key: string) => (key === 'BACKEND_TIMEOUT_MS' ? 2_000 : undefined),
    } as unknown as ConfigService);
    fetchSpy
      .mockResolvedValueOnce(
        response({ id: userId, organizationId, name: 'Mina Member' }),
      )
      .mockResolvedValueOnce(
        response({ id: projectId, organizationId, status: 'ACTIVE' }),
      )
      .mockResolvedValueOnce(response({}, 403))
      .mockResolvedValueOnce(
        response({
          data: [{ userId, joinedAt }],
          pagination: { totalPages: 1 },
        }),
      )
      .mockResolvedValueOnce(response({ id: taskId, projectId }));

    await service.resolveTask({}, projectId, taskId);

    const taskCall = fetchSpy.mock.calls[4] as unknown as
      [unknown, RequestInit | undefined] | undefined;
    expect(String(taskCall?.[0])).toBe(
      `http://monolith.internal/api/v1/internal/tasks/projects/${projectId}/tasks/${taskId}`,
    );
  });

  it('denies non-members without review authority and ARCHIVED projects', async () => {
    // 1. Non-member of PUBLIC project: /projects/:id returns 200, /memberships returns 403
    fetchSpy
      .mockResolvedValueOnce(
        response({ id: userId, organizationId, name: 'Outsider' }),
      )
      .mockResolvedValueOnce(
        response({
          id: projectId,
          organizationId,
          visibility: 'PUBLIC',
          status: 'ACTIVE',
        }),
      )
      .mockResolvedValueOnce(response({}, 403))
      .mockResolvedValueOnce(response({}, 403));

    await expect(service.resolveProject({}, projectId)).rejects.toMatchObject({
      status: 404,
      response: { code: 'PROJECT_NOT_FOUND' },
    });

    // 2. An identity without current ADMIN or Project Leader authority is not
    // admitted merely because the directory endpoint can return other members.
    fetchSpy
      .mockResolvedValueOnce(
        response({
          id: userId,
          organizationId,
          name: 'Member',
          roles: ['MEMBER'],
        }),
      )
      .mockResolvedValueOnce(
        response({
          id: projectId,
          organizationId,
          visibility: 'PRIVATE',
          status: 'ACTIVE',
        }),
      )
      .mockResolvedValueOnce(response({}, 403))
      .mockResolvedValueOnce(
        response({
          data: [
            {
              userId: new Types.ObjectId().toHexString(),
              joinedAt: '2026-10-20T00:00:00.000Z',
            },
          ],
          pagination: { totalPages: 1 },
        }),
      );

    await expect(service.resolveProject({}, projectId)).rejects.toMatchObject({
      status: 404,
      response: { code: 'PROJECT_NOT_FOUND' },
    });

    // 3. ARCHIVED project: rejected immediately with 404
    fetchSpy
      .mockResolvedValueOnce(
        response({ id: userId, organizationId, name: 'Mina Member' }),
      )
      .mockResolvedValueOnce(
        response({
          id: projectId,
          organizationId,
          status: 'ARCHIVED',
        }),
      );

    await expect(service.resolveProject({}, projectId)).rejects.toMatchObject({
      status: 404,
      response: { code: 'PROJECT_NOT_FOUND' },
    });
  });

  it('fails closed if project authorization cannot reach IAM', async () => {
    fetchSpy.mockRejectedValue(new Error('connection refused'));
    await expect(service.resolveProject({}, projectId)).rejects.toMatchObject({
      status: 503,
    });
  });
});
