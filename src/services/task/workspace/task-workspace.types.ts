import { Types } from 'mongoose';

export const WORKSPACE_TASK_DATABASE_NAME = 'continuum_task';
export const WORKSPACE_TASKS_COLLECTION = 'tasks';
export const WORKSPACE_TASK_EVENTS_COLLECTION = 'task_events';
export const WORKSPACE_TASK_OPERATIONS_COLLECTION = 'task_operations';
export const WORKSPACE_TASK_COUNTERS_COLLECTION = 'task_counters';
export const WORKSPACE_TASK_COMMENTS_COLLECTION = 'task_comments';
export const WORKSPACE_TASK_WORKLOGS_COLLECTION = 'task_worklogs';
export const WORKSPACE_PROJECT_SPRINTS_COLLECTION = 'project_sprints';
export const WORKSPACE_PROJECT_SPRINT_EVENTS_COLLECTION =
  'project_sprint_events';

export const WORKSPACE_TASK_STATUSES = [
  'TODO',
  'IN_PROGRESS',
  'IN_REVIEW',
  'BLOCKED',
  'DONE',
  'CANCELLED',
] as const;
export type WorkspaceTaskStatus = (typeof WORKSPACE_TASK_STATUSES)[number];

export const WORKSPACE_TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type WorkspaceTaskPriority = (typeof WORKSPACE_TASK_PRIORITIES)[number];

export const WORKSPACE_TASK_TYPES = ['TASK', 'BUG', 'STORY'] as const;
export type WorkspaceTaskType = (typeof WORKSPACE_TASK_TYPES)[number];

export const WORKSPACE_SPRINT_STATUSES = [
  'PLANNED',
  'ACTIVE',
  'COMPLETED',
] as const;
export type WorkspaceSprintStatus = (typeof WORKSPACE_SPRINT_STATUSES)[number];

export type WorkspaceActorRole = 'ADMIN' | 'TEAM_LEADER' | 'MEMBER';

export interface WorkspaceChecklistStep {
  id: string;
  text: string;
  done: boolean;
}

export interface WorkspaceSubtaskCounts {
  total: number;
  done: number;
}

export interface WorkspaceTaskDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  key: string;
  title: string;
  description: string | null;
  type: WorkspaceTaskType;
  status: WorkspaceTaskStatus;
  priority: WorkspaceTaskPriority;
  assigneeId: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  parentId: Types.ObjectId | null;
  sprintId: Types.ObjectId | null;
  labels: string[];
  steps: WorkspaceChecklistStep[];
  dueDate: Date | null;
  startDate: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface WorkspaceTaskCommentDocument {
  _id: Types.ObjectId;
  taskId: Types.ObjectId;
  projectId: Types.ObjectId;
  organizationId: Types.ObjectId;
  authorId: Types.ObjectId;
  body: string;
  createdAt: Date;
}

export interface WorkspaceTaskWorklogDocument {
  _id: Types.ObjectId;
  taskId: Types.ObjectId;
  projectId: Types.ObjectId;
  organizationId: Types.ObjectId;
  authorId: Types.ObjectId;
  minutes: number;
  note: string | null;
  loggedAt: Date;
  createdAt: Date;
}

export interface WorkspaceProjectSprintDocument {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  organizationId: Types.ObjectId;
  name: string;
  goal: string | null;
  status: WorkspaceSprintStatus;
  startDate: Date | null;
  endDate: Date | null;
  createdBy: Types.ObjectId;
  createdAt: Date;
  completedAt: Date | null;
  version: number;
}

export interface WorkspaceProjectSprintEventDocument {
  _id: Types.ObjectId;
  sprintId: Types.ObjectId;
  projectId: Types.ObjectId;
  organizationId: Types.ObjectId;
  eventType: 'SPRINT_CREATED' | 'SPRINT_UPDATED' | 'SPRINT_COMPLETED';
  actorId: Types.ObjectId;
  actorType: 'USER';
  occurredAt: Date;
  version: number;
  delta: Record<string, unknown>;
}

export interface WorkspaceTaskEventRecord {
  _id: Types.ObjectId;
  taskId: Types.ObjectId;
  projectId: Types.ObjectId;
  organizationId?: Types.ObjectId;
  eventName?: 'TASK_CREATED';
  eventType?:
    | 'TASK_CREATED'
    | 'TASK_STATUS_TRANSITIONED'
    | 'TASK_UPDATED'
    | 'TASK_COMMENT_ADDED'
    | 'TASK_WORKLOG_ADDED';
  actorType: 'USER' | 'SYSTEM';
  actorId: Types.ObjectId;
  source: 'HUMAN' | 'WEB' | 'API' | 'INTERNAL_SERVICE';
  changedFields?: string[];
  taskVersion?: number;
  version?: number;
  occurredAt?: Date;
  timestamp?: Date;
  operationId: string;
  correlationId: string;
  delta?: {
    type?: string;
    fromStatus?: WorkspaceTaskStatus;
    toStatus?: WorkspaceTaskStatus;
    reason?: string;
    changedFields?: string[];
    fromSprintId?: Types.ObjectId | null;
    toSprintId?: Types.ObjectId | null;
    commentId?: Types.ObjectId;
    worklogId?: Types.ObjectId;
    minutes?: number;
  };
}

