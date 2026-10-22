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
  options?: { asOf?: string; seen?: string[] },
): string {
  return Buffer.from(
    JSON.stringify({
      overdue,
      total,
      projectId,
      ...(options?.asOf ? { asOf: options.asOf } : {}),
      ...(options?.seen ? { seen: options.seen } : {}),
    }),
    'utf8',
  ).toString('base64url');
}

export function decodeOrgSummaryCursor(cursor: string): {
  overdue: number;
  total: number;
  projectId: string;
  asOf?: Date;
  seen?: string[];
} | null {
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
    let asOf: Date | undefined;
    if (raw.asOf !== undefined) {
      if (typeof raw.asOf !== 'string') return null;
      const parsedAsOf = new Date(raw.asOf);
      if (!Number.isFinite(parsedAsOf.getTime())) return null;
      asOf = parsedAsOf;
    }
    let seen: string[] | undefined;
    if (raw.seen !== undefined) {
      if (
        !Array.isArray(raw.seen) ||
        raw.seen.some(
          (id) => typeof id !== 'string' || !/^[0-9a-f]{24}$/i.test(id),
        )
      ) {
        return null;
      }
      seen = raw.seen.map((id: string) => id.toLowerCase());
    }
    return {
      overdue: raw.overdue,
      total: raw.total,
      projectId: raw.projectId.toLowerCase(),
      ...(asOf ? { asOf } : {}),
      ...(seen ? { seen } : {}),
    };
  } catch {
    return null;
  }
}

export interface WorkspaceIndexSpec {
  key: Record<string, 1 | -1>;
  name: string;
  unique?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
}

export const WORKSPACE_INDEX_CATALOGUE: Record<string, WorkspaceIndexSpec[]> = {
  [WORKSPACE_TASKS_COLLECTION]: [
    { key: { projectId: 1, _id: 1 }, name: 'task_project_cursor' },
    {
      key: { projectId: 1, status: 1, _id: 1 },
      name: 'project_status_cursor',
    },
    {
      key: { projectId: 1, assigneeId: 1, _id: 1, status: 1 },
      name: 'project_assignee_cursor_status',
    },
    {
      key: { projectId: 1, sprintId: 1, _id: 1, status: 1 },
      name: 'project_sprint_cursor_status',
    },
    { key: { projectId: 1, dueDate: 1, _id: 1 }, name: 'project_due_cursor' },
    {
      key: { projectId: 1, parentId: 1, _id: 1 },
      name: 'project_parent_cursor',
    },
    {
      key: { projectId: 1, key: 1 },
      name: 'project_key_unique',
      unique: true,
      partialFilterExpression: { key: { $type: 'string' } },
    },
    { key: { organizationId: 1, _id: 1 }, name: 'org_cursor' },
    {
      key: { organizationId: 1, status: 1, _id: 1 },
      name: 'org_status_cursor',
    },
    {
      key: { organizationId: 1, projectId: 1, _id: 1 },
      name: 'org_project_cursor',
    },
    {
      key: { organizationId: 1, assigneeId: 1, _id: 1, status: 1 },
      name: 'org_assignee_cursor_status',
    },
    {
      key: { organizationId: 1, dueDate: 1, _id: 1 },
      name: 'org_due_cursor',
    },
    {
      key: { organizationId: 1, projectId: 1, status: 1, dueDate: 1 },
      name: 'org_project_status_due',
    },
  ],
  [WORKSPACE_TASK_COMMENTS_COLLECTION]: [
    {
      key: { projectId: 1, taskId: 1, _id: 1 },
      name: 'task_comments_cursor',
    },
  ],
  [WORKSPACE_TASK_EVENTS_COLLECTION]: [
    {
      key: { projectId: 1, taskId: 1, _id: -1 },
      name: 'task_events_project_task_cursor',
    },
    {
      key: { taskId: 1, version: 1 },
      name: 'task_event_task_mutation_version_unique',
      unique: true,
      partialFilterExpression: {
        eventType: { $in: ['TASK_STATUS_TRANSITIONED', 'TASK_UPDATED'] },
      },
    },
  ],
  [WORKSPACE_TASK_WORKLOGS_COLLECTION]: [
    {
      key: { projectId: 1, taskId: 1, _id: -1 },
      name: 'task_worklogs_cursor',
    },
  ],
  [WORKSPACE_PROJECT_SPRINTS_COLLECTION]: [
    {
      key: { projectId: 1, createdAt: -1, _id: -1 },
      name: 'project_sprints_created_desc',
    },
    {
      key: { projectId: 1 },
      name: 'project_one_active_sprint_unique',
      unique: true,
      partialFilterExpression: { status: 'ACTIVE' },
    },
  ],
  [WORKSPACE_PROJECT_SPRINT_EVENTS_COLLECTION]: [
    {
      key: { sprintId: 1, version: 1 },
      name: 'sprint_event_version_unique',
      unique: true,
    },
    {
      key: { projectId: 1, sprintId: 1, occurredAt: -1, _id: -1 },
      name: 'project_sprint_events_cursor',
    },
  ],
  [WORKSPACE_TASK_OPERATIONS_COLLECTION]: [
    {
      key: { actorId: 1, projectId: 1, operationId: 1 },
      name: 'task_operation_actor_project_idempotency_unique',
      unique: true,
    },
    {
      key: { expiresAt: 1 },
      name: 'task_operation_expires_ttl',
      expireAfterSeconds: 0,
    },
  ],
};

