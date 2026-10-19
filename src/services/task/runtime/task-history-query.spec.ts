import { Types } from 'mongoose';
import type {
  TaskCreationEventDocument,
  TaskDocument,
  TaskStatusTransitionEventDocument,
} from '../infrastructure/mongodb/task-contract';
import {
  TaskHistoryAccessAuthorizationBoundary,
  TaskHistoryQueryService,
  type TaskHistoryAccessEvidence,
  type TaskHistoryAccessEvidenceProvider,
} from './task-history-query';
import {
  TaskAuthorizationBoundary,
  type TaskAuthorizationResult,
} from './task-authorization-boundary';

const actorUserId = '0123456789abcdef01234567';
const organizationId = '1234567890abcdef12345678';
const projectId = 'abcdef0123456789abcdef01';
const taskId = 'fedcba9876543210fedcba98';

function resolvedAuthorization(): TaskAuthorizationResult {
  return {
    kind: 'authorized',
    operation: 'history',
    actorUserId,
    gatewayServiceId: 'svc:be-gateway',
    projectId,
    organizationId,
    requestId: 'd09-history-test',
  };
}

function accessEvidence(
  overrides: Partial<TaskHistoryAccessEvidence> = {},
): TaskHistoryAccessEvidence {
  return {
    actorUserId,
    organizationId,
    projectId,
    taskId,
    projectMembershipStatus: 'ACTIVE',
    taskReadPermission: true,
    principalKind: 'PROJECT_MEMBER',
    validHandoverAssignment: false,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    contextCandidate: 'verified-candidate',
    requestBinding: { method: 'GET', target: '/internal/tasks/events' },
    projectId,
    taskId,
    ...overrides,
  };
}

function historyRepository() {
  const projectObjectId = new Types.ObjectId(projectId);
  const taskObjectId = new Types.ObjectId(taskId);
  const task: TaskDocument = {
    _id: taskObjectId,
    projectId: projectObjectId,
    title: 'private title',
    createdBy: new Types.ObjectId(actorUserId),
    createdAt: new Date('2026-10-19T00:00:00.000Z'),
    updatedAt: new Date('2026-10-19T00:00:00.000Z'),
    status: 'IN_PROGRESS',
    assigneeId: null,
    completedAt: null,
    version: 2,
  };
  const creation: TaskCreationEventDocument & Record<string, unknown> = {
    _id: new Types.ObjectId('000000000000000000000001'),
    taskId: taskObjectId,
    projectId: projectObjectId,
    eventName: 'TASK_CREATED',
    actorType: 'USER',
    actorId: new Types.ObjectId(actorUserId),
    source: 'HUMAN',
    changedFields: [
      'projectId',
      'title',
      'createdBy',
      'createdAt',
      'updatedAt',
      'version',
    ],
    taskVersion: 1,
    occurredAt: new Date('2026-10-19T00:00:00.000Z'),
    operationId: '11111111-1111-4111-8111-111111111111',
    correlationId: 'internal-correlation',
    privateTaskField: 'must not escape',
  };
  const transition: TaskStatusTransitionEventDocument &
    Record<string, unknown> = {
    _id: new Types.ObjectId('000000000000000000000002'),
    taskId: taskObjectId,
    projectId: projectObjectId,
    actorId: new Types.ObjectId(actorUserId),
    actorType: 'USER',
    source: 'API',
    eventType: 'TASK_STATUS_TRANSITIONED',
    operationId: '22222222-2222-4222-8222-222222222222',
    correlationId: 'internal-correlation',
    timestamp: new Date('2026-10-19T00:01:00.000Z'),
    version: 2,
    changedFields: ['status'],
    delta: {
      type: 'STATUS_TRANSITION',
      fromStatus: 'TODO',
      toStatus: 'IN_PROGRESS',
      reason: 'free text must not escape',
    },
    privateTaskField: 'must not escape',
  };
  return {
    task,
    events: [creation, transition],
    getById: jest.fn().mockResolvedValue(task),
    listHistory: jest.fn().mockResolvedValue({
      events: [creation, transition],
      total: 2,
    }),
  };
}

function accessProvider(
  overrides: Partial<TaskHistoryAccessEvidenceProvider> = {},
): TaskHistoryAccessEvidenceProvider {
  return {
    resolve: jest
      .fn()
      .mockResolvedValue({ kind: 'resolved', evidence: accessEvidence() }),
    ...overrides,
  };
}