export interface WorkspaceIdempotencyRecord {
  _id: Types.ObjectId;
  actorId: Types.ObjectId;
  projectId: Types.ObjectId;
  operationId: string;
  fingerprint: string;
  state: 'IN_PROGRESS' | 'COMMITTED' | 'REJECTED';
  taskId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  leaseUntil: Date;
  expiresAt: Date;
  httpResponse?: {
    statusCode: number;
    body: unknown;
    etag?: string;
    location?: string;
  };
}

export const ALLOWED_WORKSPACE_TRANSITIONS: ReadonlySet<string> = new Set([
  'TODO:IN_PROGRESS',
  'TODO:BLOCKED',
  'TODO:CANCELLED',
  'IN_PROGRESS:TODO',
  'IN_PROGRESS:IN_REVIEW',
  'IN_PROGRESS:BLOCKED',
  'IN_PROGRESS:DONE',
  'IN_PROGRESS:CANCELLED',
  'IN_REVIEW:IN_PROGRESS',
  'IN_REVIEW:BLOCKED',
  'IN_REVIEW:DONE',
  'IN_REVIEW:CANCELLED',
  'BLOCKED:TODO',
  'BLOCKED:IN_PROGRESS',
  'BLOCKED:IN_REVIEW',
  'BLOCKED:CANCELLED',
  'DONE:IN_PROGRESS',
  'CANCELLED:TODO',
]);

export function requiresTransitionReason(
  fromStatus: WorkspaceTaskStatus,
  toStatus: WorkspaceTaskStatus,
): boolean {
  return (
    toStatus === 'BLOCKED' ||
    toStatus === 'CANCELLED' ||
    fromStatus === 'BLOCKED' ||
    fromStatus === 'DONE' ||
    fromStatus === 'CANCELLED'
  );
}

export function formatTaskETag(taskId: string, version: number): string {
  return `"task:${taskId}:${version}"`;
}

export function formatSprintETag(sprintId: string, version: number): string {
  return `"sprint:${sprintId}:${version}"`;
}

export function parseEntityIfMatch(
  headerValue: string | undefined,
  prefix: 'task' | 'sprint',
  expectedEntityId: string,
): { kind: 'missing' } | { kind: 'invalid' } | { kind: 'ok'; version: number } {
  if (headerValue === undefined || headerValue.trim() === '') {
    return { kind: 'missing' };
  }
  const match = new RegExp(
    `^"${prefix}:([0-9a-f]{24}):([1-9][0-9]*)"$`,
    'i',
  ).exec(headerValue.trim());
  if (!match) return { kind: 'invalid' };
  if (match[1].toLowerCase() !== expectedEntityId.toLowerCase()) {
    return { kind: 'invalid' };
  }
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version) || version < 1) {
    return { kind: 'invalid' };
  }
  return { kind: 'ok', version };
}

export function escapeLiteralRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function encodeDateRangeCursor(dueDate: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ dueDate: dueDate.toISOString(), id }),
    'utf8',
  ).toString('base64url');
}

export function decodeDateRangeCursor(
  cursor: string,
): { dueDate: Date; id: string } | null {
  try {
    const raw = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    if (
      typeof raw !== 'object' ||
      raw === null ||
      typeof raw.dueDate !== 'string' ||
      typeof raw.id !== 'string' ||
      !/^[0-9a-f]{24}$/i.test(raw.id)
    ) {
      return null;
    }
    const dueDate = new Date(raw.dueDate);
    if (!Number.isFinite(dueDate.getTime())) return null;
    return { dueDate, id: raw.id };
  } catch {
    return null;
  }
}

export function encodeOrgSummaryCursor(
  overdue: number,
  total: number,
  projectId: string,
): string {
  return Buffer.from(
    JSON.stringify({ overdue, total, projectId }),
    'utf8',
  ).toString('base64url');
}

export function decodeOrgSummaryCursor(
  cursor: string,
): { overdue: number; total: number; projectId: string } | null {
  try {
    const raw = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    if (
      typeof raw !== 'object' ||
      raw === null ||
      typeof raw.overdue !== 'number' ||
      !Number.isSafeInteger(raw.overdue) ||
      raw.overdue < 0 ||
      typeof raw.total !== 'number' ||
      !Number.isSafeInteger(raw.total) ||
      raw.total < 0 ||
      typeof raw.projectId !== 'string' ||
      !/^[0-9a-f]{24}$/i.test(raw.projectId)
    ) {
      return null;
    }
    return {
      overdue: raw.overdue,
      total: raw.total,
      projectId: raw.projectId,
    };
  } catch {
    return null;
  }
}
