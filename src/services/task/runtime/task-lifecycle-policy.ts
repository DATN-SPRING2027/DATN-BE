import { Types } from 'mongoose';
import type { TaskStatus } from '../infrastructure/mongodb/task-contract';

export type TaskProjectRole = 'ADMIN' | 'TEAM_LEADER' | 'MEMBER';
export type TaskTransitionSource = 'WEB' | 'API' | 'INTERNAL_SERVICE';

/**
 * Server-derived context supplied by an internal caller. D-08 adds no HTTP
 * caller or context resolver; do not build this object from request headers.
 */
export interface TaskLifecycleActorContext {
  actorId: Types.ObjectId;
  projectId: Types.ObjectId;
  projectRole: TaskProjectRole;
  projectMembershipStatus: 'ACTIVE' | 'INACTIVE' | 'UNKNOWN';
  organizationMembershipStatus: 'ACTIVE' | 'INACTIVE' | 'UNKNOWN';
  source: TaskTransitionSource;
  correlationId: string;
}

export interface TaskLifecycleTaskSnapshot {
  status: TaskStatus;
  version: number;
  createdBy: Types.ObjectId;
  assigneeId: Types.ObjectId | null;
  completedAt: Date | null;
}

export interface TaskLifecycleTransitionCommand {
  taskId: Types.ObjectId;
  targetStatus: TaskStatus;
  expectedVersion: number;
  operationId: string;
  reason?: string;
}

export interface TaskLifecyclePersistenceRequest {
  context: TaskLifecycleActorContext;
  command: TaskLifecycleTransitionCommand;
  fingerprint: string;
  now: Date;
}

export type TaskLifecycleCommandResult =
  | {
      kind: 'COMMITTED';
      status: TaskStatus;
      version: number;
      completedAt: Date | null;
      updatedAt: Date;
      replayed: boolean;
      reconciled: boolean;
    }
  | {
      kind: 'REJECTED';
      code: string;
      currentStatus?: TaskStatus;
      currentVersion?: number;
      replayed: boolean;
    }
  | { kind: 'IN_PROGRESS'; operationId: string }
  | { kind: 'UNCERTAIN'; operationId: string }
  | { kind: 'ABORTED'; operationId: string };

export type TaskLifecycleDecisionFunction = (
  task: TaskLifecycleTaskSnapshot | null,
  context: TaskLifecycleActorContext,
  command: TaskLifecycleTransitionCommand,
) => TaskLifecycleTransitionDecision;

export type TaskLifecycleTransitionDecision =
  | {
      kind: 'ALLOW';
      fromStatus: TaskStatus;
      toStatus: TaskStatus;
      expectedVersion: number;
      reason?: string;
    }
  | {
      kind: 'REJECTED';
      code: string;
      currentStatus?: TaskStatus;
      currentVersion?: number;
    };

const allowedTransitions = new Set([
  'TODO:IN_PROGRESS',
  'TODO:CANCELLED',
  'IN_PROGRESS:BLOCKED',
  'IN_PROGRESS:DONE',
  'IN_PROGRESS:CANCELLED',
  'BLOCKED:IN_PROGRESS',
  'BLOCKED:CANCELLED',
  'DONE:IN_PROGRESS',
]);

export function evaluateTaskLifecycleTransition(
  task: TaskLifecycleTaskSnapshot | null,
  context: TaskLifecycleActorContext,
  command: TaskLifecycleTransitionCommand,
): TaskLifecycleTransitionDecision {
  if (context.organizationMembershipStatus !== 'ACTIVE')
    return { kind: 'REJECTED', code: 'TASK_ORGANIZATION_MEMBERSHIP_REQUIRED' };
  if (context.projectMembershipStatus !== 'ACTIVE')
    return { kind: 'REJECTED', code: 'TASK_PROJECT_MEMBERSHIP_REQUIRED' };
  if (!task) return { kind: 'REJECTED', code: 'TASK_NOT_FOUND' };

  if (command.expectedVersion !== task.version) {
    return {
      kind: 'REJECTED',
      code: 'TASK_VERSION_CONFLICT',
      currentStatus: task.status,
      currentVersion: task.version,
    };
  }

  const fromStatus = task.status;
  const toStatus = command.targetStatus;
  if (!allowedTransitions.has(`${fromStatus}:${toStatus}`)) {
    return {
      kind: 'REJECTED',
      code: 'TASK_TRANSITION_NOT_ALLOWED',
      currentStatus: fromStatus,
      currentVersion: task.version,
    };
  }

  const reason = command.reason?.trim();
  if (
    requiresReason(fromStatus, toStatus) &&
    (!reason || codePointLength(reason) < 5)
  ) {
    return {
      kind: 'REJECTED',
      code: 'TASK_TRANSITION_REASON_REQUIRED',
      currentStatus: fromStatus,
      currentVersion: task.version,
    };
  }

  if (!hasTransitionActor(task, context, fromStatus, toStatus)) {
    return {
      kind: 'REJECTED',
      code: 'TASK_TRANSITION_FORBIDDEN',
      currentStatus: fromStatus,
      currentVersion: task.version,
    };
  }

  return {
    kind: 'ALLOW',
    fromStatus,
    toStatus,
    expectedVersion: command.expectedVersion,
    ...(reason ? { reason } : {}),
  };
}

function requiresReason(fromStatus: TaskStatus, toStatus: TaskStatus): boolean {
  return (
    toStatus === 'BLOCKED' ||
    toStatus === 'CANCELLED' ||
    (fromStatus === 'BLOCKED' && toStatus === 'IN_PROGRESS') ||
    (fromStatus === 'DONE' && toStatus === 'IN_PROGRESS')
  );
}

function hasTransitionActor(
  task: TaskLifecycleTaskSnapshot,
  context: TaskLifecycleActorContext,
  fromStatus: TaskStatus,
  toStatus: TaskStatus,
): boolean {
  if (
    fromStatus === 'TODO' &&
    toStatus === 'IN_PROGRESS' &&
    task.assigneeId === null
  )
    return false;

  if (context.projectRole === 'ADMIN' || context.projectRole === 'TEAM_LEADER')
    return true;

  const isCancelOrReopen =
    toStatus === 'CANCELLED' ||
    (fromStatus === 'DONE' && toStatus === 'IN_PROGRESS');
  if (isCancelOrReopen) return task.createdBy.equals(context.actorId);
  return task.assigneeId?.equals(context.actorId) ?? false;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}