describe('TaskHistoryAccessAuthorizationBoundary', () => {
  it('allows only an active Project member with explicit Task read permission', async () => {
    const provider = accessProvider();
    const boundary = new TaskHistoryAccessAuthorizationBoundary(provider);

    await expect(
      boundary.authorize({ actorUserId, organizationId, projectId, taskId }),
    ).resolves.toEqual({ kind: 'allowed' });
    expect(provider.resolve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['revoked Project membership', { projectMembershipStatus: 'INACTIVE' }],
    ['unknown Project membership', { projectMembershipStatus: 'UNKNOWN' }],
    ['missing Task permission', { taskReadPermission: false }],
    [
      'Organization Admin without explicit Task access',
      {
        principalKind: 'ORGANIZATION_ADMIN',
        projectMembershipStatus: 'INACTIVE',
        taskReadPermission: false,
      },
    ],
    [
      'Platform Operator without explicit Task access',
      {
        principalKind: 'PLATFORM_OPERATOR',
        projectMembershipStatus: 'INACTIVE',
        taskReadPermission: false,
      },
    ],
  ] as const)('denies %s', async (_label, evidence) => {
    const boundary = new TaskHistoryAccessAuthorizationBoundary(
      accessProvider({
        resolve: jest.fn().mockResolvedValue({
          kind: 'resolved',
          evidence: accessEvidence(evidence),
        }),
      }),
    );

    await expect(
      boundary.authorize({ actorUserId, organizationId, projectId, taskId }),
    ).resolves.toMatchObject({ kind: 'denied' });
  });

  it('requires a current valid Handover assignment for a successor', async () => {
    const boundary = new TaskHistoryAccessAuthorizationBoundary(
      accessProvider({
        resolve: jest
          .fn()
          .mockResolvedValueOnce({
            kind: 'resolved',
            evidence: accessEvidence({
              principalKind: 'SUCCESSOR',
              validHandoverAssignment: false,
            }),
          })
          .mockResolvedValueOnce({
            kind: 'resolved',
            evidence: accessEvidence({
              principalKind: 'SUCCESSOR',
              validHandoverAssignment: true,
            }),
          }),
      }),
    );
    const requestValue = { actorUserId, organizationId, projectId, taskId };

    await expect(boundary.authorize(requestValue)).resolves.toMatchObject({
      kind: 'denied',
    });
    await expect(boundary.authorize(requestValue)).resolves.toEqual({
      kind: 'allowed',
    });
  });

  it('fails closed for mismatched or unavailable current-scope evidence', async () => {
    const mismatched = new TaskHistoryAccessAuthorizationBoundary(
      accessProvider({
        resolve: jest.fn().mockResolvedValue({
          kind: 'resolved',
          evidence: accessEvidence({ taskId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }),
        }),
      }),
    );
    const unavailable = new TaskHistoryAccessAuthorizationBoundary(
      accessProvider({
        resolve: jest.fn().mockResolvedValue({ kind: 'unavailable' }),
      }),
    );

    await expect(
      mismatched.authorize({ actorUserId, organizationId, projectId, taskId }),
    ).resolves.toMatchObject({ kind: 'denied' });
    await expect(
      unavailable.authorize({ actorUserId, organizationId, projectId, taskId }),
    ).resolves.toMatchObject({ kind: 'denied' });
  });
});

describe('TaskHistoryQueryService', () => {
  function createService() {
    const authResult = resolvedAuthorization();
    const taskAuthorizationBoundaryMock = {
      authorize: jest.fn().mockResolvedValue(authResult),
    };
    const evidenceProvider = accessProvider();
    const accessBoundary = new TaskHistoryAccessAuthorizationBoundary(
      evidenceProvider,
    );
    const repository = historyRepository();
    const service = new TaskHistoryQueryService(
      taskAuthorizationBoundaryMock as unknown as TaskAuthorizationBoundary,
      accessBoundary,
      repository,
    );
    return {
      service,
      taskAuthorizationBoundary: taskAuthorizationBoundaryMock,
      evidenceProvider,
      repository,
    };
  }

  it('normalizes only approved event fields into a versioned DTO', async () => {
    const { service } = createService();

    const result = await service.execute(request());

    expect(result).toEqual({
      kind: 'PAGE',
      page: {
        schemaVersion: 1,
        data: [
          {
            schemaVersion: 1,
            id: '000000000000000000000001',
            taskId,
            projectId,
            eventType: 'TASK_CREATED',
            actorId: actorUserId,
            actorType: 'USER',
            source: 'HUMAN',
            timestamp: '2026-10-19T00:00:00.000Z',
            version: 1,
            changedFields: [
              'projectId',
              'title',
              'createdBy',
              'createdAt',
              'updatedAt',
              'version',
            ],
          },
          {
            schemaVersion: 1,
            id: '000000000000000000000002',
            taskId,
            projectId,
            eventType: 'TASK_STATUS_TRANSITIONED',
            actorId: actorUserId,
            actorType: 'USER',
            source: 'API',
            timestamp: '2026-10-19T00:01:00.000Z',
            version: 2,
            changedFields: ['status'],
            delta: {
              type: 'STATUS_TRANSITION',
              fromStatus: 'TODO',
              toStatus: 'IN_PROGRESS',
            },
          },
        ],
        pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
      },
    });
    expect(JSON.stringify(result)).not.toContain('private title');
    expect(JSON.stringify(result)).not.toContain('free text must not escape');
    expect(JSON.stringify(result)).not.toContain('internal-correlation');
    expect(JSON.stringify(result)).not.toContain('must not escape');
  });

  it('fails closed when a persisted event variant is outside the D09 allowlist', async () => {
    const { service, repository } = createService();
    const unsupported = {
      ...repository.events[0],
      eventName: 'TASK_ASSIGNMENT_CHANGED',
      assigneeId: actorUserId,
    };
    repository.listHistory.mockResolvedValue({
      events: [unsupported] as unknown as typeof repository.events,
      total: 1,
    });

    await expect(service.execute(request())).resolves.toEqual({
      kind: 'INVALID_HISTORY_RECORD',
    });
  });

  it('uses default pagination and requires the history operation authorization', async () => {
    const { service, taskAuthorizationBoundary, repository } = createService();

    await service.execute(request());

    expect(taskAuthorizationBoundary.authorize).toHaveBeenCalledWith({
      operation: 'history',
      contextCandidate: 'verified-candidate',
      requestBinding: { method: 'GET', target: '/internal/tasks/events' },
      requestedProjectId: projectId,
      resourceId: taskId,
    });
    expect(repository.listHistory).toHaveBeenCalledWith(projectId, taskId, {
      page: 1,
      limit: 20,
    });
  });

  it('accepts the maximum page size of 100', async () => {
    const { service, repository } = createService();

    await service.execute(request({ limit: 100 }));

    expect(repository.listHistory).toHaveBeenCalledWith(projectId, taskId, {
      page: 1,
      limit: 100,
    });
  });

  it('rechecks access for every request and masks revoked membership as not found', async () => {
    const { service, evidenceProvider, repository } = createService();
    (evidenceProvider.resolve as jest.Mock)
      .mockResolvedValueOnce({ kind: 'resolved', evidence: accessEvidence() })
      .mockResolvedValueOnce({
        kind: 'resolved',
        evidence: accessEvidence({ projectMembershipStatus: 'INACTIVE' }),
      });

    await expect(service.execute(request())).resolves.toMatchObject({
      kind: 'PAGE',
    });
    await expect(service.execute(request())).resolves.toEqual({
      kind: 'NOT_FOUND',
    });
    expect(evidenceProvider.resolve).toHaveBeenCalledTimes(2);
    expect(repository.listHistory).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['zero page', { page: 0 }],
    ['fractional page', { page: 1.5 }],
    ['zero limit', { limit: 0 }],
    ['limit above maximum', { limit: 101 }],
  ])('rejects %s before authorization', async (_label, query) => {
    const { service, taskAuthorizationBoundary } = createService();

    await expect(service.execute(request(query))).resolves.toEqual({
      kind: 'INVALID_QUERY',
    });
    expect(taskAuthorizationBoundary.authorize).not.toHaveBeenCalled();
  });

  it('returns an empty page when page number is out of range', async () => {
    const { service, repository } = createService();
    repository.listHistory.mockResolvedValue({ events: [], total: 2 });

    await expect(
      service.execute(request({ page: 3, limit: 1 })),
    ).resolves.toMatchObject({
      kind: 'PAGE',
      page: {
        data: [],
        pagination: { page: 3, limit: 1, total: 2, totalPages: 2 },
      },
    });
  });

  it('returns 404-style not found for project, task, or operation denial', async () => {
    const { service, taskAuthorizationBoundary, repository } = createService();
    taskAuthorizationBoundary.authorize = jest.fn().mockResolvedValue({
      kind: 'denied',
      reason: 'PERMISSION_DENIED',
    });

    await expect(service.execute(request())).resolves.toEqual({
      kind: 'NOT_FOUND',
    });
    expect(repository.getById).not.toHaveBeenCalled();
  });
});