export const WORKSPACE_COLLECTION_VALIDATORS: Record<
  string,
  Record<string, unknown>
> = {
  [WORKSPACE_TASKS_COLLECTION]: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id',
        'projectId',
        'title',
        'createdBy',
        'createdAt',
        'updatedAt',
        'status',
        'assigneeId',
        'completedAt',
        'version',
      ],
      additionalProperties: false,
      properties: {
        _id: { bsonType: 'objectId' },
        organizationId: { bsonType: 'objectId' },
        projectId: { bsonType: 'objectId' },
        key: { bsonType: 'string', minLength: 1, maxLength: 32 },
        title: { bsonType: 'string', minLength: 1, maxLength: 255 },
        description: { bsonType: ['string', 'null'], maxLength: 20000 },
        type: { bsonType: 'string', enum: [...WORKSPACE_TASK_TYPES] },
        status: { bsonType: 'string', enum: [...WORKSPACE_TASK_STATUSES] },
        priority: { bsonType: 'string', enum: [...WORKSPACE_TASK_PRIORITIES] },
        assigneeId: { bsonType: ['objectId', 'null'] },
        createdBy: { bsonType: 'objectId' },
        parentId: { bsonType: ['objectId', 'null'] },
        sprintId: { bsonType: ['objectId', 'null'] },
        labels: {
          bsonType: 'array',
          maxItems: 20,
          items: { bsonType: 'string', minLength: 1, maxLength: 40 },
        },
        steps: {
          bsonType: 'array',
          maxItems: 50,
          items: {
            bsonType: 'object',
            required: ['id', 'text', 'done'],
            additionalProperties: false,
            properties: {
              id: { bsonType: 'string', minLength: 1, maxLength: 64 },
              text: { bsonType: 'string', minLength: 1, maxLength: 500 },
              done: { bsonType: 'bool' },
            },
          },
        },
        dueDate: { bsonType: ['date', 'null'] },
        startDate: { bsonType: ['date', 'null'] },
        completedAt: { bsonType: ['date', 'null'] },
        createdAt: { bsonType: 'date' },
        updatedAt: { bsonType: 'date' },
        version: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      },
    },
  },
  [WORKSPACE_TASK_EVENTS_COLLECTION]: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id',
        'taskId',
        'projectId',
        'actorType',
        'actorId',
        'source',
        'operationId',
        'correlationId',
      ],
      additionalProperties: false,
      properties: {
        _id: { bsonType: 'objectId' },
        taskId: { bsonType: 'objectId' },
        projectId: { bsonType: 'objectId' },
        organizationId: { bsonType: 'objectId' },
        eventName: { bsonType: 'string', enum: ['TASK_CREATED'] },
        eventType: {
          bsonType: 'string',
          enum: [
            'TASK_CREATED',
            'TASK_STATUS_TRANSITIONED',
            'TASK_UPDATED',
            'TASK_COMMENT_ADDED',
            'TASK_WORKLOG_ADDED',
          ],
        },
        actorType: { bsonType: 'string', enum: ['USER', 'SYSTEM'] },
        actorId: { bsonType: 'objectId' },
        source: {
          bsonType: 'string',
          enum: ['HUMAN', 'WEB', 'API', 'INTERNAL_SERVICE'],
        },
        changedFields: {
          bsonType: 'array',
          items: { bsonType: 'string' },
        },
        taskVersion: { bsonType: ['int', 'long', 'double'], minimum: 1 },
        version: { bsonType: ['int', 'long', 'double'], minimum: 1 },
        occurredAt: { bsonType: 'date' },
        timestamp: { bsonType: 'date' },
        operationId: { bsonType: 'string', minLength: 1, maxLength: 128 },
        correlationId: { bsonType: 'string', minLength: 1, maxLength: 128 },
        delta: {
          bsonType: 'object',
          additionalProperties: false,
          properties: {
            type: {
              bsonType: 'string',
              enum: [
                'STATUS_TRANSITION',
                'FIELD_UPDATE',
                'COMMENT_ADDED',
                'WORKLOG_ADDED',
              ],
            },
            fromStatus: {
              bsonType: 'string',
              enum: [...WORKSPACE_TASK_STATUSES],
            },
            toStatus: {
              bsonType: 'string',
              enum: [...WORKSPACE_TASK_STATUSES],
            },
            reason: { bsonType: 'string', maxLength: 500 },
            changedFields: {
              bsonType: 'array',
              minItems: 1,
              items: { bsonType: 'string' },
            },
            fromSprintId: { bsonType: ['objectId', 'null'] },
            toSprintId: { bsonType: ['objectId', 'null'] },
            commentId: { bsonType: 'objectId' },
            worklogId: { bsonType: 'objectId' },
            minutes: {
              bsonType: ['int', 'long', 'double'],
              minimum: 1,
              maximum: 1440,
            },
          },
        },
      },
    },
  },
  [WORKSPACE_TASK_OPERATIONS_COLLECTION]: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id',
        'actorId',
        'projectId',
        'operationId',
        'fingerprint',
        'state',
        'taskId',
        'createdAt',
        'updatedAt',
        'leaseUntil',
        'expiresAt',
      ],
      additionalProperties: false,
      properties: {
        _id: { bsonType: 'objectId' },
        actorId: { bsonType: 'objectId' },
        projectId: { bsonType: 'objectId' },
        operationId: { bsonType: 'string', minLength: 1, maxLength: 128 },
        fingerprint: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
        state: {
          bsonType: 'string',
          enum: ['IN_PROGRESS', 'COMMITTED', 'REJECTED'],
        },
        taskId: { bsonType: 'objectId' },
        createdAt: { bsonType: 'date' },
        updatedAt: { bsonType: 'date' },
        leaseUntil: { bsonType: 'date' },
        expiresAt: { bsonType: 'date' },
        result: { bsonType: 'object' },
        httpResponse: {
          bsonType: 'object',
          required: ['statusCode', 'body'],
          additionalProperties: false,
          properties: {
            statusCode: { bsonType: ['int', 'long', 'double'] },
            body: {},
            etag: { bsonType: 'string' },
            location: { bsonType: 'string' },
          },
        },
      },
    },
  },
  [WORKSPACE_TASK_COMMENTS_COLLECTION]: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id',
        'taskId',
        'projectId',
        'organizationId',
        'authorId',
        'body',
        'createdAt',
      ],
      additionalProperties: false,
      properties: {
        _id: { bsonType: 'objectId' },
        taskId: { bsonType: 'objectId' },
        projectId: { bsonType: 'objectId' },
        organizationId: { bsonType: 'objectId' },
        authorId: { bsonType: 'objectId' },
        body: { bsonType: 'string', minLength: 1, maxLength: 5000 },
        createdAt: { bsonType: 'date' },
      },
    },
  },
  [WORKSPACE_TASK_WORKLOGS_COLLECTION]: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id',
        'taskId',
        'projectId',
        'organizationId',
        'authorId',
        'minutes',
        'note',
        'loggedAt',
        'createdAt',
      ],
      additionalProperties: false,
      properties: {
        _id: { bsonType: 'objectId' },
        taskId: { bsonType: 'objectId' },
        projectId: { bsonType: 'objectId' },
        organizationId: { bsonType: 'objectId' },
        authorId: { bsonType: 'objectId' },
        minutes: {
          bsonType: ['int', 'long', 'double'],
          minimum: 1,
          maximum: 1440,
        },
        note: { bsonType: ['string', 'null'], maxLength: 2000 },
        loggedAt: { bsonType: 'date' },
        createdAt: { bsonType: 'date' },
      },
    },
  },
  [WORKSPACE_PROJECT_SPRINTS_COLLECTION]: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id',
        'projectId',
        'organizationId',
        'name',
        'goal',
        'status',
        'startDate',
        'endDate',
        'createdBy',
        'createdAt',
        'completedAt',
        'version',
      ],
      additionalProperties: false,
      properties: {
        _id: { bsonType: 'objectId' },
        projectId: { bsonType: 'objectId' },
        organizationId: { bsonType: 'objectId' },
        name: { bsonType: 'string', minLength: 1, maxLength: 120 },
        goal: { bsonType: ['string', 'null'], maxLength: 1000 },
        status: { bsonType: 'string', enum: [...WORKSPACE_SPRINT_STATUSES] },
        startDate: { bsonType: ['date', 'null'] },
        endDate: { bsonType: ['date', 'null'] },
        createdBy: { bsonType: 'objectId' },
        createdAt: { bsonType: 'date' },
        completedAt: { bsonType: ['date', 'null'] },
        version: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      },
    },
  },
  [WORKSPACE_PROJECT_SPRINT_EVENTS_COLLECTION]: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id',
        'sprintId',
        'projectId',
        'organizationId',
        'eventType',
        'actorId',
        'actorType',
        'occurredAt',
        'version',
        'delta',
      ],
      additionalProperties: false,
      properties: {
        _id: { bsonType: 'objectId' },
        sprintId: { bsonType: 'objectId' },
        projectId: { bsonType: 'objectId' },
        organizationId: { bsonType: 'objectId' },
        eventType: {
          bsonType: 'string',
          enum: ['SPRINT_CREATED', 'SPRINT_UPDATED', 'SPRINT_COMPLETED'],
        },
        actorId: { bsonType: 'objectId' },
        actorType: { bsonType: 'string', enum: ['USER'] },
        occurredAt: { bsonType: 'date' },
        version: { bsonType: ['int', 'long', 'double'], minimum: 1 },
        delta: { bsonType: 'object' },
      },
    },
  },
};
