import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import {
  TASK_STATUSES,
  isObjectIdString,
  isUuidV4,
  resolveCorrelationId,
  type TaskStatus,
} from '../infrastructure/mongodb/task-contract';
import type {
  TaskLifecycleActorContext,
  TaskLifecycleCommandResult,
  TaskLifecycleDecisionFunction,
  TaskLifecyclePersistenceRequest,
  TaskLifecycleTransitionCommand,
} from './task-lifecycle-policy';
import { evaluateTaskLifecycleTransition } from './task-lifecycle-policy';

export interface TaskLifecycleCommandPersistence {
  transitionStatus(
    request: TaskLifecyclePersistenceRequest,
    decide: TaskLifecycleDecisionFunction,
  ): Promise<TaskLifecycleCommandResult>;
}

const roles = new Set(['ADMIN', 'TEAM_LEADER', 'MEMBER']);
const sources = new Set(['WEB', 'API', 'INTERNAL_SERVICE']);
const membershipStatuses = new Set(['ACTIVE', 'INACTIVE', 'UNKNOWN']);
const statuses = new Set<string>(TASK_STATUSES);
const commandKeys = new Set([
  'taskId',
  'targetStatus',
  'expectedVersion',
  'operationId',
  'reason',
]);
const contextKeys = new Set([
  'actorId',
  'projectId',
  'projectRole',
  'projectMembershipStatus',
  'organizationMembershipStatus',
  'source',
  'requestId',
]);

interface ParsedCommand {
  taskId: Types.ObjectId;
  targetStatus: TaskStatus;
  expectedVersion: number;
  operationId: string;
  reason?: string;
}

export class TaskLifecycleCommandService {
  constructor(
    private readonly persistence: TaskLifecycleCommandPersistence,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(
    contextValue: unknown,
    commandValue: unknown,
  ): Promise<TaskLifecycleCommandResult> {
    const context = parseActorContext(contextValue);
    if (!context)
      return {
        kind: 'REJECTED',
        code: 'INVALID_TRUSTED_CONTEXT',
        replayed: false,
      };
    if (context.organizationMembershipStatus !== 'ACTIVE')
      return {
        kind: 'REJECTED',
        code: 'TASK_ORGANIZATION_MEMBERSHIP_REQUIRED',
        replayed: false,
      };
    if (context.projectMembershipStatus !== 'ACTIVE')
      return {
        kind: 'REJECTED',
        code: 'TASK_PROJECT_MEMBERSHIP_REQUIRED',
        replayed: false,
      };

    const command = parseCommand(commandValue);
    if (!command)
      return { kind: 'REJECTED', code: 'INVALID_COMMAND', replayed: false };

    return this.persistence.transitionStatus(
      {
        context,
        command,
        fingerprint: fingerprintTaskLifecycleCommand(context, command),
        now: this.clock(),
      },
      evaluateTaskLifecycleTransition,
    );
  }
}

export function fingerprintTaskLifecycleCommand(
  context: TaskLifecycleActorContext,
  command: TaskLifecycleTransitionCommand,
): string {
  const canonical = {
    method: 'PATCH',
    route: `/api/v1/projects/${context.projectId.toHexString()}/tasks/${command.taskId.toHexString()}/status`,
    body: {
      targetStatus: command.targetStatus,
      expectedVersion: command.expectedVersion,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    },
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function parseActorContext(value: unknown): TaskLifecycleActorContext | null {
  const record = readPlainObject(value, contextKeys);
  if (!record) return null;

  const requiredKeys = [
    'actorId',
    'projectId',
    'projectRole',
    'projectMembershipStatus',
    'organizationMembershipStatus',
    'source',
  ];
  if (requiredKeys.some((key) => !Object.hasOwn(record, key))) return null;

  if (
    !isObjectIdString(record.actorId) ||
    !isObjectIdString(record.projectId) ||
    typeof record.projectRole !== 'string' ||
    !roles.has(record.projectRole) ||
    typeof record.projectMembershipStatus !== 'string' ||
    !membershipStatuses.has(record.projectMembershipStatus) ||
    typeof record.organizationMembershipStatus !== 'string' ||
    !membershipStatuses.has(record.organizationMembershipStatus) ||
    typeof record.source !== 'string' ||
    !sources.has(record.source) ||
    (record.requestId !== undefined && typeof record.requestId !== 'string')
  ) {
    return null;
  }

  return {
    actorId: new Types.ObjectId(record.actorId),
    projectId: new Types.ObjectId(record.projectId),
    projectRole: record.projectRole as TaskLifecycleActorContext['projectRole'],
    projectMembershipStatus:
      record.projectMembershipStatus as TaskLifecycleActorContext['projectMembershipStatus'],
    organizationMembershipStatus:
      record.organizationMembershipStatus as TaskLifecycleActorContext['organizationMembershipStatus'],
    source: record.source as TaskLifecycleActorContext['source'],
    correlationId: resolveCorrelationId(record.requestId),
  };
}

function parseCommand(value: unknown): ParsedCommand | null {
  const record = readPlainObject(value, commandKeys);
  if (!record) return null;
  if (
    !isObjectIdString(record.taskId) ||
    typeof record.targetStatus !== 'string' ||
    !statuses.has(record.targetStatus) ||
    !Number.isSafeInteger(record.expectedVersion) ||
    (record.expectedVersion as number) < 1 ||
    typeof record.operationId !== 'string' ||
    !isUuidV4(record.operationId) ||
    (record.reason !== undefined && typeof record.reason !== 'string')
  ) {
    return null;
  }

  const reason =
    typeof record.reason === 'string' ? record.reason.trim() : undefined;
  return {
    taskId: new Types.ObjectId(record.taskId),
    targetStatus: record.targetStatus as TaskStatus,
    expectedVersion: record.expectedVersion as number,
    operationId: record.operationId.toLowerCase(),
    ...(reason ? { reason } : {}),
  };
}

function readPlainObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> | null {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return null;
    }

    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))
    ) {
      return null;
    }

    const record = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
        return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}
