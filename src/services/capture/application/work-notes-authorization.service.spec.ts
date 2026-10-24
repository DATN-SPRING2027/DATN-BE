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
      get: () => 2_000,
    } as unknown as ConfigService);
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => fetchSpy.mockRestore());

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

  it('denies an unprivileged member a task from another Project', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        response({ id: userId, organizationId, name: 'Mina Member' }),
      )
      .mockResolvedValueOnce(response({ id: projectId, organizationId }))
      .mockResolvedValueOnce(response({}, 403))
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

  it('fails closed if project authorization cannot reach IAM', async () => {
    fetchSpy.mockRejectedValue(new Error('connection refused'));
    await expect(service.resolveProject({}, projectId)).rejects.toMatchObject({
      status: 503,
    });
  });
});
