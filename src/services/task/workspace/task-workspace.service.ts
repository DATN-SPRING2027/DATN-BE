import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import {
  readCookie,
  validCsrfPair,
} from '../../iam/application/authentication/authentication.application.service';
import {
  TASK_WORKSPACE_IAM_BRIDGE,
  type TaskWorkspaceIamBridgePort,
} from './task-workspace-iam.bridge';
import {
  TASK_WORKSPACE_REPOSITORY,
  TaskWorkspaceRepository,
} from './task-workspace.repository';
import {
  ALLOWED_WORKSPACE_TRANSITIONS,
  WORKSPACE_SPRINT_STATUSES,
  WORKSPACE_TASK_PRIORITIES,
  WORKSPACE_TASK_STATUSES,
  WORKSPACE_TASK_TYPES,
  decodeDateRangeCursor,
  decodeOrgSummaryCursor,
  encodeDateRangeCursor,
  encodeOrgSummaryCursor,
  formatSprintETag,
  formatTaskETag,
  parseEntityIfMatch,
  requiresTransitionReason,
  type WorkspaceChecklistStep,
  type WorkspaceProjectSprintDocument,
  type WorkspaceSprintStatus,
  type WorkspaceSubtaskCounts,
  type WorkspaceTaskCommentDocument,
  type WorkspaceTaskDocument,
  type WorkspaceTaskPriority,
  type WorkspaceTaskStatus,
  type WorkspaceTaskType,
  type WorkspaceTaskWorklogDocument,
} from './task-workspace.types';

const OBJECT_ID_REGEX = /^[0-9a-f]{24}$/i;
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;

export interface WorkspaceHttpResult<T = unknown> {
  statusCode: number;
  body: T;
  etag?: string;
  location?: string;
  replayed?: boolean;
}

@Injectable()
export class TaskWorkspaceService {
  constructor(
    @Inject(TASK_WORKSPACE_REPOSITORY)
    private readonly repository: TaskWorkspaceRepository,
    @Inject(TASK_WORKSPACE_IAM_BRIDGE)
    private readonly iamBridge: TaskWorkspaceIamBridgePort,
  ) {}

