import { Types } from 'mongoose';
import type { TaskStatus } from '../infrastructure/mongodb/task-contract';
import {
  evaluateTaskLifecycleTransition,
  type TaskLifecycleActorContext,
  type TaskLifecycleTaskSnapshot,
} from './task-lifecycle-policy';

const projectId = new Types.ObjectId();
const actorId = new Types.ObjectId();
const creatorId = new Types.ObjectId();
const assigneeId = new Types.ObjectId();

function context(
  overrides: Partial<TaskLifecycleActorContext> = {},
): TaskLifecycleActorContext {
  return {
    actorId: assigneeId,
    projectId,
    projectRole: 'ADMIN',
    projectMembershipStatus: 'ACTIVE',
    organizationMembershipStatus: 'ACTIVE',
    source: 'INTERNAL_SERVICE',
    correlationId: 'task-lifecycle-policy-test',
    ...overrides,
  };
}

function task(
  status: TaskStatus,
  overrides: Partial<TaskLifecycleTaskSnapshot> = {},
): TaskLifecycleTaskSnapshot {
  return {
    status,
    version: 3,
    createdBy: creatorId,
    assigneeId,
    completedAt: status === 'DONE' ? new Date('2026-10-19T10:00:00Z') : null,
    ...overrides,
  };
}

function transition(
  fromStatus: TaskStatus,
  toStatus: TaskStatus,
  options: {
    role?: TaskLifecycleActorContext['projectRole'];
    reason?: string;
    expectedVersion?: number;
    taskOverrides?: Partial<TaskLifecycleTaskSnapshot>;
    contextOverrides?: Partial<TaskLifecycleActorContext>;
  } = {},
) {
  return evaluateTaskLifecycleTransition(
    task(fromStatus, options.taskOverrides),
    context({
      ...(options.role ? { projectRole: options.role } : {}),
      ...options.contextOverrides,
    }),
    {
      taskId: new Types.ObjectId(),
      targetStatus: toStatus,
      expectedVersion: options.expectedVersion ?? 3,
      operationId: '71202000-0000-4000-8000-000000000001',
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    },
  );
}

describe('Task lifecycle transition policy', () => {
  const allowed = new Set([
    'TODO:IN_PROGRESS',
    'TODO:CANCELLED',
    'IN_PROGRESS:BLOCKED',
    'IN_PROGRESS:DONE',
    'IN_PROGRESS:CANCELLED',
    'BLOCKED:IN_PROGRESS',
    'BLOCKED:CANCELLED',
    'DONE:IN_PROGRESS',
  ]);

  it.each(
    (['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'] as const).flatMap(
      (from) =>
        (['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'] as const).map(
          (to) => [from, to] as const,
        ),
    ),
  )('%s → %s follows the approved D-02 matrix', (from, to) => {
    const result = transition(from, to, {
      reason: 'approved transition reason',
    });

    expect(result.kind).toBe(
      allowed.has(`${from}:${to}`) ? 'ALLOW' : 'REJECTED',
    );
    if (!allowed.has(`${from}:${to}`))
      expect(result).toMatchObject({ code: 'TASK_TRANSITION_NOT_ALLOWED' });
  });

  it('requires an active Project and Organization membership context', () => {
    expect(
      transition('TODO', 'IN_PROGRESS', {
        contextOverrides: { projectMembershipStatus: 'INACTIVE' as never },
      }),
    ).toMatchObject({
      kind: 'REJECTED',
      code: 'TASK_PROJECT_MEMBERSHIP_REQUIRED',
    });
    expect(
      transition('TODO', 'IN_PROGRESS', {
        contextOverrides: { organizationMembershipStatus: 'INACTIVE' as never },
      }),
    ).toMatchObject({
      kind: 'REJECTED',
      code: 'TASK_ORGANIZATION_MEMBERSHIP_REQUIRED',
    });
  });

  it('requires assignee, Project TEAM_LEADER, or Project ADMIN for work transitions', () => {
    expect(transition('TODO', 'IN_PROGRESS', { role: 'MEMBER' })).toMatchObject(
      {
        kind: 'ALLOW',
      },
    );
    expect(
      transition('TODO', 'IN_PROGRESS', {
        role: 'MEMBER',
        taskOverrides: { assigneeId: creatorId },
      }),
    ).toMatchObject({ kind: 'REJECTED', code: 'TASK_TRANSITION_FORBIDDEN' });
    expect(
      transition('TODO', 'IN_PROGRESS', { role: 'TEAM_LEADER' }),
    ).toMatchObject({ kind: 'ALLOW' });
  });

  it('requires creator, Project TEAM_LEADER, or Project ADMIN for cancellation and reopen', () => {
    expect(
      transition('TODO', 'CANCELLED', {
        role: 'MEMBER',
        reason: 'cancel requested',
        taskOverrides: { createdBy: actorId },
        contextOverrides: { actorId },
      }),
    ).toMatchObject({ kind: 'ALLOW' });
    expect(
      transition('TODO', 'CANCELLED', {
        role: 'MEMBER',
        reason: 'cancel requested',
      }),
    ).toMatchObject({ kind: 'REJECTED', code: 'TASK_TRANSITION_FORBIDDEN' });
    expect(
      transition('DONE', 'IN_PROGRESS', {
        role: 'MEMBER',
        reason: 'reopen requested',
        taskOverrides: { createdBy: actorId },
        contextOverrides: { actorId },
      }),
    ).toMatchObject({ kind: 'ALLOW' });
  });

  it.each([
    ['IN_PROGRESS', 'BLOCKED'],
    ['TODO', 'CANCELLED'],
    ['BLOCKED', 'IN_PROGRESS'],
    ['DONE', 'IN_PROGRESS'],
  ] as const)('requires a reason for %s → %s', (from, to) => {
    expect(transition(from, to)).toMatchObject({
      kind: 'REJECTED',
      code: 'TASK_TRANSITION_REASON_REQUIRED',
    });
    expect(transition(from, to, { reason: ' valid ' })).toMatchObject({
      kind: 'ALLOW',
    });
  });

  it('rejects stale expectedVersion without permitting the transition', () => {
    expect(
      transition('TODO', 'IN_PROGRESS', { expectedVersion: 2 }),
    ).toMatchObject({
      kind: 'REJECTED',
      code: 'TASK_VERSION_CONFLICT',
      currentVersion: 3,
    });
  });
});
