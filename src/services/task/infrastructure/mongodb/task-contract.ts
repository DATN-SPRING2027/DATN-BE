import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';

export const TASK_DATABASE_NAME = 'continuum_task';
export const TASK_COLLECTION = 'tasks';
export const TASK_EVENT_COLLECTION = 'task_events';
export const TASK_OPERATION_COLLECTION = 'task_operations';
export const TASK_OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000;

export const TASK_STATUSES = [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'DONE',
  'CANCELLED',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_TITLE_PATTERN = String.raw`[^\x{0009}-\x{000D}\x{0020}\x{0085}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}-\x{2029}\x{202F}\x{205F}\x{3000}]`;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

export const TASK_CREATION_CHANGED_FIELDS = [
  'projectId',
  'title',
  'createdBy',
  'createdAt',
  'updatedAt',
  'version',
] as const;

export interface TaskCreateInput {
  title: string;
}

export interface TaskDocument extends mongoose.mongo.Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  title: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  status: TaskStatus;
  assigneeId: Types.ObjectId | null;
  completedAt: Date | null;
  version: number;
}

export interface TaskCreationEventDocument extends mongoose.mongo.Document {
  _id: Types.ObjectId;
  taskId: Types.ObjectId;
  projectId: Types.ObjectId;
  eventName: 'TASK_CREATED';
  actorType: 'USER';
  actorId: Types.ObjectId;
  source: 'HUMAN';
  changedFields: typeof TASK_CREATION_CHANGED_FIELDS;
  taskVersion: 1;
  occurredAt: Date;
  operationId: string;
  correlationId: string;
}

export interface TaskStatusTransitionEventDocument
  extends mongoose.mongo.Document {
  _id: Types.ObjectId;
  taskId: Types.ObjectId;
  projectId: Types.ObjectId;
  actorId: Types.ObjectId;
  actorType: 'USER' | 'SYSTEM';
  source: 'WEB' | 'API' | 'INTERNAL_SERVICE';
  eventType: 'TASK_STATUS_TRANSITIONED';
  operationId: string;
  correlationId: string;
  timestamp: Date;
  version: number;
  changedFields: ['status'];
  delta: {
    type: 'STATUS_TRANSITION';
    fromStatus: TaskStatus;
    toStatus: TaskStatus;
    reason?: string;
  };
}

export type TaskEventDocument =
  TaskCreationEventDocument | TaskStatusTransitionEventDocument;

export type TaskLifecycleOperationState =
  'IN_PROGRESS' | 'COMMITTED' | 'REJECTED';

export type TaskLifecycleOperationResult =
  | {
      outcome: 'COMMITTED';
      status: TaskStatus;
      version: number;
      completedAt: Date | null;
      updatedAt: Date;
    }
  | {
      outcome: 'REJECTED';
      code: string;
      currentStatus?: TaskStatus;
      currentVersion?: number;
    };

export interface TaskLifecycleOperationDocument
  extends mongoose.mongo.Document {
  _id: Types.ObjectId;
  actorId: Types.ObjectId;
  projectId: Types.ObjectId;
  operationId: string;
  fingerprint: string;
  state: TaskLifecycleOperationState;
  taskId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  leaseUntil: Date;
  expiresAt: Date;
  result?: TaskLifecycleOperationResult;
}

export interface TaskCreationContext {
  projectId: Types.ObjectId;
  actorId: Types.ObjectId;
  requestId?: unknown;
}

export function isValidTaskTitle(title: string): boolean {
  for (const codePoint of title) {
    const value = codePoint.codePointAt(0)!;
    const isWhitespace =
      (value >= 0x0009 && value <= 0x000d) ||
      value === 0x0020 ||
      value === 0x0085 ||
      value === 0x00a0 ||
      value === 0x1680 ||
      (value >= 0x2000 && value <= 0x200a) ||
      value === 0x2028 ||
      value === 0x2029 ||
      value === 0x202f ||
      value === 0x205f ||
      value === 0x3000;
    if (!isWhitespace) return true;
  }
  return false;
}

export function parseTaskCreateInput(value: unknown): TaskCreateInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== 'title') return null;
  const title = (value as { title?: unknown }).title;
  if (typeof title !== 'string' || !isValidTaskTitle(title)) return null;
  return { title };
}

export function isObjectIdString(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value);
}

export function resolveCorrelationId(requestId: unknown): string {
  return typeof requestId === 'string' && REQUEST_ID_PATTERN.test(requestId)
    ? requestId
    : randomUUID();
}

export function isUuidV4(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

export function buildTaskCreationDocuments(input: {
  taskId: Types.ObjectId;
  eventId: Types.ObjectId;
  projectId: Types.ObjectId;
  actorId: Types.ObjectId;
  input: TaskCreateInput;
  createdAt: Date;
  operationId: string;
  correlationId: string;
}): { task: TaskDocument; event: TaskCreationEventDocument } {
  const task: TaskDocument = {
    _id: input.taskId,
    projectId: input.projectId,
    title: input.input.title,
    createdBy: input.actorId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    status: 'TODO',
    assigneeId: null,
    completedAt: null,
    version: 1,
  };
  const event: TaskCreationEventDocument = {
    _id: input.eventId,
    taskId: input.taskId,
    projectId: input.projectId,
    eventName: 'TASK_CREATED',
    actorType: 'USER',
    actorId: input.actorId,
    source: 'HUMAN',
    changedFields: TASK_CREATION_CHANGED_FIELDS,
    taskVersion: 1,
    occurredAt: input.createdAt,
    operationId: input.operationId,
    correlationId: input.correlationId,
  };
  return { task, event };
}