  private assertValidCsrf(
    cookieHeader: string | undefined,
    csrfHeader: string | undefined,
  ): void {
    const trimmedHeader =
      typeof csrfHeader === 'string' ? csrfHeader.trim() : '';
    const cookieToken =
      readCookie(cookieHeader, '__Host-csrf') ??
      readCookie(cookieHeader, 'continuum_csrf') ??
      readCookie(cookieHeader, 'csrf_token');
    if (!validCsrfPair(cookieToken, trimmedHeader)) {
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_INVALID',
        message: 'Missing or invalid CSRF token.',
      });
    }
  }

  private assertValidIdempotencyKey(rawKey: string | undefined): string {
    if (
      typeof rawKey !== 'string' ||
      !IDEMPOTENCY_KEY_REGEX.test(rawKey.trim())
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message:
          'Idempotency-Key header is required and must match ^[A-Za-z0-9._:-]{1,128}$.',
      });
    }
    return rawKey.trim();
  }

  private assertObjectId(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || !OBJECT_ID_REGEX.test(value)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `Invalid ${fieldName} identifier.`,
      });
    }
    return value.toLowerCase();
  }

  private parseEntityVersionFromIfMatch(
    ifMatchHeader: string | undefined,
    prefix: 'task' | 'sprint',
    entityId: string,
  ): number {
    const parsed = parseEntityIfMatch(ifMatchHeader, prefix, entityId);
    if (parsed.kind === 'missing') {
      throw new HttpException(
        {
          code: 'PRECONDITION_REQUIRED',
          message: `If-Match header is required (${prefix}:<id>:<version>).`,
        },
        428,
      );
    }
    if (parsed.kind === 'invalid') {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `Invalid If-Match header format for ${prefix}.`,
      });
    }
    return parsed.version;
  }

  private computeFingerprint(
    method: string,
    path: string,
    payload: unknown,
  ): string {
    const canonical = JSON.stringify({ method, path, payload });
    return createHash('sha256').update(canonical).digest('hex');
  }

  private async claimOrReplayIdempotency(
    actorId: string,
    projectId: string,
    operationId: string,
    fingerprint: string,
    reuseMessage: string,
  ): Promise<WorkspaceHttpResult | null> {
    const claim = await this.repository.claimIdempotency({
      actorId,
      projectId,
      operationId,
      fingerprint,
    });
    if (claim.kind === 'CONFLICT_FINGERPRINT') {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: reuseMessage,
      });
    }
    if (claim.kind === 'IN_PROGRESS') {
      throw new ConflictException({
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message:
          'A request with this Idempotency-Key is currently in progress.',
      });
    }
    if (claim.kind === 'REPLAY') {
      const httpResponse = claim.record.httpResponse!;
      return {
        statusCode: httpResponse.statusCode,
        body: httpResponse.body,
        ...(httpResponse.etag ? { etag: httpResponse.etag } : {}),
        ...(httpResponse.location ? { location: httpResponse.location } : {}),
        replayed: true,
      };
    }
    return null;
  }

  private parseOptionalDate(value: unknown, fieldName: string): Date | null {
    if (value === null) return null;
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `${fieldName} must be an ISO-8601 date-time string or null.`,
      });
    }
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `${fieldName} must be a valid ISO-8601 date-time string.`,
      });
    }
    return parsed;
  }

  private parseLabels(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'labels must be an array of strings.',
      });
    }
    if (raw.length > 20) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'labels cannot exceed 20 items.',
      });
    }
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string') {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Each label must be a string.',
        });
      }
      const trimmed = item.trim();
      if (trimmed.length < 1 || trimmed.length > 40) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Each label must be between 1 and 40 characters.',
        });
      }
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
    return result;
  }

  private parseSteps(raw: unknown): WorkspaceChecklistStep[] {
    if (!Array.isArray(raw)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'steps must be an array of checklist items.',
      });
    }
    if (raw.length > 50) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'steps cannot exceed 50 items.',
      });
    }
    return raw.map((item, idx) => {
      if (typeof item !== 'object' || item === null) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: `steps[${idx}] must be an object.`,
        });
      }
      const rec = item as Record<string, unknown>;
      for (const k of Object.keys(rec)) {
        if (k !== 'id' && k !== 'text' && k !== 'done') {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: `Unsupported field in steps[${idx}]: ${k}.`,
          });
        }
      }
      const id =
        typeof rec.id === 'string' && rec.id.trim().length > 0
          ? rec.id.trim().slice(0, 64)
          : `step-${idx + 1}`;
      const text = typeof rec.text === 'string' ? rec.text.trim() : '';
      if (text.length < 1 || text.length > 500) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: `steps[${idx}].text must be between 1 and 500 characters.`,
        });
      }
      if (typeof rec.done !== 'boolean') {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: `steps[${idx}].done must be a boolean.`,
        });
      }
      return { id, text, done: rec.done };
    });
  }

  private serializeTask(
    doc: WorkspaceTaskDocument,
    subtaskCounts: WorkspaceSubtaskCounts = { total: 0, done: 0 },
  ) {
    return {
      id: doc._id.toHexString(),
      projectId: doc.projectId.toHexString(),
      key: doc.key,
      title: doc.title,
      type: doc.type,
      status: doc.status,
      priority: doc.priority,
      assigneeId: doc.assigneeId ? doc.assigneeId.toHexString() : null,
      createdBy: doc.createdBy.toHexString(),
      parentId: doc.parentId ? doc.parentId.toHexString() : null,
      sprintId: doc.sprintId ? doc.sprintId.toHexString() : null,
      labels: doc.labels ?? [],
      subtaskCounts,
      dueDate: doc.dueDate ? doc.dueDate.toISOString() : null,
      startDate: doc.startDate ? doc.startDate.toISOString() : null,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
      version: doc.version,
    };
  }

  private serializeTaskDetail(
    doc: WorkspaceTaskDocument,
    subtaskCounts: WorkspaceSubtaskCounts = { total: 0, done: 0 },
  ) {
    return {
      ...this.serializeTask(doc, subtaskCounts),
      description: doc.description ?? null,
      steps: doc.steps ?? [],
      completedAt: doc.completedAt ? doc.completedAt.toISOString() : null,
    };
  }

  private serializeComment(doc: WorkspaceTaskCommentDocument) {
    return {
      id: doc._id.toHexString(),
      taskId: doc.taskId.toHexString(),
      projectId: doc.projectId.toHexString(),
      authorId: doc.authorId.toHexString(),
      body: doc.body,
      createdAt: doc.createdAt.toISOString(),
    };
  }

  private serializeWorklog(doc: WorkspaceTaskWorklogDocument) {
    return {
      id: doc._id.toHexString(),
      taskId: doc.taskId.toHexString(),
      projectId: doc.projectId.toHexString(),
      authorId: doc.authorId.toHexString(),
      minutes: doc.minutes,
      note: doc.note ?? null,
      loggedAt: doc.loggedAt.toISOString(),
      createdAt: doc.createdAt.toISOString(),
    };
  }

  private serializeSprint(
    doc: WorkspaceProjectSprintDocument,
    counts: {
      totalTasks: number;
      doneTasks: number;
      inProgressTasks: number;
      todoTasks: number;
    } = { totalTasks: 0, doneTasks: 0, inProgressTasks: 0, todoTasks: 0 },
  ) {
    return {
      id: doc._id.toHexString(),
      projectId: doc.projectId.toHexString(),
      name: doc.name,
      goal: doc.goal ?? null,
      status: doc.status,
      startDate: doc.startDate ? doc.startDate.toISOString() : null,
      endDate: doc.endDate ? doc.endDate.toISOString() : null,
      createdBy: doc.createdBy.toHexString(),
      createdAt: doc.createdAt.toISOString(),
      completedAt: doc.completedAt ? doc.completedAt.toISOString() : null,
      version: doc.version,
      counts,
    };
  }

  private parseTaskListQuery(
    query: Record<string, unknown>,
    options: { actorId: string; isOrgScope?: boolean },
  ) {
    const allowedQueryKeys = options.isOrgScope
      ? new Set([
          'limit',
          'afterId',
          'cursor',
          'projectId',
          'status',
          'assigneeId',
          'dueFrom',
          'dueTo',
        ])
      : new Set([
          'limit',
          'afterId',
          'cursor',
          'status',
          'assigneeId',
          'priority',
          'type',
          'parentId',
          'sprintId',
          'dueFrom',
          'dueDate',
          'dueTo',
          'q',
          'organizationId',
        ]);
    for (const k of Object.keys(query)) {
      if (!allowedQueryKeys.has(k)) {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_FAILED',
          message: `Unsupported query parameter: ${k}.`,
        });
      }
    }

    const limitRaw = query.limit !== undefined ? Number(query.limit) : 50;
    if (!Number.isSafeInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'limit must be an integer between 1 and 100.',
      });
    }

    let statuses: WorkspaceTaskStatus[] | undefined;
    if (typeof query.status === 'string' && query.status.trim().length > 0) {
      const parts = query.status.split(',').map((s) => s.trim());
      if (parts.length > 6) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'status filter accepts at most 6 values.',
        });
      }
      for (const p of parts) {
        if (!WORKSPACE_TASK_STATUSES.includes(p as WorkspaceTaskStatus)) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: `Unsupported status filter value: ${p}.`,
          });
        }
      }
      statuses = [...new Set(parts)] as WorkspaceTaskStatus[];
    }

    let priorities: WorkspaceTaskPriority[] | undefined;
    if (
      typeof query.priority === 'string' &&
      query.priority.trim().length > 0
    ) {
      const parts = query.priority.split(',').map((s) => s.trim());
      if (parts.length > 3) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'priority filter accepts at most 3 values.',
        });
      }
      for (const p of parts) {
        if (!WORKSPACE_TASK_PRIORITIES.includes(p as WorkspaceTaskPriority)) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: `Unsupported priority filter value: ${p}.`,
          });
        }
      }
      priorities = [...new Set(parts)] as WorkspaceTaskPriority[];
    }

    let types: WorkspaceTaskType[] | undefined;
    if (typeof query.type === 'string' && query.type.trim().length > 0) {
      const parts = query.type.split(',').map((s) => s.trim());
      if (parts.length > 3) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'type filter accepts at most 3 values.',
        });
      }
      for (const p of parts) {
        if (!WORKSPACE_TASK_TYPES.includes(p as WorkspaceTaskType)) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: `Unsupported type filter value: ${p}.`,
          });
        }
      }
      types = [...new Set(parts)] as WorkspaceTaskType[];
    }

    let assigneeId: string | undefined;
    if (
      typeof query.assigneeId === 'string' &&
      query.assigneeId.trim().length > 0
    ) {
      const val = query.assigneeId.trim();
      if (!options.isOrgScope && val === 'me') {
        assigneeId = options.actorId.toLowerCase();
      } else if (val === 'none') {
        assigneeId = 'none';
      } else if (OBJECT_ID_REGEX.test(val)) {
        assigneeId = val.toLowerCase();
      } else {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message:
            'assigneeId must be a 24-hex ObjectId, "me" (project scope), or "none".',
        });
      }
    }

    let parentId: string | undefined;
    if (
      typeof query.parentId === 'string' &&
      query.parentId.trim().length > 0
    ) {
      const val = query.parentId.trim();
      if (val !== 'none' && !OBJECT_ID_REGEX.test(val)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'parentId must be a 24-hex ObjectId or "none".',
        });
      }
      parentId = val === 'none' ? 'none' : val.toLowerCase();
    }

    let sprintId: string | undefined;
    if (
      typeof query.sprintId === 'string' &&
      query.sprintId.trim().length > 0
    ) {
      const val = query.sprintId.trim();
      if (val !== 'none' && !OBJECT_ID_REGEX.test(val)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'sprintId must be a 24-hex ObjectId or "none".',
        });
      }
      sprintId = val === 'none' ? 'none' : val.toLowerCase();
    }

    const dueDateNone = query.dueDate === 'none';
    if (
      query.dueDate !== undefined &&
      query.dueDate !== '' &&
      query.dueDate !== 'none'
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'dueDate filter only supports "none".',
      });
    }

    const dueFrom =
      typeof query.dueFrom === 'string' && query.dueFrom.trim().length > 0
        ? (this.parseOptionalDate(query.dueFrom, 'dueFrom') ?? undefined)
        : undefined;
    const dueTo =
      typeof query.dueTo === 'string' && query.dueTo.trim().length > 0
        ? (this.parseOptionalDate(query.dueTo, 'dueTo') ?? undefined)
        : undefined;

    if (dueDateNone && (dueFrom || dueTo)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'dueDate=none cannot be combined with dueFrom or dueTo.',
      });
    }
    if (dueFrom && dueTo && dueFrom > dueTo) {
      throw new UnprocessableEntityException({
        code: 'INVALID_DATE_RANGE',
        message: 'dueFrom must be earlier than or equal to dueTo.',
      });
    }
    if (
      dueFrom &&
      dueTo &&
      dueTo.getTime() - dueFrom.getTime() > 100 * 24 * 60 * 60 * 1000
    ) {
      throw new UnprocessableEntityException({
        code: 'INVALID_DATE_RANGE',
        message: 'dueTo - dueFrom cannot exceed 100 days.',
      });
    }

    let q: string | undefined;
    if (typeof query.q === 'string' && query.q.trim().length > 0) {
      q = query.q.trim();
      if (q.length < 2 || q.length > 100) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'q must be between 2 and 100 characters.',
        });
      }
    }

    const isDateRange = Boolean(dueFrom || dueTo);
    let afterId: string | undefined;
    let dateCursor: { dueDate: Date; id: string } | undefined;

    const hasAfterIdParam =
      typeof query.afterId === 'string' && query.afterId.trim().length > 0;
    const hasCursorParam =
      typeof query.cursor === 'string' && query.cursor.trim().length > 0;

    if (hasAfterIdParam && hasCursorParam) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'afterId and cursor are mutually exclusive.',
      });
    }
    if (isDateRange && hasAfterIdParam) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Use cursor instead of afterId when dueFrom/dueTo is set.',
      });
    }

    if (hasAfterIdParam) {
      afterId = this.assertObjectId(query.afterId, 'afterId');
    } else if (hasCursorParam) {
      const rawCursor = (query.cursor as string).trim();
      if (isDateRange) {
        const decoded = decodeDateRangeCursor(rawCursor);
        if (!decoded) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: 'Invalid date-range pagination cursor.',
          });
        }
        dateCursor = decoded;
      } else {
        if (!OBJECT_ID_REGEX.test(rawCursor)) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: 'Invalid pagination cursor.',
          });
        }
        afterId = rawCursor.toLowerCase();
      }
    }

    return {
      limit: limitRaw,
      statuses,
      assigneeId,
      priorities,
      types,
      parentId,
      sprintId,
      dueFrom,
      dueTo,
      dueDateNone,
      q,
      afterId,
      dateCursor,
    };
  }

  private assertCanModifyTask(
    actorRole: 'ADMIN' | 'TEAM_LEADER' | 'MEMBER',
    actorId: string,
    task: WorkspaceTaskDocument,
  ): void {
    if (actorRole === 'ADMIN' || actorRole === 'TEAM_LEADER') return;
    const isCreator = task.createdBy.toHexString() === actorId;
    const isAssignee =
      task.assigneeId !== null && task.assigneeId.toHexString() === actorId;
    if (!isCreator && !isAssignee) {
      throw new ForbiddenException({
        code: 'INSUFFICIENT_PERMISSION',
        message:
          'Members can only modify or transition tasks they created or are assigned to.',
      });
    }
  }

  private assertCanManageSprint(
    actorRole: 'ADMIN' | 'TEAM_LEADER' | 'MEMBER',
  ): void {
    if (actorRole !== 'ADMIN' && actorRole !== 'TEAM_LEADER') {
      throw new ForbiddenException({
        code: 'INSUFFICIENT_PERMISSION',
        message:
          'Only Team Leaders and Organization Managers can manage sprints.',
      });
    }
  }

  async listProjectTasks(params: {
    authorizationHeader?: string;
    cookieHeader?: string;
    headerOrgId?: string;
    projectId: string;
    query: Record<string, unknown>;
  }): Promise<WorkspaceHttpResult> {
    const queryOrgId =
      typeof params.query.organizationId === 'string'
        ? params.query.organizationId
        : undefined;
    const ctx = await this.iamBridge.resolveProjectContext(
      params.authorizationHeader,
      params.cookieHeader,
      params.projectId,
      params.headerOrgId,
      queryOrgId,
    );

    const parsed = this.parseTaskListQuery(params.query, {
      actorId: ctx.actorId,
      isOrgScope: false,
    });
    const { items, isDateRange } = await this.repository.listTasks({
      organizationId: ctx.organizationId,
      projectId: ctx.projectId,
      ...parsed,
      limit: parsed.limit + 1,
    });

    const hasMore = items.length > parsed.limit;
    const pageItems = hasMore ? items.slice(0, parsed.limit) : items;

    const topLevelIds = pageItems
      .filter((t) => t.parentId === null)
      .map((t) => t._id);
    const subtaskCountsMap = await this.repository.getSubtaskCountsMap(
      [new Types.ObjectId(ctx.projectId)],
      topLevelIds,
    );

    let nextAfterId: string | null = null;
    let nextCursor: string | null = null;
    if (hasMore && pageItems.length > 0) {
      const last = pageItems[pageItems.length - 1];
      if (isDateRange && last.dueDate) {
        nextCursor = encodeDateRangeCursor(
          last.dueDate,
          last._id.toHexString(),
        );
      } else {
        nextAfterId = last._id.toHexString();
      }
    }

    return {
      statusCode: 200,
      body: {
        items: pageItems.map((doc) =>
          this.serializeTask(
            doc,
            subtaskCountsMap.get(doc._id.toHexString()) ?? {
              total: 0,
              done: 0,
            },
          ),
        ),
        nextAfterId,
        nextCursor,
      },
    };
  }

  async getProjectTask(params: {
    authorizationHeader?: string;
    cookieHeader?: string;
    headerOrgId?: string;
    projectId: string;
    taskId: string;
  }): Promise<WorkspaceHttpResult> {
    const ctx = await this.iamBridge.resolveProjectContext(
      params.authorizationHeader,
      params.cookieHeader,
      params.projectId,
      params.headerOrgId,
    );
    const taskId = this.assertObjectId(params.taskId, 'taskId');
    const task = await this.repository.getTaskById(ctx.projectId, taskId);
    if (!task) {
      throw new NotFoundException({
        code: 'TASK_NOT_FOUND',
        message: 'Task not found.',
      });
    }

    const subtaskCountsMap =
      task.parentId === null
        ? await this.repository.getSubtaskCountsMap(
            [new Types.ObjectId(ctx.projectId)],
            [task._id],
          )
        : new Map<string, WorkspaceSubtaskCounts>();

    return {
      statusCode: 200,
      etag: formatTaskETag(task._id.toHexString(), task.version),
      body: this.serializeTaskDetail(
        task,
        subtaskCountsMap.get(task._id.toHexString()) ?? { total: 0, done: 0 },
      ),
    };
  }

  async createProjectTask(params: {
    authorizationHeader?: string;
    cookieHeader?: string;
    csrfHeader?: string;
    idempotencyKeyHeader?: string;
    headerOrgId?: string;
    correlationId?: string;
    projectId: string;
    body: unknown;
  }): Promise<WorkspaceHttpResult> {
    this.assertValidCsrf(params.cookieHeader, params.csrfHeader);
    const operationId = this.assertValidIdempotencyKey(
      params.idempotencyKeyHeader,
    );
    const ctx = await this.iamBridge.resolveProjectContext(
      params.authorizationHeader,
      params.cookieHeader,
      params.projectId,
      params.headerOrgId,
    );

    if (typeof params.body !== 'object' || params.body === null) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Request body must be a JSON object.',
      });
    }
    const raw = params.body as Record<string, unknown>;
    const allowedKeys = new Set([
      'title',
      'description',
      'type',
      'priority',
      'assigneeId',
      'dueDate',
      'startDate',
      'parentId',
      'sprintId',
      'labels',
      'steps',
    ]);
    for (const key of Object.keys(raw)) {
      if (!allowedKeys.has(key)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: `Unsupported field in CreateTaskInput: ${key}.`,
        });
      }
    }

    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (title.length < 1 || title.length > 255) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'title is required and must be between 1 and 255 characters.',
      });
    }

    let description: string | null = null;
    if (raw.description !== undefined && raw.description !== null) {
      if (
        typeof raw.description !== 'string' ||
        raw.description.length > 20000
      ) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'description must be a string up to 20000 characters.',
        });
      }
      description = raw.description;
    }

    const type: WorkspaceTaskType =
      raw.type !== undefined ? (raw.type as WorkspaceTaskType) : 'TASK';
    if (!WORKSPACE_TASK_TYPES.includes(type)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'type must be one of TASK, BUG, STORY.',
      });
    }

    const priority: WorkspaceTaskPriority =
      raw.priority !== undefined
        ? (raw.priority as WorkspaceTaskPriority)
        : 'MEDIUM';
    if (!WORKSPACE_TASK_PRIORITIES.includes(priority)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'priority must be one of LOW, MEDIUM, HIGH.',
      });
    }

    const assigneeId =
      raw.assigneeId !== undefined && raw.assigneeId !== null
        ? this.assertObjectId(raw.assigneeId, 'assigneeId')
        : null;
    const parentId =
      raw.parentId !== undefined && raw.parentId !== null
        ? this.assertObjectId(raw.parentId, 'parentId')
        : null;
    const sprintId =
      raw.sprintId !== undefined && raw.sprintId !== null
        ? this.assertObjectId(raw.sprintId, 'sprintId')
        : null;

    const dueDate =
      raw.dueDate !== undefined
        ? this.parseOptionalDate(raw.dueDate, 'dueDate')
        : null;
    const startDate =
      raw.startDate !== undefined
        ? this.parseOptionalDate(raw.startDate, 'startDate')
        : null;

    if (startDate && dueDate && startDate > dueDate) {
      throw new UnprocessableEntityException({
        code: 'INVALID_DATE_RANGE',
        message: 'startDate must be earlier than or equal to dueDate.',
      });
    }

    const labels = raw.labels !== undefined ? this.parseLabels(raw.labels) : [];
    const steps = raw.steps !== undefined ? this.parseSteps(raw.steps) : [];

    const normalizedPayload = {
      title,
      description,
      type,
      priority,
      assigneeId,
      parentId,
      sprintId,
      dueDate: dueDate ? dueDate.toISOString() : null,
      startDate: startDate ? startDate.toISOString() : null,
      labels,
      steps,
    };
    const fingerprint = this.computeFingerprint(
      'POST',
      `/tasks/projects/${ctx.projectId}/tasks`,
      normalizedPayload,
    );

    const replayed = await this.claimOrReplayIdempotency(
      ctx.actorId,
      ctx.projectId,
      operationId,
      fingerprint,
      'Idempotency-Key was already used with a different request payload.',
    );
    if (replayed) return replayed;

    try {
      if (assigneeId) {
        const isMember = await this.iamBridge.isActiveProjectMember(
          ctx.organizationId,
          ctx.projectId,
          assigneeId,
        );
        if (!isMember) {
          throw new UnprocessableEntityException({
            code: 'ASSIGNEE_NOT_IN_PROJECT',
            message: 'assigneeId must be an active member of the project.',
          });
        }
      }

      if (parentId) {
        const parentTask = await this.repository.getTaskById(
          ctx.projectId,
          parentId,
        );
        if (!parentTask) {
          throw new NotFoundException({
            code: 'TASK_NOT_FOUND',
            message: 'Parent task not found in this project.',
          });
        }
        if (parentTask.parentId !== null) {
          throw new UnprocessableEntityException({
            code: 'TASK_SUBTASK_DEPTH_EXCEEDED',
            message: 'Subtasks cannot be nested more than one level deep.',
          });
        }
        if (parentTask.status === 'CANCELLED') {
          throw new UnprocessableEntityException({
            code: 'PARENT_TASK_CANCELLED',
            message: 'Cannot attach a subtask to a cancelled parent task.',
          });
        }
      }

      if (sprintId) {
        const sprint = await this.repository.getSprintById(
          ctx.projectId,
          sprintId,
        );
        if (!sprint) {
          throw new NotFoundException({
            code: 'SPRINT_NOT_FOUND',
            message: 'Sprint not found in this project.',
          });
        }
        if (sprint.status === 'COMPLETED') {
          throw new UnprocessableEntityException({
            code: 'SPRINT_COMPLETED_IMMUTABLE',
            message: 'Cannot assign tasks to a completed sprint.',
          });
        }
      }

      const created = await this.repository.createTaskWithEvent({
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        projectCode: ctx.projectCode,
        actorId: ctx.actorId,
        operationId,
        correlationId: params.correlationId ?? randomUUID(),
        title,
        description,
        type,
        priority,
        assigneeId,
        parentId,
        sprintId,
        labels,
        steps,
        dueDate,
        startDate,
        idempotency: {
          actorId: ctx.actorId,
          projectId: ctx.projectId,
          operationId,
          fingerprint,
          getEntityId: (doc) => doc._id,
          buildResponse: (doc) => ({
            statusCode: 201,
            body: this.serializeTaskDetail(doc, { total: 0, done: 0 }),
            etag: formatTaskETag(doc._id.toHexString(), doc.version),
            location: `/api/v1/tasks/projects/${ctx.projectId}/tasks/${doc._id.toHexString()}`,
          }),
        },
      });

      const responseBody = this.serializeTaskDetail(created, {
        total: 0,
        done: 0,
      });
      const etag = formatTaskETag(created._id.toHexString(), created.version);
      const location = `/api/v1/tasks/projects/${ctx.projectId}/tasks/${created._id.toHexString()}`;

      return {
        statusCode: 201,
        body: responseBody,
        etag,
        location,
      };
    } catch (error) {
      await this.repository.releaseIdempotency(
        ctx.actorId,
        ctx.projectId,
        operationId,
      );
      throw error;
    }
  }

  async updateProjectTask(params: {
    authorizationHeader?: string;
    cookieHeader?: string;
    csrfHeader?: string;
    ifMatchHeader?: string;
    headerOrgId?: string;
    correlationId?: string;
    projectId: string;
    taskId: string;
    body: unknown;
  }): Promise<WorkspaceHttpResult> {
    this.assertValidCsrf(params.cookieHeader, params.csrfHeader);
    const ctx = await this.iamBridge.resolveProjectContext(
      params.authorizationHeader,
      params.cookieHeader,
      params.projectId,
      params.headerOrgId,
    );
    const taskId = this.assertObjectId(params.taskId, 'taskId');
    const expectedVersion = this.parseEntityVersionFromIfMatch(
      params.ifMatchHeader,
      'task',
      taskId,
    );

    if (typeof params.body !== 'object' || params.body === null) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Request body must be a JSON object.',
      });
    }
    const raw = params.body as Record<string, unknown>;
    const allowedKeys = new Set([
      'title',
      'description',
      'type',
      'priority',
      'assigneeId',
      'dueDate',
      'startDate',
      'parentId',
      'sprintId',
      'labels',
      'steps',
    ]);
    const providedKeys = Object.keys(raw);
    if (providedKeys.length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'UpdateTaskInput must specify at least one mutable field.',
      });
    }
    for (const key of providedKeys) {
      if (!allowedKeys.has(key)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: `Field '${key}' is not mutable via PATCH (use /transitions for status).`,
        });
      }
    }

    const existing = await this.repository.getTaskById(ctx.projectId, taskId);
    if (!existing) {
      throw new NotFoundException({
        code: 'TASK_NOT_FOUND',
        message: 'Task not found.',
      });
    }

    this.assertCanModifyTask(ctx.actorRole, ctx.actorId, existing);

    if (existing.version !== expectedVersion) {
      throw new ConflictException({
        code: 'TASK_VERSION_CONFLICT',
        message: 'Task was modified by another request.',
        details: {
          expectedVersion,
          currentVersion: existing.version,
        },
      });
    }

    const updates: Record<string, unknown> = {};
    const changedFields: string[] = [];

    if (raw.title !== undefined) {
      const title = typeof raw.title === 'string' ? raw.title.trim() : '';
      if (title.length < 1 || title.length > 255) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'title must be between 1 and 255 characters.',
        });
      }
      updates.title = title;
      changedFields.push('title');
    }

    if (raw.description !== undefined) {
      if (
        raw.description !== null &&
        (typeof raw.description !== 'string' || raw.description.length > 20000)
      ) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message:
            'description must be a string up to 20000 characters or null.',
        });
      }
      updates.description = raw.description;
      changedFields.push('description');
    }

    if (raw.type !== undefined) {
      if (!WORKSPACE_TASK_TYPES.includes(raw.type as WorkspaceTaskType)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'type must be one of TASK, BUG, STORY.',
        });
      }
      updates.type = raw.type;
      changedFields.push('type');
    }

    if (raw.priority !== undefined) {
      if (
        !WORKSPACE_TASK_PRIORITIES.includes(
          raw.priority as WorkspaceTaskPriority,
        )
      ) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'priority must be one of LOW, MEDIUM, HIGH.',
        });
      }
      updates.priority = raw.priority;
      changedFields.push('priority');
    }

    if (raw.assigneeId !== undefined) {
      if (raw.assigneeId === null) {
        updates.assigneeId = null;
      } else {
        const assigneeId = this.assertObjectId(raw.assigneeId, 'assigneeId');
        const isMember = await this.iamBridge.isActiveProjectMember(
          ctx.organizationId,
          ctx.projectId,
          assigneeId,
        );
        if (!isMember) {
          throw new UnprocessableEntityException({
            code: 'ASSIGNEE_NOT_IN_PROJECT',
            message: 'assigneeId must be an active member of the project.',
          });
        }
        updates.assigneeId = new Types.ObjectId(assigneeId);
      }
      changedFields.push('assigneeId');
    }

    if (raw.parentId !== undefined) {
      if (raw.parentId === null) {
        updates.parentId = null;
      } else {
        const parentId = this.assertObjectId(raw.parentId, 'parentId');
        if (parentId === taskId) {
          throw new UnprocessableEntityException({
            code: 'TASK_SUBTASK_DEPTH_EXCEEDED',
            message: 'A task cannot be its own parent.',
          });
        }
        const childCount = await this.repository.countSubtasksOfTask(
          ctx.projectId,
          taskId,
        );
        if (childCount > 0) {
          throw new UnprocessableEntityException({
            code: 'TASK_SUBTASK_DEPTH_EXCEEDED',
            message:
              'A task that already has subtasks cannot become a subtask.',
          });
        }
        const parentTask = await this.repository.getTaskById(
          ctx.projectId,
          parentId,
        );
        if (!parentTask) {
          throw new NotFoundException({
            code: 'TASK_NOT_FOUND',
            message: 'Parent task not found in this project.',
          });
        }
        if (parentTask.parentId !== null) {
          throw new UnprocessableEntityException({
            code: 'TASK_SUBTASK_DEPTH_EXCEEDED',
            message: 'Subtasks cannot be nested more than one level deep.',
          });
        }
        if (parentTask.status === 'CANCELLED') {
          throw new UnprocessableEntityException({
            code: 'PARENT_TASK_CANCELLED',
            message: 'Cannot attach a subtask to a cancelled parent task.',
          });
        }
        updates.parentId = new Types.ObjectId(parentId);
      }
      changedFields.push('parentId');
    }

    let fromSprintId: Types.ObjectId | null | undefined;
    let toSprintId: Types.ObjectId | null | undefined;
    if (raw.sprintId !== undefined) {
      fromSprintId = existing.sprintId ?? null;
      if (raw.sprintId === null) {
        updates.sprintId = null;
        toSprintId = null;
      } else {
        const sprintId = this.assertObjectId(raw.sprintId, 'sprintId');
        const sprint = await this.repository.getSprintById(
          ctx.projectId,
          sprintId,
        );
        if (!sprint) {
          throw new NotFoundException({
            code: 'SPRINT_NOT_FOUND',
            message: 'Sprint not found in this project.',
          });
        }
        if (sprint.status === 'COMPLETED') {
          throw new UnprocessableEntityException({
            code: 'SPRINT_COMPLETED_IMMUTABLE',
            message: 'Cannot assign tasks to a completed sprint.',
          });
        }
        toSprintId = new Types.ObjectId(sprintId);
        updates.sprintId = toSprintId;
      }
      changedFields.push('sprintId');
    }

    const nextDueDate =
      raw.dueDate !== undefined
        ? this.parseOptionalDate(raw.dueDate, 'dueDate')
        : existing.dueDate;
    const nextStartDate =
      raw.startDate !== undefined
        ? this.parseOptionalDate(raw.startDate, 'startDate')
        : existing.startDate;

    if (nextStartDate && nextDueDate && nextStartDate > nextDueDate) {
      throw new UnprocessableEntityException({
        code: 'INVALID_DATE_RANGE',
        message: 'startDate must be earlier than or equal to dueDate.',
      });
    }

    if (raw.dueDate !== undefined) {
      updates.dueDate = nextDueDate;
      changedFields.push('dueDate');
    }
    if (raw.startDate !== undefined) {
      updates.startDate = nextStartDate;
      changedFields.push('startDate');
    }

    if (raw.labels !== undefined) {
      updates.labels = this.parseLabels(raw.labels);
      changedFields.push('labels');
    }

    if (raw.steps !== undefined) {
      updates.steps = this.parseSteps(raw.steps);
      changedFields.push('steps');
    }

    const outcome = await this.repository.updateTaskFields({
      organizationId: ctx.organizationId,
      projectId: ctx.projectId,
      taskId,
      actorId: ctx.actorId,
      expectedVersion,
      correlationId: params.correlationId ?? randomUUID(),
      updates,
      changedFields,
      fromSprintId,
      toSprintId,
    });

    if (outcome.kind === 'NOT_FOUND') {
      throw new NotFoundException({
        code: 'TASK_NOT_FOUND',
        message: 'Task not found.',
      });
    }
    if (outcome.kind === 'CONFLICT') {
      throw new ConflictException({
        code: 'TASK_VERSION_CONFLICT',
        message: 'Task was modified by another request.',
        details: {
          expectedVersion,
          currentVersion: outcome.currentVersion,
        },
      });
    }

    const subtaskCountsMap =
      outcome.task.parentId === null
        ? await this.repository.getSubtaskCountsMap(
            [new Types.ObjectId(ctx.projectId)],
            [outcome.task._id],
          )
        : new Map<string, WorkspaceSubtaskCounts>();

    return {
      statusCode: 200,
      etag: formatTaskETag(
        outcome.task._id.toHexString(),
        outcome.task.version,
      ),
      body: this.serializeTaskDetail(
        outcome.task,
        subtaskCountsMap.get(outcome.task._id.toHexString()) ?? {
          total: 0,
          done: 0,
        },
      ),
    };
  }

  async transitionProjectTask(params: {
    authorizationHeader?: string;
    cookieHeader?: string;
    csrfHeader?: string;
    ifMatchHeader?: string;
    idempotencyKeyHeader?: string;
    headerOrgId?: string;
    correlationId?: string;
    projectId: string;
    taskId: string;
    body: unknown;
  }): Promise<WorkspaceHttpResult> {
    this.assertValidCsrf(params.cookieHeader, params.csrfHeader);
    const operationId = this.assertValidIdempotencyKey(
      params.idempotencyKeyHeader,
    );
    const ctx = await this.iamBridge.resolveProjectContext(
      params.authorizationHeader,
      params.cookieHeader,
      params.projectId,
      params.headerOrgId,
    );
    const taskId = this.assertObjectId(params.taskId, 'taskId');
    const expectedVersion = this.parseEntityVersionFromIfMatch(
      params.ifMatchHeader,
      'task',
      taskId,
    );

    if (typeof params.body !== 'object' || params.body === null) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Request body must be a JSON object.',
      });
    }
    const raw = params.body as Record<string, unknown>;
    const allowedKeys = new Set(['fromStatus', 'toStatus', 'reason']);
    for (const key of Object.keys(raw)) {
      if (!allowedKeys.has(key)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: `Unsupported field in TransitionTaskInput: ${key}.`,
        });
      }
    }

    const requestedFromStatus =
      raw.fromStatus !== undefined && raw.fromStatus !== null
        ? (raw.fromStatus as WorkspaceTaskStatus)
        : undefined;
    const toStatus = raw.toStatus as WorkspaceTaskStatus;
    if (
      (requestedFromStatus !== undefined &&
        !WORKSPACE_TASK_STATUSES.includes(requestedFromStatus)) ||
      !WORKSPACE_TASK_STATUSES.includes(toStatus)
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'fromStatus and toStatus must be valid TaskStatus values.',
      });
    }

    let reason: string | undefined;
    if (raw.reason !== undefined && raw.reason !== null) {
      if (typeof raw.reason !== 'string' || raw.reason.trim().length > 500) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'reason must be a string up to 500 characters.',
        });
      }
      reason = raw.reason.trim();
    }

    const fingerprint = this.computeFingerprint(
      'POST',
      `/tasks/projects/${ctx.projectId}/tasks/${taskId}/transitions`,
      {
        fromStatus: requestedFromStatus ?? null,
        toStatus,
        reason: reason ?? null,
      },
    );

    const replayed = await this.claimOrReplayIdempotency(
      ctx.actorId,
      ctx.projectId,
      operationId,
      fingerprint,
      'Idempotency-Key was already used with a different transition payload.',
    );
    if (replayed) return replayed;

    try {
      const existing = await this.repository.getTaskById(ctx.projectId, taskId);
      if (!existing) {
        throw new NotFoundException({
          code: 'TASK_NOT_FOUND',
          message: 'Task not found.',
        });
      }

      this.assertCanModifyTask(ctx.actorRole, ctx.actorId, existing);

      if (existing.version !== expectedVersion) {
        throw new ConflictException({
          code: 'TASK_VERSION_CONFLICT',
          message: 'Task version does not match If-Match header.',
          details: {
            expectedVersion,
            currentVersion: existing.version,
            currentStatus: existing.status,
          },
        });
      }

      const fromStatus = requestedFromStatus ?? existing.status;
      if (existing.status !== fromStatus) {
        throw new ConflictException({
          code: 'TASK_STATUS_CONFLICT',
          message: 'Task current status does not match fromStatus.',
          details: {
            expectedFromStatus: fromStatus,
            actualStatus: existing.status,
            currentVersion: existing.version,
            currentStatus: existing.status,
          },
        });
      }

      if (!ALLOWED_WORKSPACE_TRANSITIONS.has(`${fromStatus}:${toStatus}`)) {
        throw new UnprocessableEntityException({
          code: 'TASK_TRANSITION_NOT_ALLOWED',
          message: `Transition from ${fromStatus} to ${toStatus} is not allowed.`,
        });
      }

      if (
        requiresTransitionReason(fromStatus, toStatus) &&
        (!reason || reason.length < 5)
      ) {
        throw new UnprocessableEntityException({
          code: 'TASK_TRANSITION_REASON_REQUIRED',
          message: `Transition from ${fromStatus} to ${toStatus} requires a reason of at least 5 characters.`,
        });
      }

      const outcome = await this.repository.transitionTaskStatus({
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        taskId,
        actorId: ctx.actorId,
        expectedVersion,
        fromStatus,
        toStatus,
        reason,
        operationId,
        correlationId: params.correlationId ?? randomUUID(),
        idempotency: {
          actorId: ctx.actorId,
          projectId: ctx.projectId,
          operationId,
          fingerprint,
          getEntityId: (res) => res.task._id,
          buildResponse: (res) => ({
            statusCode: 200,
            body: this.serializeTaskDetail(res.task, res.subtaskCounts),
            etag: formatTaskETag(res.task._id.toHexString(), res.task.version),
          }),
        },
      });

      if (outcome.kind === 'NOT_FOUND') {
        throw new NotFoundException({
          code: 'TASK_NOT_FOUND',
          message: 'Task not found.',
        });
      }
      if (outcome.kind === 'CONFLICT') {
        throw new ConflictException({
          code: 'TASK_VERSION_CONFLICT',
          message: 'Task was modified concurrently.',
          details: {
            expectedVersion,
            currentVersion: outcome.currentVersion,
          },
        });
      }

      const body = this.serializeTaskDetail(
        outcome.task,
        outcome.subtaskCounts,
      );
      const etag = formatTaskETag(
        outcome.task._id.toHexString(),
        outcome.task.version,
      );

      return {
        statusCode: 200,
        etag,
        body,
      };
    } catch (error) {
      await this.repository.releaseIdempotency(
        ctx.actorId,
        ctx.projectId,
        operationId,
      );
      throw error;
    }
  }

  async listTaskHistory(params: {
    authorizationHeader?: string;
    cookieHeader?: string;
    headerOrgId?: string;
    projectId: string;
    taskId: string;
    query: Record<string, unknown>;
  }): Promise<WorkspaceHttpResult> {
    const ctx = await this.iamBridge.resolveProjectContext(
      params.authorizationHeader,
      params.cookieHeader,
      params.projectId,
      params.headerOrgId,
    );
    const taskId = this.assertObjectId(params.taskId, 'taskId');
    for (const k of Object.keys(params.query)) {
      if (k !== 'page' && k !== 'limit') {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_FAILED',
          message: `Unsupported query parameter: ${k}.`,
        });
      }
    }
    const page =
      params.query.page !== undefined ? Number(params.query.page) : 1;
    const limit =
      params.query.limit !== undefined ? Number(params.query.limit) : 20;

    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'page (>=1) and limit (1..100) must be valid integers.',
      });
    }

    const task = await this.repository.getTaskById(ctx.projectId, taskId);
    if (!task) {
      throw new NotFoundException({
        code: 'TASK_NOT_FOUND',
        message: 'Task not found.',
      });
    }

    const { events, hasNext } = await this.repository.listTaskHistory(
      ctx.projectId,
      taskId,
      page,
      limit,
    );

    const actorIds = events.map((e) => e.actorId.toHexString());
    const usersMap = await this.iamBridge.resolveUsersById(actorIds);

    const data = events.map((event) => {
      const eventType = event.eventType ?? event.eventName ?? 'TASK_CREATED';
      const occurredAt = (
        event.occurredAt ??
        event.timestamp ??
        new Date()
      ).toISOString();
      const version = event.version ?? event.taskVersion ?? 1;
      const actorId = event.actorId.toHexString();
      const actorName = usersMap.get(actorId)?.fullName ?? 'User';

      const entry: Record<string, unknown> = {
        id: event._id.toHexString(),
        type: eventType,
        actor: {
          id: actorId,
          fullName: actorName,
        },
        occurredAt,
        version,
      };

      if (eventType === 'TASK_CREATED') {
        entry.changedFields = event.changedFields ?? [
          'projectId',
          'title',
          'createdBy',
          'createdAt',
          'updatedAt',
          'version',
        ];
      } else if (eventType === 'TASK_STATUS_TRANSITIONED') {
        entry.fromStatus = event.delta?.fromStatus ?? 'TODO';
        entry.toStatus = event.delta?.toStatus ?? 'IN_PROGRESS';
        if (event.delta?.reason) {
          entry.reason = event.delta.reason;
        }
      } else if (eventType === 'TASK_UPDATED') {
        entry.changedFields = event.delta?.changedFields ??
          event.changedFields ?? ['updatedAt'];
        if (event.delta?.fromSprintId !== undefined) {
          entry.fromSprintId = event.delta.fromSprintId
            ? event.delta.fromSprintId.toHexString()
            : null;
        }
        if (event.delta?.toSprintId !== undefined) {
          entry.toSprintId = event.delta.toSprintId
            ? event.delta.toSprintId.toHexString()
            : null;
        }
        if (event.delta?.reason) {
          entry.reason = event.delta.reason;
        }
      } else if (eventType === 'TASK_COMMENT_ADDED') {
        entry.commentId = (event.delta?.commentId ?? event._id).toHexString();
      } else {
        entry.worklogId = (event.delta?.worklogId ?? event._id).toHexString();
        entry.minutes = event.delta?.minutes ?? 1;
      }

      return entry;
    });

    return {
      statusCode: 200,
      body: {
        data,
        pagination: {
          page,
          limit,
          hasNext,
        },
      },
    };
  }

  async listTaskComments(params: {
    authorizationHeader?: string;
    cookieHeader?: string;
    headerOrgId?: string;
    projectId: string;
    taskId: string;
    query: Record<string, unknown>;
  }): Promise<WorkspaceHttpResult> {
    const ctx = await this.iamBridge.resolveProjectContext(
      params.authorizationHeader,
      params.cookieHeader,
      params.projectId,
      params.headerOrgId,
    );
    const taskId = this.assertObjectId(params.taskId, 'taskId');
    for (const k of Object.keys(params.query)) {
      if (k !== 'limit' && k !== 'afterId' && k !== 'cursor') {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_FAILED',
          message: `Unsupported query parameter: ${k}.`,
        });
      }
    }
    const limit =
      params.query.limit !== undefined ? Number(params.query.limit) : 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'limit must be an integer between 1 and 100.',
      });
    }
    const rawAfterId =
      typeof params.query.afterId === 'string' &&
      params.query.afterId.trim().length > 0
        ? params.query.afterId.trim()
        : typeof params.query.cursor === 'string' &&
            params.query.cursor.trim().length > 0
          ? params.query.cursor.trim()
          : undefined;
    const afterId = rawAfterId
      ? this.assertObjectId(rawAfterId, 'afterId')
      : undefined;

    const task = await this.repository.getTaskById(ctx.projectId, taskId);
    if (!task) {
      throw new NotFoundException({
        code: 'TASK_NOT_FOUND',
        message: 'Task not found.',
      });
    }

    const rows = await this.repository.listTaskComments(
      ctx.projectId,
      taskId,
      limit + 1,
      afterId,
    );
    const hasMore = rows.length > limit;
    const pageItems = hasMore ? rows.slice(0, limit) : rows;
    const nextAfterId =
      hasMore && pageItems.length > 0
        ? pageItems[pageItems.length - 1]._id.toHexString()
        : null;

    return {
      statusCode: 200,
      body: {
        items: pageItems.map((c) => this.serializeComment(c)),
        nextAfterId,
      },
    };
  }

  async createTaskComment(params: {
    authorizationHeader?: string;
    cookieHeader?: string;
    csrfHeader?: string;
    idempotencyKeyHeader?: string;
    headerOrgId?: string;
    correlationId?: string;
    projectId: string;
    taskId: string;
    body: unknown;
  }): Promise<WorkspaceHttpResult> {
    this.assertValidCsrf(params.cookieHeader, params.csrfHeader);
    const operationId = this.assertValidIdempotencyKey(
      params.idempotencyKeyHeader,
    );
    const ctx = await this.iamBridge.resolveProjectContext(
      params.authorizationHeader,
      params.cookieHeader,
      params.projectId,
      params.headerOrgId,
    );
    const taskId = this.assertObjectId(params.taskId, 'taskId');

    if (typeof params.body !== 'object' || params.body === null) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Request body must be a JSON object.',
      });
    }
    const raw = params.body as Record<string, unknown>;
    for (const k of Object.keys(raw)) {
      if (k !== 'body') {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: `Unsupported field in TaskCommentCreateRequest: ${k}.`,
        });
      }
    }
    const bodyText = typeof raw.body === 'string' ? raw.body.trim() : '';
    if (bodyText.length < 1 || bodyText.length > 5000) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Comment body must be between 1 and 5000 characters.',
      });
    }

    const fingerprint = this.computeFingerprint(
      'POST',
      `/tasks/projects/${ctx.projectId}/tasks/${taskId}/comments`,
      { body: bodyText },
    );

    const replayed = await this.claimOrReplayIdempotency(
      ctx.actorId,
      ctx.projectId,
      operationId,
      fingerprint,
      'Idempotency-Key was already used with a different comment payload.',
    );
    if (replayed) return replayed;

    try {
      const task = await this.repository.getTaskById(ctx.projectId, taskId);
      if (!task) {
        throw new NotFoundException({
          code: 'TASK_NOT_FOUND',
          message: 'Task not found.',
        });
      }

      const comment = await this.repository.createTaskComment({
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        taskId,
        taskVersion: task.version,
        authorId: ctx.actorId,
        body: bodyText,
        operationId,
        correlationId: params.correlationId ?? randomUUID(),
        idempotency: {
          actorId: ctx.actorId,
          projectId: ctx.projectId,
          operationId,
          fingerprint,
          getEntityId: () => task._id,
          buildResponse: (doc) => ({
            statusCode: 201,
            body: this.serializeComment(doc),
          }),
        },
      });

      return {
        statusCode: 201,
        body: this.serializeComment(comment),
      };
    } catch (error) {
      await this.repository.releaseIdempotency(
        ctx.actorId,
        ctx.projectId,
        operationId,
      );
      throw error;
    }
  }

  async listTaskWorklogs(params: {
    authorizationHeader?: string;
    cookieHeader?: string;
    headerOrgId?: string;
    projectId: string;
    taskId: string;
    query: Record<string, unknown>;
  }): Promise<WorkspaceHttpResult> {
    const ctx = await this.iamBridge.resolveProjectContext(
      params.authorizationHeader,
      params.cookieHeader,
      params.projectId,
      params.headerOrgId,
    );
    const taskId = this.assertObjectId(params.taskId, 'taskId');
    for (const k of Object.keys(params.query)) {
      if (k !== 'limit' && k !== 'afterId' && k !== 'cursor') {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_FAILED',
          message: `Unsupported query parameter: ${k}.`,
        });
      }
    }
    const limit =
      params.query.limit !== undefined ? Number(params.query.limit) : 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'limit must be an integer between 1 and 100.',
      });
    }
    const rawAfterId =
      typeof params.query.afterId === 'string' &&
      params.query.afterId.trim().length > 0
        ? params.query.afterId.trim()
        : typeof params.query.cursor === 'string' &&
            params.query.cursor.trim().length > 0
          ? params.query.cursor.trim()
          : undefined;
    const afterId = rawAfterId
      ? this.assertObjectId(rawAfterId, 'afterId')
      : undefined;

    const task = await this.repository.getTaskById(ctx.projectId, taskId);
    if (!task) {
      throw new NotFoundException({
        code: 'TASK_NOT_FOUND',
        message: 'Task not found.',
      });
    }

    const { items, totalMinutes } = await this.repository.listTaskWorklogs(
      ctx.projectId,
      taskId,
      limit + 1,
      afterId,
    );
    const hasMore = items.length > limit;
    const pageItems = hasMore ? items.slice(0, limit) : items;
    const nextAfterId =
      hasMore && pageItems.length > 0
        ? pageItems[pageItems.length - 1]._id.toHexString()
        : null;

    return {
      statusCode: 200,
      body: {
        items: pageItems.map((w) => this.serializeWorklog(w)),
        totalMinutes,
        nextAfterId,
      },
    };
  }

  async createTaskWorklog(params: {
    authorizationHeader?: string;
    cookieHeader?: string;
    csrfHeader?: string;
    idempotencyKeyHeader?: string;
    headerOrgId?: string;
    correlationId?: string;
    projectId: string;
    taskId: string;
    body: unknown;
  }): Promise<WorkspaceHttpResult> {
    this.assertValidCsrf(params.cookieHeader, params.csrfHeader);
    const operationId = this.assertValidIdempotencyKey(
      params.idempotencyKeyHeader,
    );
    const ctx = await this.iamBridge.resolveProjectContext(
      params.authorizationHeader,
      params.cookieHeader,
      params.projectId,
      params.headerOrgId,
    );
    const taskId = this.assertObjectId(params.taskId, 'taskId');

    if (typeof params.body !== 'object' || params.body === null) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Request body must be a JSON object.',
      });
    }
    const raw = params.body as Record<string, unknown>;
    for (const k of Object.keys(raw)) {
      if (k !== 'minutes' && k !== 'note' && k !== 'loggedAt') {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: `Unsupported field in TaskWorklogCreateRequest: ${k}.`,
        });
      }
    }
    const minutes = Number(raw.minutes);
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'minutes must be an integer between 1 and 1440.',
      });
    }

    let note: string | null = null;
    if (raw.note !== undefined && raw.note !== null) {
      if (typeof raw.note !== 'string' || raw.note.trim().length > 2000) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'note must be a string up to 2000 characters.',
        });
      }
      note = raw.note.trim();
    }

    const loggedAt =
      raw.loggedAt !== undefined && raw.loggedAt !== null
        ? (this.parseOptionalDate(raw.loggedAt, 'loggedAt') ?? new Date())
        : new Date();

    const fingerprint = this.computeFingerprint(
      'POST',
      `/tasks/projects/${ctx.projectId}/tasks/${taskId}/worklogs`,
      {
        minutes,
        note,
        loggedAt:
          raw.loggedAt !== undefined && raw.loggedAt !== null
            ? loggedAt.toISOString()
            : null,
      },
    );

    const replayed = await this.claimOrReplayIdempotency(
      ctx.actorId,
      ctx.projectId,
      operationId,
      fingerprint,
      'Idempotency-Key was already used with a different worklog payload.',
    );
    if (replayed) return replayed;

    try {
      const task = await this.repository.getTaskById(ctx.projectId, taskId);
      if (!task) {
        throw new NotFoundException({
          code: 'TASK_NOT_FOUND',
          message: 'Task not found.',
        });
      }

      const worklog = await this.repository.createTaskWorklog({
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        taskId,
        taskVersion: task.version,
        authorId: ctx.actorId,
        minutes,
        note,
        loggedAt,
        operationId,
        correlationId: params.correlationId ?? randomUUID(),
        idempotency: {
          actorId: ctx.actorId,
          projectId: ctx.projectId,
          operationId,
          fingerprint,
          getEntityId: () => task._id,
          buildResponse: (doc) => ({
            statusCode: 201,
            body: this.serializeWorklog(doc),
          }),
        },
      });

      return {
        statusCode: 201,
        body: this.serializeWorklog(worklog),
      };
    } catch (error) {
      await this.repository.releaseIdempotency(
        ctx.actorId,
        ctx.projectId,
        operationId,
      );
      throw error;
    }
  }

  async listProjectSprints(params: {
    authorizationHeader?: string;
    cookieHeader?: string;
    headerOrgId?: string;
    projectId: string;
    query: Record<string, unknown>;
  }): Promise<WorkspaceHttpResult> {
    const ctx = await this.iamBridge.resolveProjectContext(
      params.authorizationHeader,
      params.cookieHeader,
      params.projectId,
      params.headerOrgId,
    );

    for (const k of Object.keys(params.query)) {
      if (k !== 'status') {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_FAILED',
          message: `Unsupported query parameter: ${k}.`,
        });
      }
    }

    let statusFilter: WorkspaceSprintStatus | undefined;
    if (
      typeof params.query.status === 'string' &&
      params.query.status.trim().length > 0
    ) {
      const s = params.query.status.trim() as WorkspaceSprintStatus;
      if (!WORKSPACE_SPRINT_STATUSES.includes(s)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'status filter must be one of PLANNED, ACTIVE, COMPLETED.',
        });
      }
      statusFilter = s;
    }

    const rows = await this.repository.listProjectSprints(
      ctx.projectId,
      statusFilter,
    );

    return {
      statusCode: 200,
      body: {
        items: rows.map(({ sprint, counts }) =>
          this.serializeSprint(sprint, counts),
        ),
      },
    };
  }

  async createProjectSprint(params: {
    authorizationHeader?: string;
    cookieHeader?: string;
    csrfHeader?: string;
    idempotencyKeyHeader?: string;
    headerOrgId?: string;
    projectId: string;
    body: unknown;
  }): Promise<WorkspaceHttpResult> {
    this.assertValidCsrf(params.cookieHeader, params.csrfHeader);
    const operationId = this.assertValidIdempotencyKey(
      params.idempotencyKeyHeader,
    );
    const ctx = await this.iamBridge.resolveProjectContext(
      params.authorizationHeader,
      params.cookieHeader,
      params.projectId,
      params.headerOrgId,
    );
    this.assertCanManageSprint(ctx.actorRole);

    if (typeof params.body !== 'object' || params.body === null) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Request body must be a JSON object.',
      });
    }
    const raw = params.body as Record<string, unknown>;
    const allowedKeys = new Set(['name', 'goal', 'startDate', 'endDate']);
    for (const k of Object.keys(raw)) {
      if (!allowedKeys.has(k)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: `Unsupported field in ProjectSprintCreateRequest: ${k}.`,
        });
      }
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (name.length < 1 || name.length > 120) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'name is required and must be between 1 and 120 characters.',
      });
    }

    let goal: string | null = null;
    if (raw.goal !== undefined && raw.goal !== null) {
      if (typeof raw.goal !== 'string' || raw.goal.trim().length > 1000) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'goal must be a string up to 1000 characters.',
        });
      }
      goal = raw.goal.trim();
    }

    const startDate =
      raw.startDate !== undefined
        ? this.parseOptionalDate(raw.startDate, 'startDate')
        : null;
    const endDate =
      raw.endDate !== undefined
        ? this.parseOptionalDate(raw.endDate, 'endDate')
        : null;

    if (startDate && endDate && startDate > endDate) {
      throw new UnprocessableEntityException({
        code: 'INVALID_DATE_RANGE',
        message: 'startDate must be earlier than or equal to endDate.',
      });
    }

    const fingerprint = this.computeFingerprint(
      'POST',
      `/tasks/projects/${ctx.projectId}/sprints`,
      {
        name,
        goal,
        startDate: startDate ? startDate.toISOString() : null,
        endDate: endDate ? endDate.toISOString() : null,
      },
    );

    const replayed = await this.claimOrReplayIdempotency(
      ctx.actorId,
      ctx.projectId,
      operationId,
      fingerprint,
      'Idempotency-Key was already used with a different sprint payload.',
    );
    if (replayed) return replayed;

    try {
      const sprint = await this.repository.createProjectSprint({
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        actorId: ctx.actorId,
        name,
        goal,
        startDate,
        endDate,
        idempotency: {
          actorId: ctx.actorId,
          projectId: ctx.projectId,
          operationId,
          fingerprint,
          getEntityId: (doc) => doc._id,
          buildResponse: (doc) => ({
            statusCode: 201,
            body: this.serializeSprint(doc),
            etag: formatSprintETag(doc._id.toHexString(), doc.version),
          }),
        },
      });

      const responseBody = this.serializeSprint(sprint);
      const etag = formatSprintETag(sprint._id.toHexString(), sprint.version);

      return {
        statusCode: 201,
        etag,
        body: responseBody,
      };
    } catch (error) {
      await this.repository.releaseIdempotency(
        ctx.actorId,
        ctx.projectId,
        operationId,
      );
      throw error;
    }
  }

  async updateProjectSprint(params: {
    authorizationHeader?: string;
    cookieHeader?: string;
    csrfHeader?: string;
    ifMatchHeader?: string;
    headerOrgId?: string;
    projectId: string;
    sprintId: string;
    body: unknown;
  }): Promise<WorkspaceHttpResult> {
    this.assertValidCsrf(params.cookieHeader, params.csrfHeader);
    const ctx = await this.iamBridge.resolveProjectContext(
      params.authorizationHeader,
      params.cookieHeader,
      params.projectId,
      params.headerOrgId,
    );
    this.assertCanManageSprint(ctx.actorRole);

    const sprintId = this.assertObjectId(params.sprintId, 'sprintId');
    const expectedVersion = this.parseEntityVersionFromIfMatch(
      params.ifMatchHeader,
      'sprint',
      sprintId,
    );

    if (typeof params.body !== 'object' || params.body === null) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Request body must be a JSON object.',
      });
    }
    const raw = params.body as Record<string, unknown>;
    const allowedKeys = new Set([
      'name',
      'goal',
      'status',
      'startDate',
      'endDate',
    ]);
    const providedKeys = Object.keys(raw);
    if (providedKeys.length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'UpdateSprintInput must specify at least one field.',
      });
    }
    for (const k of providedKeys) {
      if (!allowedKeys.has(k)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: `Unsupported field in UpdateSprintInput: ${k}.`,
        });
      }
    }

    const existing = await this.repository.getSprintById(
      ctx.projectId,
      sprintId,
    );
    if (!existing) {
      throw new NotFoundException({
        code: 'SPRINT_NOT_FOUND',
        message: 'Sprint not found.',
      });
    }
    if (existing.version !== expectedVersion) {
      throw new ConflictException({
        code: 'SPRINT_VERSION_CONFLICT',
        message: 'Sprint version does not match If-Match header.',
        details: {
          expectedVersion,
          currentVersion: existing.version,
        },
      });
    }
    if (existing.status === 'COMPLETED') {
      throw new UnprocessableEntityException({
        code: 'SPRINT_COMPLETED_IMMUTABLE',
        message: 'Completed sprints cannot be modified.',
      });
    }

    const updates: Partial<{
      name: string;
      goal: string | null;
      status: 'PLANNED' | 'ACTIVE';
      startDate: Date | null;
      endDate: Date | null;
    }> = {};

    if (raw.name !== undefined) {
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (name.length < 1 || name.length > 120) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'name must be between 1 and 120 characters.',
        });
      }
      updates.name = name;
    }

    if (raw.goal !== undefined) {
      if (
        raw.goal !== null &&
        (typeof raw.goal !== 'string' || raw.goal.trim().length > 1000)
      ) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'goal must be a string up to 1000 characters or null.',
        });
      }
      updates.goal = raw.goal === null ? null : raw.goal.trim();
    }

    if (raw.status !== undefined) {
      if (raw.status !== 'PLANNED' && raw.status !== 'ACTIVE') {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message:
            'status in PATCH must be PLANNED or ACTIVE (use /complete to complete a sprint).',
        });
      }
      updates.status = raw.status;
    }

    const nextStartDate =
      raw.startDate !== undefined
        ? this.parseOptionalDate(raw.startDate, 'startDate')
        : existing.startDate;
    const nextEndDate =
      raw.endDate !== undefined
        ? this.parseOptionalDate(raw.endDate, 'endDate')
        : existing.endDate;

    if (nextStartDate && nextEndDate && nextStartDate > nextEndDate) {
      throw new UnprocessableEntityException({
        code: 'INVALID_DATE_RANGE',
        message: 'startDate must be earlier than or equal to endDate.',
      });
    }

    if (raw.startDate !== undefined) updates.startDate = nextStartDate;
    if (raw.endDate !== undefined) updates.endDate = nextEndDate;

    const outcome = await this.repository.updateProjectSprint({
      organizationId: ctx.organizationId,
      projectId: ctx.projectId,
      sprintId,
      actorId: ctx.actorId,
      expectedVersion,
      updates,
    });

    if (outcome.kind === 'NOT_FOUND') {
      throw new NotFoundException({
        code: 'SPRINT_NOT_FOUND',
        message: 'Sprint not found.',
      });
    }
    if (outcome.kind === 'VERSION_CONFLICT') {
      throw new ConflictException({
        code: 'SPRINT_VERSION_CONFLICT',
        message: 'Sprint was modified concurrently.',
        details: {
          expectedVersion,
          currentVersion: outcome.currentVersion,
        },
      });
    }
    if (outcome.kind === 'ALREADY_ACTIVE') {
      throw new ConflictException({
        code: 'SPRINT_ALREADY_ACTIVE',
        message: 'Another sprint is already ACTIVE in this project.',
      });
    }

    const allSprints = await this.repository.listProjectSprints(ctx.projectId);
    const matching = allSprints.find(
      (s) => s.sprint._id.toHexString() === sprintId,
    );

    return {
      statusCode: 200,
      etag: formatSprintETag(
        outcome.sprint._id.toHexString(),
        outcome.sprint.version,
      ),
      body: this.serializeSprint(outcome.sprint, matching?.counts),
    };
  }

  async completeProjectSprint(params: {
    authorizationHeader?: string;
    cookieHeader?: string;
    csrfHeader?: string;
    ifMatchHeader?: string;
    idempotencyKeyHeader?: string;
    headerOrgId?: string;
    correlationId?: string;
    projectId: string;
    sprintId: string;
    body: unknown;
  }): Promise<WorkspaceHttpResult> {
    this.assertValidCsrf(params.cookieHeader, params.csrfHeader);
    const operationId = this.assertValidIdempotencyKey(
      params.idempotencyKeyHeader,
    );
    const ctx = await this.iamBridge.resolveProjectContext(
      params.authorizationHeader,
      params.cookieHeader,
      params.projectId,
      params.headerOrgId,
    );
    this.assertCanManageSprint(ctx.actorRole);

    const sprintId = this.assertObjectId(params.sprintId, 'sprintId');
    const expectedVersion = this.parseEntityVersionFromIfMatch(
      params.ifMatchHeader,
      'sprint',
      sprintId,
    );

    const raw =
      typeof params.body === 'object' && params.body !== null
        ? (params.body as Record<string, unknown>)
        : {};
    for (const k of Object.keys(raw)) {
      if (k !== 'moveIncompleteToSprintId') {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: `Unsupported field in ProjectSprintCompleteRequest: ${k}.`,
        });
      }
    }
    const moveIncompleteToSprintId =
      raw.moveIncompleteToSprintId !== undefined &&
      raw.moveIncompleteToSprintId !== null
        ? this.assertObjectId(
            raw.moveIncompleteToSprintId,
            'moveIncompleteToSprintId',
          )
        : null;

    const fingerprint = this.computeFingerprint(
      'POST',
      `/tasks/projects/${ctx.projectId}/sprints/${sprintId}/complete`,
      { moveIncompleteToSprintId },
    );

    const replayed = await this.claimOrReplayIdempotency(
      ctx.actorId,
      ctx.projectId,
      operationId,
      fingerprint,
      'Idempotency-Key was already used with a different completeSprint payload.',
    );
    if (replayed) return replayed;

    try {
      const outcome = await this.repository.completeProjectSprint({
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        sprintId,
        actorId: ctx.actorId,
        expectedVersion,
        moveIncompleteToSprintId,
        correlationId: params.correlationId ?? randomUUID(),
        idempotency: {
          actorId: ctx.actorId,
          projectId: ctx.projectId,
          operationId,
          fingerprint,
          getEntityId: (res) => res.sprint._id,
          buildResponse: (res) => ({
            statusCode: 200,
            body: this.serializeSprint(res.sprint, res.counts),
            etag: formatSprintETag(
              res.sprint._id.toHexString(),
              res.sprint.version,
            ),
          }),
        },
      });

      if (outcome.kind === 'NOT_FOUND') {
        throw new NotFoundException({
          code: 'SPRINT_NOT_FOUND',
          message: 'Sprint not found.',
        });
      }
      if (outcome.kind === 'VERSION_CONFLICT') {
        throw new ConflictException({
          code: 'SPRINT_VERSION_CONFLICT',
          message: 'Sprint or its tasks were modified concurrently.',
          details: {
            expectedVersion,
            currentVersion: outcome.currentVersion,
          },
        });
      }
      if (outcome.kind === 'NOT_ACTIVE') {
        throw new UnprocessableEntityException({
          code: 'SPRINT_NOT_ACTIVE',
          message: 'Only an ACTIVE sprint can be completed.',
        });
      }
      if (outcome.kind === 'TARGET_SPRINT_INVALID') {
        throw new UnprocessableEntityException({
          code: 'TARGET_SPRINT_INVALID',
          message:
            'moveIncompleteToSprintId must reference a PLANNED sprint in the same project.',
        });
      }

      const responseBody = this.serializeSprint(outcome.sprint, outcome.counts);
      const etag = formatSprintETag(
        outcome.sprint._id.toHexString(),
        outcome.sprint.version,
      );

      return {
        statusCode: 200,
        etag,
        body: responseBody,
      };
    } catch (error) {
      await this.repository.releaseIdempotency(
        ctx.actorId,
        ctx.projectId,
        operationId,
      );
      throw error;
    }
  }

  async getProjectTaskSummary(params: {
    authorizationHeader?: string;
    cookieHeader?: string;
    headerOrgId?: string;
    projectId: string;
  }): Promise<WorkspaceHttpResult> {
    const ctx = await this.iamBridge.resolveProjectContext(
      params.authorizationHeader,
      params.cookieHeader,
      params.projectId,
      params.headerOrgId,
    );
    const summary = await this.repository.getProjectTaskSummary(
      ctx.organizationId,
      ctx.projectId,
      new Date(),
    );
    return {
      statusCode: 200,
      body: summary,
    };
  }

  async listOrganizationTasks(params: {
    authorizationHeader?: string;
    cookieHeader?: string;
    query: Record<string, unknown>;
  }): Promise<WorkspaceHttpResult> {
    const adminCtx = await this.iamBridge.resolveOrgAdminContext(
      params.authorizationHeader,
      params.cookieHeader,
    );

    const parsed = this.parseTaskListQuery(params.query, {
      actorId: adminCtx.actorId,
      isOrgScope: true,
    });

    let projectId: string | undefined;
    if (
      typeof params.query.projectId === 'string' &&
      params.query.projectId.trim().length > 0
    ) {
      projectId = this.assertObjectId(
        params.query.projectId.trim(),
        'projectId',
      );
    }

    const [projects, { items, isDateRange }] = await Promise.all([
      this.iamBridge.listOrganizationProjects(adminCtx.organizationId),
      this.repository.listTasks({
        organizationId: adminCtx.organizationId,
        projectId,
        ...parsed,
        limit: parsed.limit + 1,
      }),
    ]);

    const projectMap = new Map(projects.map((p) => [p.id, p]));
    const hasMore = items.length > parsed.limit;
    const pageItems = hasMore ? items.slice(0, parsed.limit) : items;

    const topLevelIds = pageItems
      .filter((t) => t.parentId === null)
      .map((t) => t._id);
    const distinctProjectIds = [
      ...new Set(pageItems.map((t) => t.projectId.toHexString())),
    ].map((id) => new Types.ObjectId(id));

    const subtaskCountsMap = await this.repository.getSubtaskCountsMap(
      distinctProjectIds,
      topLevelIds,
    );

    let nextAfterId: string | null = null;
    let nextCursor: string | null = null;
    if (hasMore && pageItems.length > 0) {
      const last = pageItems[pageItems.length - 1];
      if (isDateRange && last.dueDate) {
        nextCursor = encodeDateRangeCursor(
          last.dueDate,
          last._id.toHexString(),
        );
      } else {
        nextAfterId = last._id.toHexString();
      }
    }

    return {
      statusCode: 200,
      body: {
        items: pageItems.map((doc) => {
          const pId = doc.projectId.toHexString();
          const pMeta = projectMap.get(pId);
          return {
            ...this.serializeTask(
              doc,
              subtaskCountsMap.get(doc._id.toHexString()) ?? {
                total: 0,
                done: 0,
              },
            ),
            projectName: pMeta?.name ?? 'Project',
            projectCode: pMeta?.code ?? (doc.key.split('-')[0] || 'TASK'),
          };
        }),
        nextAfterId,
        nextCursor,
      },
    };
  }

  async getOrganizationTaskSummary(params: {
    authorizationHeader?: string;
    cookieHeader?: string;
    query: Record<string, unknown>;
  }): Promise<WorkspaceHttpResult> {
    const adminCtx = await this.iamBridge.resolveOrgAdminContext(
      params.authorizationHeader,
      params.cookieHeader,
    );

    for (const k of Object.keys(params.query)) {
      if (k !== 'limit' && k !== 'cursor') {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_FAILED',
          message: `Unsupported query parameter: ${k}.`,
        });
      }
    }

    const limit =
      params.query.limit !== undefined ? Number(params.query.limit) : 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'limit must be an integer between 1 and 200.',
      });
    }

    let cursorTuple:
      | {
          overdue: number;
          total: number;
          projectId: string;
          asOf?: Date;
          seen?: string[];
        }
      | undefined;
    if (
      typeof params.query.cursor === 'string' &&
      params.query.cursor.trim().length > 0
    ) {
      const decoded = decodeOrgSummaryCursor(params.query.cursor.trim());
      if (!decoded) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Invalid organization summary pagination cursor.',
        });
      }
      cursorTuple = decoded;
    }

    const asOf = cursorTuple?.asOf ?? new Date();
    const [projects, { statusBuckets, overdueBuckets }] = await Promise.all([
      this.iamBridge.listOrganizationProjects(adminCtx.organizationId),
      this.repository.getOrganizationTaskAggregates(
        adminCtx.organizationId,
        asOf,
        Boolean(cursorTuple?.asOf),
      ),
    ]);

    const perProjectMap = new Map<
      string,
      {
        projectId: string;
        projectName: string;
        projectCode: string;
        total: number;
        inProgress: number;
        overdue: number;
        statusMap: Map<string, number>;
      }
    >();

    for (const p of projects) {
      perProjectMap.set(p.id, {
        projectId: p.id,
        projectName: p.name,
        projectCode: p.code,
        total: 0,
        inProgress: 0,
        overdue: 0,
        statusMap: new Map<string, number>(),
      });
    }

    let orgTotal = 0;
    let orgInProgress = 0;

    for (const row of statusBuckets) {
      const pId = row._id.p.toHexString();
      const s = row._id.s;
      orgTotal += row.n;
      if (s === 'IN_PROGRESS' || s === 'IN_REVIEW' || s === 'BLOCKED') {
        orgInProgress += row.n;
      }

      let entry = perProjectMap.get(pId);
      if (!entry) {
        entry = {
          projectId: pId,
          projectName: 'Project',
          projectCode: 'TASK',
          total: 0,
          inProgress: 0,
          overdue: 0,
          statusMap: new Map<string, number>(),
        };
        perProjectMap.set(pId, entry);
      }
      entry.total += row.n;
      entry.statusMap.set(s, (entry.statusMap.get(s) ?? 0) + row.n);
      if (s === 'IN_PROGRESS' || s === 'IN_REVIEW' || s === 'BLOCKED') {
        entry.inProgress += row.n;
      }
    }

    let orgOverdue = 0;
    for (const row of overdueBuckets) {
      const pId = row._id.toHexString();
      orgOverdue += row.n;
      const entry = perProjectMap.get(pId);
      if (entry) {
        entry.overdue = row.n;
      }
    }

    const sortedProjects = [...perProjectMap.values()].sort((a, b) => {
      if (b.overdue !== a.overdue) return b.overdue - a.overdue;
      if (b.total !== a.total) return b.total - a.total;
      return a.projectId.localeCompare(b.projectId);
    });

    const seenSet = cursorTuple?.seen ? new Set(cursorTuple.seen) : null;
    const filteredProjects = cursorTuple
      ? seenSet
        ? sortedProjects.filter(
            (item) => !seenSet.has(item.projectId.toLowerCase()),
          )
        : sortedProjects.filter((item) => {
            if (item.overdue !== cursorTuple.overdue) {
              return item.overdue < cursorTuple.overdue;
            }
            if (item.total !== cursorTuple.total) {
              return item.total < cursorTuple.total;
            }
            return item.projectId > cursorTuple.projectId;
          })
      : sortedProjects;

    const hasMore = filteredProjects.length > limit;
    const pageProjects = hasMore
      ? filteredProjects.slice(0, limit)
      : filteredProjects;
    const nextSeen = [
      ...(cursorTuple?.seen ?? []),
      ...pageProjects.map((p) => p.projectId.toLowerCase()),
    ].slice(0, 500);
    const nextCursor =
      hasMore && pageProjects.length > 0
        ? encodeOrgSummaryCursor(
            pageProjects[pageProjects.length - 1].overdue,
            pageProjects[pageProjects.length - 1].total,
            pageProjects[pageProjects.length - 1].projectId,
            {
              asOf: asOf.toISOString(),
              seen: nextSeen,
            },
          )
        : null;

    return {
      statusCode: 200,
      body: {
        asOf: asOf.toISOString(),
        totals: {
          total: orgTotal,
          inProgress: orgInProgress,
          overdue: orgOverdue,
        },
        projects: pageProjects.map((p) => ({
          projectId: p.projectId,
          projectName: p.projectName,
          projectCode: p.projectCode,
          total: p.total,
          inProgress: p.inProgress,
          overdue: p.overdue,
          byStatus: [...p.statusMap.entries()].map(([key, count]) => ({
            key,
            count,
          })),
        })),
        nextCursor,
      },
    };
  }
}
