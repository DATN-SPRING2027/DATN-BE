import {
  TaskLifecycleCommandService,
  type TaskLifecycleCommandPersistence,
} from './task-lifecycle-command';
import type {
  TaskLifecycleCommandResult,
  TaskLifecycleDecisionFunction,
  TaskLifecyclePersistenceRequest,
} from './task-lifecycle-policy';

const actorId = '712020000000000000000001';
const projectId = '712020000000000000000002';
const taskId = '712020000000000000000003';
const operationId = 'a1202000-0000-4000-8000-000000000001';

function validContext(overrides: Record<string, unknown> = {}) {
  return {
    actorId,
    projectId,
    projectRole: 'TEAM_LEADER',
    projectMembershipStatus: 'ACTIVE',
    organizationMembershipStatus: 'ACTIVE',
    source: 'INTERNAL_SERVICE',
    requestId: 'task-lifecycle-request-1',
    ...overrides,
  };
}

function validCommand(overrides: Record<string, unknown> = {}) {
  return {
    taskId,
    targetStatus: 'IN_PROGRESS',
    expectedVersion: 1,
    operationId,
    ...overrides,
  };
}

function committed(): TaskLifecycleCommandResult {
  return {
    kind: 'COMMITTED',
    status: 'IN_PROGRESS',
    version: 2,
    completedAt: null,
    updatedAt: new Date('2026-10-19T10:00:00Z'),
    replayed: false,
    reconciled: false,
  };
}

function setup() {
  const transitionStatus = jest.fn<
    Promise<TaskLifecycleCommandResult>,
    [TaskLifecyclePersistenceRequest, TaskLifecycleDecisionFunction]
  >();
  transitionStatus.mockResolvedValue(committed());
  const persistence: TaskLifecycleCommandPersistence = { transitionStatus };
  return {
    transitionStatus,
    service: new TaskLifecycleCommandService(
      persistence,
      () => new Date('2026-10-19T10:00:00Z'),
    ),
  };
}

describe('TaskLifecycleCommandService', () => {
  it('parses strict command/context inputs and passes a canonical command to persistence', async () => {
    const { service, transitionStatus } = setup();

    const result = await service.execute(
      validContext(),
      validCommand({
        operationId: operationId.toUpperCase(),
        reason: '  start work  ',
      }),
    );

    expect(result).toEqual(committed());
    expect(transitionStatus).toHaveBeenCalledTimes(1);
    const [request] = transitionStatus.mock.calls[0];
    expect(request.context.actorId.toHexString()).toBe(actorId);
    expect(request.context).toMatchObject({
      projectRole: 'TEAM_LEADER',
      source: 'INTERNAL_SERVICE',
      correlationId: 'task-lifecycle-request-1',
    });
    expect(request.command).toMatchObject({
      targetStatus: 'IN_PROGRESS',
      expectedVersion: 1,
      operationId,
      reason: 'start work',
    });
    expect(request.fingerprint).toMatch(/^[a-f\d]{64}$/);
  });

  it.each([
    [
      'inactive project context',
      validContext({ projectMembershipStatus: 'UNKNOWN' }),
      'TASK_PROJECT_MEMBERSHIP_REQUIRED',
    ],
    [
      'unknown context fields',
      validContext({ actorRole: 'ADMIN' }),
      'INVALID_TRUSTED_CONTEXT',
    ],
  ])('fails closed for %s', async (_label, context, code) => {
    const { service, transitionStatus } = setup();

    await expect(
      service.execute(context, validCommand()),
    ).resolves.toMatchObject({ kind: 'REJECTED', code });
    expect(transitionStatus).not.toHaveBeenCalled();
  });

  it('rejects malformed commands before persistence', async () => {
    const { service, transitionStatus } = setup();

    await expect(
      service.execute(validContext(), validCommand({ expectedVersion: 0 })),
    ).resolves.toMatchObject({ kind: 'REJECTED', code: 'INVALID_COMMAND' });
    await expect(
      service.execute(validContext(), validCommand({ unapproved: true })),
    ).resolves.toMatchObject({ kind: 'REJECTED', code: 'INVALID_COMMAND' });
    expect(transitionStatus).not.toHaveBeenCalled();
  });

  it('uses the same fingerprint for normalized reason and operation ID variants', async () => {
    const { service, transitionStatus } = setup();

    await service.execute(
      validContext(),
      validCommand({ reason: ' valid reason ' }),
    );
    await service.execute(
      validContext(),
      validCommand({
        reason: 'valid reason',
        operationId: '71202000-0000-4000-8000-000000000002',
      }),
    );

    expect(transitionStatus.mock.calls[0][0].fingerprint).toBe(
      transitionStatus.mock.calls[1][0].fingerprint,
    );
  });
});
