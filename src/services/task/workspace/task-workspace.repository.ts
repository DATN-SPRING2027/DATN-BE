import {
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import mongoose, { Types, type Connection } from 'mongoose';
import { IAM_PERSISTENCE } from '../../iam/infrastructure/persistence';
import {
  WORKSPACE_PROJECT_SPRINTS_COLLECTION,
  WORKSPACE_PROJECT_SPRINT_EVENTS_COLLECTION,
  WORKSPACE_TASKS_COLLECTION,
  WORKSPACE_TASK_COMMENTS_COLLECTION,
  WORKSPACE_TASK_COUNTERS_COLLECTION,
  WORKSPACE_TASK_DATABASE_NAME,
  WORKSPACE_TASK_EVENTS_COLLECTION,
  WORKSPACE_TASK_OPERATIONS_COLLECTION,
  WORKSPACE_TASK_WORKLOGS_COLLECTION,
  escapeLiteralRegex,
  type WorkspaceChecklistStep,
  type WorkspaceIdempotencyRecord,
  type WorkspaceProjectSprintDocument,
  type WorkspaceProjectSprintEventDocument,
  type WorkspaceSprintStatus,
  type WorkspaceSubtaskCounts,
  type WorkspaceTaskCommentDocument,
  type WorkspaceTaskDocument,
  type WorkspaceTaskEventRecord,
  type WorkspaceTaskPriority,
  type WorkspaceTaskStatus,
  type WorkspaceTaskType,
  type WorkspaceTaskWorklogDocument,
} from './task-workspace.types';

export const TASK_WORKSPACE_REPOSITORY = Symbol('TASK_WORKSPACE_REPOSITORY');

class SprintRolloverConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('Sprint rollover task version conflict');
    this.name = 'SprintRolloverConflictError';
  }
}

export interface ListTasksFilter {
  organizationId: string;
  projectId?: string;
  limit: number;
  afterId?: string;
  dateCursor?: { dueDate: Date; id: string };
  statuses?: WorkspaceTaskStatus[];
  assigneeId?: string;
  priorities?: WorkspaceTaskPriority[];
  types?: WorkspaceTaskType[];
  parentId?: string;
  sprintId?: string;
  dueFrom?: Date;
  dueTo?: Date;
  dueDateNone?: boolean;
  q?: string;
}

@Injectable()
export class TaskWorkspaceRepository implements OnModuleInit {
  private readonly logger = new Logger(TaskWorkspaceRepository.name);
  private indexesEnsured = false;

  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly iamConnection?: Connection,
  ) {}

  get db(): mongoose.mongo.Db {
    if (!this.iamConnection) {
      throw new ServiceUnavailableException({
        code: 'RETRY_LATER',
        message: 'Task database connection is unavailable.',
      });
    }
    const taskConn = this.iamConnection.useDb(WORKSPACE_TASK_DATABASE_NAME, {
      useCache: true,
    });
    if (!taskConn.db) {
      throw new ServiceUnavailableException({
        code: 'RETRY_LATER',
        message: 'Task database is not connected.',
      });
    }
    return taskConn.db;
  }

  async onModuleInit(): Promise<void> {
    if (process.env.INFRA_ENABLED !== 'true') return;
    try {
      await this.ensureIndexes();
    } catch (error) {
      this.logger.warn(
        `Deferred index initialization on ${WORKSPACE_TASK_DATABASE_NAME}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async ensureIndexes(): Promise<void> {
    if (this.indexesEnsured) return;
    const database = this.db;

    // If a legacy D-03 strict validator exists on tasks/task_events/task_operations,
    // upgrade validationAction/validator so workspace fields & events are permitted.
    for (const collName of [
      WORKSPACE_TASKS_COLLECTION,
      WORKSPACE_TASK_EVENTS_COLLECTION,
      WORKSPACE_TASK_OPERATIONS_COLLECTION,
    ]) {
      await database
        .command({
          collMod: collName,
          validator: {},
          validationLevel: 'off',
        })
        .catch(() => undefined);
    }

    const tasks = database.collection<WorkspaceTaskDocument>(
      WORKSPACE_TASKS_COLLECTION,
    );
    await tasks.createIndexes([
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
    ]);

    await database
      .collection<WorkspaceTaskCommentDocument>(
        WORKSPACE_TASK_COMMENTS_COLLECTION,
      )
      .createIndexes([
        {
          key: { projectId: 1, taskId: 1, _id: 1 },
          name: 'task_comments_cursor',
        },
      ]);

    const taskEventsColl = database.collection<WorkspaceTaskEventRecord>(
      WORKSPACE_TASK_EVENTS_COLLECTION,
    );
    await taskEventsColl
      .dropIndex('task_event_task_mutation_version_unique')
      .catch(() => undefined);
    await taskEventsColl.createIndexes([
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
    ]);

    await database
      .collection<WorkspaceTaskWorklogDocument>(
        WORKSPACE_TASK_WORKLOGS_COLLECTION,
      )
      .createIndexes([
        {
          key: { projectId: 1, taskId: 1, _id: -1 },
          name: 'task_worklogs_cursor',
        },
      ]);

    await database
      .collection<WorkspaceProjectSprintDocument>(
        WORKSPACE_PROJECT_SPRINTS_COLLECTION,
      )
      .createIndexes([
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
      ]);

    await database
      .collection<WorkspaceProjectSprintEventDocument>(
        WORKSPACE_PROJECT_SPRINT_EVENTS_COLLECTION,
      )
      .createIndexes([
        {
          key: { sprintId: 1, version: 1 },
          name: 'sprint_event_version_unique',
          unique: true,
        },
        {
          key: { projectId: 1, sprintId: 1, occurredAt: -1, _id: -1 },
          name: 'project_sprint_events_cursor',
        },
      ]);

    await database
      .collection<WorkspaceIdempotencyRecord>(
        WORKSPACE_TASK_OPERATIONS_COLLECTION,
      )
      .createIndexes([
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
      ]);

    this.indexesEnsured = true;
  }

  private async runInTransaction<T>(
    work: (session?: mongoose.mongo.ClientSession) => Promise<T>,
  ): Promise<T> {
    const client = this.db.client;
    if (!client) return work(undefined);
    const session = client.startSession();
    try {
      let result!: T;
      try {
        await session.withTransaction(
          async (txSession) => {
            result = await work(txSession);
          },
          {
            readPreference: 'primary',
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
          },
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Standalone MongoDB instances in local tests do not support multi-doc transactions
        if (
          message.includes(
            'Transaction numbers are only allowed on a replica set member or mongos',
          ) ||
          message.includes('transactions are not supported')
        ) {
          return await work(undefined);
        }
        throw error;
      }
    } finally {
      await session.endSession().catch(() => undefined);
    }
  }

  async findIdempotency(
    actorId: string,
    projectId: string,
    operationId: string,
  ): Promise<WorkspaceIdempotencyRecord | null> {
    return this.db
      .collection<WorkspaceIdempotencyRecord>(
        WORKSPACE_TASK_OPERATIONS_COLLECTION,
      )
      .findOne({
        actorId: new Types.ObjectId(actorId),
        projectId: new Types.ObjectId(projectId),
        operationId,
        expiresAt: { $gt: new Date() },
      });
  }

  async saveIdempotency(record: {
    actorId: string;
    projectId: string;
    operationId: string;
    fingerprint: string;
    taskId: Types.ObjectId;
    statusCode: number;
    body: unknown;
    etag?: string;
    location?: string;
  }): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await this.db
      .collection<WorkspaceIdempotencyRecord>(
        WORKSPACE_TASK_OPERATIONS_COLLECTION,
      )
      .updateOne(
        {
          actorId: new Types.ObjectId(record.actorId),
          projectId: new Types.ObjectId(record.projectId),
          operationId: record.operationId,
        },
        {
          $set: {
            fingerprint: record.fingerprint,
            state: 'COMMITTED',
            taskId: record.taskId,
            updatedAt: now,
            leaseUntil: now,
            expiresAt,
            httpResponse: {
              statusCode: record.statusCode,
              body: record.body,
              ...(record.etag ? { etag: record.etag } : {}),
              ...(record.location ? { location: record.location } : {}),
            },
          },
          $setOnInsert: {
            _id: new Types.ObjectId(),
            createdAt: now,
          },
        },
        { upsert: true },
      );
  }

  async allocateNextTaskKey(
    projectId: string,
    projectCode: string,
    session?: mongoose.mongo.ClientSession,
  ): Promise<string> {
    const projectObjectId = new Types.ObjectId(projectId);
    const counters = this.db.collection<{ _id: Types.ObjectId; seq: number }>(
      WORKSPACE_TASK_COUNTERS_COLLECTION,
    );
    const updated = await counters.findOneAndUpdate(
      { _id: projectObjectId },
      { $inc: { seq: 1 } },
      {
        upsert: true,
        returnDocument: 'after',
        ...(session ? { session } : {}),
      },
    );
    const seq = updated?.seq ?? 1;
    const prefix = /^[A-Z0-9]{2,10}$/.test(projectCode) ? projectCode : 'TASK';
    return `${prefix}-${seq}`;
  }

  async listTasks(
    filter: ListTasksFilter,
  ): Promise<{ items: WorkspaceTaskDocument[]; isDateRange: boolean }> {
    const query: Record<string, unknown> = {
      organizationId: new Types.ObjectId(filter.organizationId),
    };
    if (filter.projectId) {
      query.projectId = new Types.ObjectId(filter.projectId);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      query.status =
        filter.statuses.length === 1
          ? filter.statuses[0]
          : { $in: filter.statuses };
    }
    if (filter.assigneeId !== undefined) {
      query.assigneeId =
        filter.assigneeId === 'none'
          ? null
          : new Types.ObjectId(filter.assigneeId);
    }
    if (filter.priorities && filter.priorities.length > 0) {
      query.priority =
        filter.priorities.length === 1
          ? filter.priorities[0]
          : { $in: filter.priorities };
    }
    if (filter.types && filter.types.length > 0) {
      query.type =
        filter.types.length === 1 ? filter.types[0] : { $in: filter.types };
    }
    if (filter.parentId !== undefined) {
      query.parentId =
        filter.parentId === 'none' ? null : new Types.ObjectId(filter.parentId);
    }
    if (filter.sprintId !== undefined) {
      query.sprintId =
        filter.sprintId === 'none' ? null : new Types.ObjectId(filter.sprintId);
    }
    if (filter.dueDateNone) {
      query.dueDate = null;
    }

    const isDateRange = Boolean(filter.dueFrom || filter.dueTo);
    if (isDateRange) {
      const range: Record<string, Date> = {};
      if (filter.dueFrom) range.$gte = filter.dueFrom;
      if (filter.dueTo) range.$lt = filter.dueTo;
      query.dueDate = range;
    }

    const andClauses: Record<string, unknown>[] = [];
    if (filter.q) {
      const trimmed = filter.q.trim();
      if (/^[A-Za-z0-9]{2,10}-[1-9][0-9]*$/.test(trimmed)) {
        andClauses.push({
          $or: [
            { key: trimmed.toUpperCase() },
            {
              title: {
                $regex: escapeLiteralRegex(trimmed),
                $options: 'i',
              },
            },
          ],
        });
      } else {
        andClauses.push({
          title: {
            $regex: escapeLiteralRegex(trimmed),
            $options: 'i',
          },
        });
      }
    }

    if (isDateRange && filter.dateCursor) {
      const cursorDue = filter.dateCursor.dueDate;
      const cursorId = new Types.ObjectId(filter.dateCursor.id);
      andClauses.push({
        $or: [
          { dueDate: { $gt: cursorDue } },
          { dueDate: cursorDue, _id: { $gt: cursorId } },
        ],
      });
    } else if (!isDateRange && filter.afterId) {
      query._id = { $gt: new Types.ObjectId(filter.afterId) };
    }

    if (andClauses.length > 0) {
      query.$and = andClauses;
    }

    let cursor = this.db
      .collection<WorkspaceTaskDocument>(WORKSPACE_TASKS_COLLECTION)
      .find(query)
      .sort(isDateRange ? { dueDate: 1, _id: 1 } : { _id: 1 })
      .limit(filter.limit);

    if (filter.q) {
      cursor = cursor.maxTimeMS(500);
    }

    const items = await cursor.toArray();
    return { items, isDateRange };
  }

  async getSubtaskCountsMap(
    projectIds: Types.ObjectId[],
    parentIds: Types.ObjectId[],
  ): Promise<Map<string, WorkspaceSubtaskCounts>> {
    const map = new Map<string, WorkspaceSubtaskCounts>();
    if (parentIds.length === 0) return map;

    const match: Record<string, unknown> = {
      parentId: { $in: parentIds },
    };
    if (projectIds.length === 1) {
      match.projectId = projectIds[0];
    } else if (projectIds.length > 1) {
      match.projectId = { $in: projectIds };
    }

    const rows = await this.db
      .collection<WorkspaceTaskDocument>(WORKSPACE_TASKS_COLLECTION)
      .aggregate<{ _id: Types.ObjectId; total: number; done: number }>([
        { $match: match },
        {
          $group: {
            _id: '$parentId',
            total: { $sum: 1 },
            done: {
              $sum: { $cond: [{ $eq: ['$status', 'DONE'] }, 1, 0] },
            },
          },
        },
      ])
      .toArray();

    for (const row of rows) {
      if (row._id) {
        map.set(row._id.toHexString(), {
          total: row.total,
          done: row.done,
        });
      }
    }
    return map;
  }

  async getTaskById(
    projectId: string,
    taskId: string,
  ): Promise<WorkspaceTaskDocument | null> {
    return this.db
      .collection<WorkspaceTaskDocument>(WORKSPACE_TASKS_COLLECTION)
      .findOne({
        _id: new Types.ObjectId(taskId),
        projectId: new Types.ObjectId(projectId),
      });
  }

  async countSubtasksOfTask(
    projectId: string,
    parentId: string,
  ): Promise<number> {
    return this.db
      .collection<WorkspaceTaskDocument>(WORKSPACE_TASKS_COLLECTION)
      .countDocuments({
        projectId: new Types.ObjectId(projectId),
        parentId: new Types.ObjectId(parentId),
      });
  }

  async createTaskWithEvent(input: {
    organizationId: string;
    projectId: string;
    projectCode: string;
    actorId: string;
    operationId: string;
    correlationId: string;
    title: string;
    description: string | null;
    type: WorkspaceTaskType;
    priority: WorkspaceTaskPriority;
    assigneeId: string | null;
    parentId: string | null;
    sprintId: string | null;
    labels: string[];
    steps: WorkspaceChecklistStep[];
    dueDate: Date | null;
    startDate: Date | null;
  }): Promise<WorkspaceTaskDocument> {
    return this.runInTransaction(async (session) => {
      const key = await this.allocateNextTaskKey(
        input.projectId,
        input.projectCode,
        session,
      );
      const now = new Date();
      const taskId = new Types.ObjectId();
      const orgObjectId = new Types.ObjectId(input.organizationId);
      const projectObjectId = new Types.ObjectId(input.projectId);
      const actorObjectId = new Types.ObjectId(input.actorId);

      const task: WorkspaceTaskDocument = {
        _id: taskId,
        organizationId: orgObjectId,
        projectId: projectObjectId,
        key,
        title: input.title,
        description: input.description,
        type: input.type,
        status: 'TODO',
        priority: input.priority,
        assigneeId: input.assigneeId
          ? new Types.ObjectId(input.assigneeId)
          : null,
        createdBy: actorObjectId,
        parentId: input.parentId ? new Types.ObjectId(input.parentId) : null,
        sprintId: input.sprintId ? new Types.ObjectId(input.sprintId) : null,
        labels: input.labels,
        steps: input.steps,
        dueDate: input.dueDate,
        startDate: input.startDate,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };

      const event: WorkspaceTaskEventRecord = {
        _id: new Types.ObjectId(),
        taskId,
        projectId: projectObjectId,
        organizationId: orgObjectId,
        eventName: 'TASK_CREATED',
        eventType: 'TASK_CREATED',
        actorType: 'USER',
        actorId: actorObjectId,
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
        version: 1,
        occurredAt: now,
        timestamp: now,
        operationId: input.operationId,
        correlationId: input.correlationId,
      };

      await this.db
        .collection<WorkspaceTaskDocument>(WORKSPACE_TASKS_COLLECTION)
        .insertOne(task, session ? { session } : {});
      await this.db
        .collection<WorkspaceTaskEventRecord>(WORKSPACE_TASK_EVENTS_COLLECTION)
        .insertOne(event, session ? { session } : {});

      return task;
    });
  }

  async updateTaskFields(input: {
    organizationId: string;
    projectId: string;
    taskId: string;
    actorId: string;
    expectedVersion: number;
    correlationId: string;
    updates: Partial<{
      title: string;
      description: string | null;
      type: WorkspaceTaskType;
      priority: WorkspaceTaskPriority;
      assigneeId: Types.ObjectId | null;
      dueDate: Date | null;
      startDate: Date | null;
      parentId: Types.ObjectId | null;
      sprintId: Types.ObjectId | null;
      labels: string[];
      steps: WorkspaceChecklistStep[];
    }>;
    changedFields: string[];
    fromSprintId?: Types.ObjectId | null;
    toSprintId?: Types.ObjectId | null;
  }): Promise<
    | { kind: 'UPDATED'; task: WorkspaceTaskDocument }
    | { kind: 'NOT_FOUND' }
    | {
        kind: 'CONFLICT';
        currentVersion: number;
        currentStatus: WorkspaceTaskStatus;
      }
  > {
    return this.runInTransaction(async (session) => {
      const tasks = this.db.collection<WorkspaceTaskDocument>(
        WORKSPACE_TASKS_COLLECTION,
      );
      const taskObjectId = new Types.ObjectId(input.taskId);
      const projectObjectId = new Types.ObjectId(input.projectId);
      const orgObjectId = new Types.ObjectId(input.organizationId);
      const now = new Date();
      const nextVersion = input.expectedVersion + 1;

      const updated = await tasks.findOneAndUpdate(
        {
          _id: taskObjectId,
          projectId: projectObjectId,
          version: input.expectedVersion,
        },
        {
          $set: {
            ...input.updates,
            organizationId: orgObjectId,
            updatedAt: now,
          },
          $inc: { version: 1 },
        },
        {
          returnDocument: 'after',
          ...(session ? { session } : {}),
        },
      );

      if (!updated) {
        const existing = await tasks.findOne(
          { _id: taskObjectId, projectId: projectObjectId },
          session ? { session } : {},
        );
        if (!existing) return { kind: 'NOT_FOUND' };
        return {
          kind: 'CONFLICT',
          currentVersion: existing.version,
          currentStatus: existing.status,
        };
      }

      const event: WorkspaceTaskEventRecord = {
        _id: new Types.ObjectId(),
        taskId: taskObjectId,
        projectId: projectObjectId,
        organizationId: orgObjectId,
        eventType: 'TASK_UPDATED',
        actorId: new Types.ObjectId(input.actorId),
        actorType: 'USER',
        source: 'WEB',
        operationId: new Types.ObjectId().toHexString(),
        correlationId: input.correlationId,
        occurredAt: now,
        timestamp: now,
        version: nextVersion,
        changedFields: input.changedFields,
        delta: {
          type: 'FIELD_UPDATE',
          changedFields: input.changedFields,
          ...(input.fromSprintId !== undefined
            ? { fromSprintId: input.fromSprintId }
            : {}),
          ...(input.toSprintId !== undefined
            ? { toSprintId: input.toSprintId }
            : {}),
        },
      };

      await this.db
        .collection<WorkspaceTaskEventRecord>(WORKSPACE_TASK_EVENTS_COLLECTION)
        .insertOne(event, session ? { session } : {});

      return { kind: 'UPDATED', task: updated };
    });
  }

  async transitionTaskStatus(input: {
    organizationId: string;
    projectId: string;
    taskId: string;
    actorId: string;
    expectedVersion: number;
    fromStatus: WorkspaceTaskStatus;
    toStatus: WorkspaceTaskStatus;
    reason?: string;
    operationId: string;
    correlationId: string;
  }): Promise<
    | { kind: 'UPDATED'; task: WorkspaceTaskDocument }
    | { kind: 'NOT_FOUND' }
    | {
        kind: 'CONFLICT';
        currentVersion: number;
        currentStatus: WorkspaceTaskStatus;
      }
  > {
    return this.runInTransaction(async (session) => {
      const tasks = this.db.collection<WorkspaceTaskDocument>(
        WORKSPACE_TASKS_COLLECTION,
      );
      const taskObjectId = new Types.ObjectId(input.taskId);
      const projectObjectId = new Types.ObjectId(input.projectId);
      const orgObjectId = new Types.ObjectId(input.organizationId);
      const now = new Date();
      const completedAt = input.toStatus === 'DONE' ? now : null;
      const nextVersion = input.expectedVersion + 1;

      const updated = await tasks.findOneAndUpdate(
        {
          _id: taskObjectId,
          projectId: projectObjectId,
          status: input.fromStatus,
          version: input.expectedVersion,
        },
        {
          $set: {
            status: input.toStatus,
            completedAt,
            organizationId: orgObjectId,
            updatedAt: now,
          },
          $inc: { version: 1 },
        },
        {
          returnDocument: 'after',
          ...(session ? { session } : {}),
        },
      );

      if (!updated) {
        const existing = await tasks.findOne(
          { _id: taskObjectId, projectId: projectObjectId },
          session ? { session } : {},
        );
        if (!existing) return { kind: 'NOT_FOUND' };
        return {
          kind: 'CONFLICT',
          currentVersion: existing.version,
          currentStatus: existing.status,
        };
      }

      const event: WorkspaceTaskEventRecord = {
        _id: new Types.ObjectId(),
        taskId: taskObjectId,
        projectId: projectObjectId,
        organizationId: orgObjectId,
        eventType: 'TASK_STATUS_TRANSITIONED',
        actorId: new Types.ObjectId(input.actorId),
        actorType: 'USER',
        source: 'WEB',
        operationId: input.operationId,
        correlationId: input.correlationId,
        occurredAt: now,
        timestamp: now,
        version: nextVersion,
        changedFields: ['status'],
        delta: {
          type: 'STATUS_TRANSITION',
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      };

      await this.db
        .collection<WorkspaceTaskEventRecord>(WORKSPACE_TASK_EVENTS_COLLECTION)
        .insertOne(event, session ? { session } : {});

      return { kind: 'UPDATED', task: updated };
    });
  }

  async listTaskHistory(
    projectId: string,
    taskId: string,
    page: number,
    limit: number,
  ): Promise<{ events: WorkspaceTaskEventRecord[]; hasNext: boolean }> {
    const filter = {
      projectId: new Types.ObjectId(projectId),
      taskId: new Types.ObjectId(taskId),
    };
    const skip = (page - 1) * limit;
    const rows = await this.db
      .collection<WorkspaceTaskEventRecord>(WORKSPACE_TASK_EVENTS_COLLECTION)
      .find(filter)
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limit + 1)
      .toArray();

    const hasNext = rows.length > limit;
    return {
      events: hasNext ? rows.slice(0, limit) : rows,
      hasNext,
    };
  }

  async listTaskComments(
    projectId: string,
    taskId: string,
    limit: number,
    afterId?: string,
  ): Promise<WorkspaceTaskCommentDocument[]> {
    const filter: Record<string, unknown> = {
      projectId: new Types.ObjectId(projectId),
      taskId: new Types.ObjectId(taskId),
    };
    if (afterId) {
      filter._id = { $gt: new Types.ObjectId(afterId) };
    }
    return this.db
      .collection<WorkspaceTaskCommentDocument>(
        WORKSPACE_TASK_COMMENTS_COLLECTION,
      )
      .find(filter)
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
  }

  async createTaskComment(input: {
    organizationId: string;
    projectId: string;
    taskId: string;
    taskVersion: number;
    authorId: string;
    body: string;
    operationId: string;
    correlationId: string;
  }): Promise<WorkspaceTaskCommentDocument> {
    return this.runInTransaction(async (session) => {
      const now = new Date();
      const commentId = new Types.ObjectId();
      const projectObjectId = new Types.ObjectId(input.projectId);
      const taskObjectId = new Types.ObjectId(input.taskId);
      const orgObjectId = new Types.ObjectId(input.organizationId);
      const authorObjectId = new Types.ObjectId(input.authorId);

      const comment: WorkspaceTaskCommentDocument = {
        _id: commentId,
        taskId: taskObjectId,
        projectId: projectObjectId,
        organizationId: orgObjectId,
        authorId: authorObjectId,
        body: input.body,
        createdAt: now,
      };

      const event: WorkspaceTaskEventRecord = {
        _id: new Types.ObjectId(),
        taskId: taskObjectId,
        projectId: projectObjectId,
        organizationId: orgObjectId,
        eventType: 'TASK_COMMENT_ADDED',
        actorId: authorObjectId,
        actorType: 'USER',
        source: 'WEB',
        operationId: input.operationId,
        correlationId: input.correlationId,
        occurredAt: now,
        timestamp: now,
        version: input.taskVersion,
        delta: {
          type: 'COMMENT_ADDED',
          commentId,
        },
      };

      await this.db
        .collection<WorkspaceTaskCommentDocument>(
          WORKSPACE_TASK_COMMENTS_COLLECTION,
        )
        .insertOne(comment, session ? { session } : {});
      await this.db
        .collection<WorkspaceTaskEventRecord>(WORKSPACE_TASK_EVENTS_COLLECTION)
        .insertOne(event, session ? { session } : {});

      return comment;
    });
  }

  async listTaskWorklogs(
    projectId: string,
    taskId: string,
    limit: number,
    afterId?: string,
  ): Promise<{ items: WorkspaceTaskWorklogDocument[]; totalMinutes: number }> {
    const baseFilter = {
      projectId: new Types.ObjectId(projectId),
      taskId: new Types.ObjectId(taskId),
    };
    const pageFilter: Record<string, unknown> = {
      ...baseFilter,
      ...(afterId ? { _id: { $lt: new Types.ObjectId(afterId) } } : {}),
    };

    const collection = this.db.collection<WorkspaceTaskWorklogDocument>(
      WORKSPACE_TASK_WORKLOGS_COLLECTION,
    );

    const [items, totals] = await Promise.all([
      collection.find(pageFilter).sort({ _id: -1 }).limit(limit).toArray(),
      collection
        .aggregate<{ totalMinutes: number }>([
          { $match: baseFilter },
          { $group: { _id: null, totalMinutes: { $sum: '$minutes' } } },
        ])
        .toArray(),
    ]);

    return {
      items,
      totalMinutes: totals[0]?.totalMinutes ?? 0,
    };
  }

  async createTaskWorklog(input: {
    organizationId: string;
    projectId: string;
    taskId: string;
    taskVersion: number;
    authorId: string;
    minutes: number;
    note: string | null;
    loggedAt: Date;
    operationId: string;
    correlationId: string;
  }): Promise<WorkspaceTaskWorklogDocument> {
    return this.runInTransaction(async (session) => {
      const now = new Date();
      const worklogId = new Types.ObjectId();
      const projectObjectId = new Types.ObjectId(input.projectId);
      const taskObjectId = new Types.ObjectId(input.taskId);
      const orgObjectId = new Types.ObjectId(input.organizationId);
      const authorObjectId = new Types.ObjectId(input.authorId);

      const worklog: WorkspaceTaskWorklogDocument = {
        _id: worklogId,
        taskId: taskObjectId,
        projectId: projectObjectId,
        organizationId: orgObjectId,
        authorId: authorObjectId,
        minutes: input.minutes,
        note: input.note,
        loggedAt: input.loggedAt,
        createdAt: now,
      };

      const event: WorkspaceTaskEventRecord = {
        _id: new Types.ObjectId(),
        taskId: taskObjectId,
        projectId: projectObjectId,
        organizationId: orgObjectId,
        eventType: 'TASK_WORKLOG_ADDED',
        actorId: authorObjectId,
        actorType: 'USER',
        source: 'WEB',
        operationId: input.operationId,
        correlationId: input.correlationId,
        occurredAt: now,
        timestamp: now,
        version: input.taskVersion,
        delta: {
          type: 'WORKLOG_ADDED',
          worklogId,
          minutes: input.minutes,
        },
      };

      await this.db
        .collection<WorkspaceTaskWorklogDocument>(
          WORKSPACE_TASK_WORKLOGS_COLLECTION,
        )
        .insertOne(worklog, session ? { session } : {});
      await this.db
        .collection<WorkspaceTaskEventRecord>(WORKSPACE_TASK_EVENTS_COLLECTION)
        .insertOne(event, session ? { session } : {});

      return worklog;
    });
  }

  async getSprintById(
    projectId: string,
    sprintId: string,
  ): Promise<WorkspaceProjectSprintDocument | null> {
    return this.db
      .collection<WorkspaceProjectSprintDocument>(
        WORKSPACE_PROJECT_SPRINTS_COLLECTION,
      )
      .findOne({
        _id: new Types.ObjectId(sprintId),
        projectId: new Types.ObjectId(projectId),
      });
  }

  async listProjectSprints(
    projectId: string,
    status?: WorkspaceSprintStatus,
  ): Promise<
    Array<{
      sprint: WorkspaceProjectSprintDocument;
      counts: {
        totalTasks: number;
        doneTasks: number;
        inProgressTasks: number;
        todoTasks: number;
      };
    }>
  > {
    const projectObjectId = new Types.ObjectId(projectId);
    const filter: Record<string, unknown> = { projectId: projectObjectId };
    if (status) filter.status = status;

    const sprints = await this.db
      .collection<WorkspaceProjectSprintDocument>(
        WORKSPACE_PROJECT_SPRINTS_COLLECTION,
      )
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    if (sprints.length === 0) return [];

    const sprintIds = sprints.map((s) => s._id);
    const taskBuckets = await this.db
      .collection<WorkspaceTaskDocument>(WORKSPACE_TASKS_COLLECTION)
      .aggregate<{
        _id: { sprintId: Types.ObjectId; status: WorkspaceTaskStatus };
        n: number;
      }>([
        {
          $match: {
            projectId: projectObjectId,
            sprintId: { $in: sprintIds },
          },
        },
        {
          $group: {
            _id: { sprintId: '$sprintId', status: '$status' },
            n: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const countsMap = new Map<
      string,
      {
        totalTasks: number;
        doneTasks: number;
        inProgressTasks: number;
        todoTasks: number;
      }
    >();
    for (const sprint of sprints) {
      countsMap.set(sprint._id.toHexString(), {
        totalTasks: 0,
        doneTasks: 0,
        inProgressTasks: 0,
        todoTasks: 0,
      });
    }
    for (const bucket of taskBuckets) {
      const entry = countsMap.get(bucket._id.sprintId.toHexString());
      if (!entry) continue;
      entry.totalTasks += bucket.n;
      if (bucket._id.status === 'DONE') {
        entry.doneTasks += bucket.n;
      } else if (
        bucket._id.status === 'IN_PROGRESS' ||
        bucket._id.status === 'IN_REVIEW' ||
        bucket._id.status === 'BLOCKED'
      ) {
        entry.inProgressTasks += bucket.n;
      } else if (bucket._id.status === 'TODO') {
        entry.todoTasks += bucket.n;
      }
    }

    return sprints.map((sprint) => ({
      sprint,
      counts: countsMap.get(sprint._id.toHexString())!,
    }));
  }

  async createProjectSprint(input: {
    organizationId: string;
    projectId: string;
    actorId: string;
    name: string;
    goal: string | null;
    startDate: Date | null;
    endDate: Date | null;
  }): Promise<WorkspaceProjectSprintDocument> {
    return this.runInTransaction(async (session) => {
      const now = new Date();
      const sprintId = new Types.ObjectId();
      const projectObjectId = new Types.ObjectId(input.projectId);
      const orgObjectId = new Types.ObjectId(input.organizationId);
      const actorObjectId = new Types.ObjectId(input.actorId);

      const sprint: WorkspaceProjectSprintDocument = {
        _id: sprintId,
        projectId: projectObjectId,
        organizationId: orgObjectId,
        name: input.name,
        goal: input.goal,
        status: 'PLANNED',
        startDate: input.startDate,
        endDate: input.endDate,
        createdBy: actorObjectId,
        createdAt: now,
        completedAt: null,
        version: 1,
      };

      const sprintEvent: WorkspaceProjectSprintEventDocument = {
        _id: new Types.ObjectId(),
        sprintId,
        projectId: projectObjectId,
        organizationId: orgObjectId,
        eventType: 'SPRINT_CREATED',
        actorId: actorObjectId,
        actorType: 'USER',
        occurredAt: now,
        version: 1,
        delta: { name: input.name, status: 'PLANNED' },
      };

      await this.db
        .collection<WorkspaceProjectSprintDocument>(
          WORKSPACE_PROJECT_SPRINTS_COLLECTION,
        )
        .insertOne(sprint, session ? { session } : {});
      await this.db
        .collection<WorkspaceProjectSprintEventDocument>(
          WORKSPACE_PROJECT_SPRINT_EVENTS_COLLECTION,
        )
        .insertOne(sprintEvent, session ? { session } : {});

      return sprint;
    });
  }

  async updateProjectSprint(input: {
    organizationId: string;
    projectId: string;
    sprintId: string;
    actorId: string;
    expectedVersion: number;
    updates: Partial<{
      name: string;
      goal: string | null;
      status: 'PLANNED' | 'ACTIVE';
      startDate: Date | null;
      endDate: Date | null;
    }>;
  }): Promise<
    | { kind: 'UPDATED'; sprint: WorkspaceProjectSprintDocument }
    | { kind: 'NOT_FOUND' }
    | { kind: 'VERSION_CONFLICT'; currentVersion: number }
    | { kind: 'ALREADY_ACTIVE' }
  > {
    try {
      return await this.runInTransaction(async (session) => {
        const sprints = this.db.collection<WorkspaceProjectSprintDocument>(
          WORKSPACE_PROJECT_SPRINTS_COLLECTION,
        );
        const projectObjectId = new Types.ObjectId(input.projectId);
        const sprintObjectId = new Types.ObjectId(input.sprintId);
        const orgObjectId = new Types.ObjectId(input.organizationId);
        const now = new Date();
        const nextVersion = input.expectedVersion + 1;

        if (input.updates.status === 'ACTIVE') {
          const otherActive = await sprints.findOne(
            {
              projectId: projectObjectId,
              status: 'ACTIVE',
              _id: { $ne: sprintObjectId },
            },
            session ? { session } : {},
          );
          if (otherActive) return { kind: 'ALREADY_ACTIVE' };
        }

        const updated = await sprints.findOneAndUpdate(
          {
            _id: sprintObjectId,
            projectId: projectObjectId,
            status: { $ne: 'COMPLETED' },
            version: input.expectedVersion,
          },
          {
            $set: input.updates,
            $inc: { version: 1 },
          },
          {
            returnDocument: 'after',
            ...(session ? { session } : {}),
          },
        );

        if (!updated) {
          const existing = await sprints.findOne(
            { _id: sprintObjectId, projectId: projectObjectId },
            session ? { session } : {},
          );
          if (!existing) return { kind: 'NOT_FOUND' };
          return {
            kind: 'VERSION_CONFLICT',
            currentVersion: existing.version,
          };
        }

        const sprintEvent: WorkspaceProjectSprintEventDocument = {
          _id: new Types.ObjectId(),
          sprintId: sprintObjectId,
          projectId: projectObjectId,
          organizationId: orgObjectId,
          eventType: 'SPRINT_UPDATED',
          actorId: new Types.ObjectId(input.actorId),
          actorType: 'USER',
          occurredAt: now,
          version: nextVersion,
          delta: { ...input.updates },
        };

        await this.db
          .collection<WorkspaceProjectSprintEventDocument>(
            WORKSPACE_PROJECT_SPRINT_EVENTS_COLLECTION,
          )
          .insertOne(sprintEvent, session ? { session } : {});

        return { kind: 'UPDATED', sprint: updated };
      });
    } catch (error) {
      if (
        error instanceof mongoose.mongo.MongoServerError &&
        error.code === 11000
      ) {
        return { kind: 'ALREADY_ACTIVE' };
      }
      throw error;
    }
  }

  async completeProjectSprint(input: {
    organizationId: string;
    projectId: string;
    sprintId: string;
    actorId: string;
    expectedVersion: number;
    moveIncompleteToSprintId: string | null;
    correlationId: string;
  }): Promise<
    | { kind: 'COMPLETED'; sprint: WorkspaceProjectSprintDocument }
    | { kind: 'NOT_FOUND' }
    | { kind: 'VERSION_CONFLICT'; currentVersion: number }
    | { kind: 'NOT_ACTIVE' }
    | { kind: 'TARGET_SPRINT_INVALID' }
  > {
    try {
      return await this.runInTransaction(async (session) => {
        const sprints = this.db.collection<WorkspaceProjectSprintDocument>(
          WORKSPACE_PROJECT_SPRINTS_COLLECTION,
        );
        const tasks = this.db.collection<WorkspaceTaskDocument>(
          WORKSPACE_TASKS_COLLECTION,
        );
        const taskEvents = this.db.collection<WorkspaceTaskEventRecord>(
          WORKSPACE_TASK_EVENTS_COLLECTION,
        );
        const sprintEvents =
          this.db.collection<WorkspaceProjectSprintEventDocument>(
            WORKSPACE_PROJECT_SPRINT_EVENTS_COLLECTION,
          );

        const orgObjectId = new Types.ObjectId(input.organizationId);
        const projectObjectId = new Types.ObjectId(input.projectId);
        const sprintObjectId = new Types.ObjectId(input.sprintId);
        const actorObjectId = new Types.ObjectId(input.actorId);
        const targetSprintObjectId = input.moveIncompleteToSprintId
          ? new Types.ObjectId(input.moveIncompleteToSprintId)
          : null;

        if (targetSprintObjectId) {
          if (targetSprintObjectId.equals(sprintObjectId)) {
            return { kind: 'TARGET_SPRINT_INVALID' };
          }
          const targetSprint = await sprints.findOne(
            {
              _id: targetSprintObjectId,
              projectId: projectObjectId,
              organizationId: orgObjectId,
              status: 'PLANNED',
            },
            session ? { session } : {},
          );
          if (!targetSprint) {
            return { kind: 'TARGET_SPRINT_INVALID' };
          }
        }

        const existing = await sprints.findOne(
          { _id: sprintObjectId, projectId: projectObjectId },
          session ? { session } : {},
        );
        if (!existing) return { kind: 'NOT_FOUND' };
        if (existing.version !== input.expectedVersion) {
          return { kind: 'VERSION_CONFLICT', currentVersion: existing.version };
        }
        if (existing.status !== 'ACTIVE') {
          return { kind: 'NOT_ACTIVE' };
        }

        const now = new Date();
        const nextSprintVersion = input.expectedVersion + 1;

        const updatedSprint = await sprints.findOneAndUpdate(
          {
            _id: sprintObjectId,
            projectId: projectObjectId,
            status: 'ACTIVE',
            version: input.expectedVersion,
          },
          {
            $set: {
              status: 'COMPLETED',
              completedAt: now,
            },
            $inc: { version: 1 },
          },
          {
            returnDocument: 'after',
            ...(session ? { session } : {}),
          },
        );

        if (!updatedSprint) {
          return { kind: 'VERSION_CONFLICT', currentVersion: existing.version };
        }

        // Read all incomplete tasks in this sprint so we can bump each task's version
        // with CAS and write a matching TASK_UPDATED event into task_events.
        const incompleteTasks = await tasks
          .find(
            {
              projectId: projectObjectId,
              sprintId: sprintObjectId,
              status: { $nin: ['DONE', 'CANCELLED'] },
            },
            {
              projection: { _id: 1, version: 1 },
              ...(session ? { session } : {}),
            },
          )
          .toArray();

        if (incompleteTasks.length > 0) {
          const bulkResult = await tasks.bulkWrite(
            incompleteTasks.map((task) => ({
              updateOne: {
                filter: {
                  _id: task._id,
                  projectId: projectObjectId,
                  sprintId: sprintObjectId,
                  version: task.version,
                },
                update: {
                  $set: {
                    sprintId: targetSprintObjectId,
                    updatedAt: now,
                  },
                  $inc: { version: 1 },
                },
              },
            })),
            session ? { session } : {},
          );

          if (bulkResult.matchedCount !== incompleteTasks.length) {
            throw new SprintRolloverConflictError(existing.version);
          }

          const perTaskEvents: WorkspaceTaskEventRecord[] = incompleteTasks.map(
            (task) => ({
              _id: new Types.ObjectId(),
              taskId: task._id,
              projectId: projectObjectId,
              organizationId: orgObjectId,
              eventType: 'TASK_UPDATED',
              actorId: actorObjectId,
              actorType: 'USER',
              source: 'WEB',
              operationId: new Types.ObjectId().toHexString(),
              correlationId: input.correlationId,
              occurredAt: now,
              timestamp: now,
              version: task.version + 1,
              changedFields: ['sprintId'],
              delta: {
                type: 'FIELD_UPDATE',
                changedFields: ['sprintId'],
                fromSprintId: sprintObjectId,
                toSprintId: targetSprintObjectId,
                reason: 'SPRINT_COMPLETED',
              },
            }),
          );

          await taskEvents.insertMany(
            perTaskEvents,
            session ? { session } : {},
          );
        }

        await sprintEvents.insertOne(
          {
            _id: new Types.ObjectId(),
            sprintId: sprintObjectId,
            projectId: projectObjectId,
            organizationId: orgObjectId,
            eventType: 'SPRINT_COMPLETED',
            actorId: actorObjectId,
            actorType: 'USER',
            occurredAt: now,
            version: nextSprintVersion,
            delta: {
              movedTaskCount: incompleteTasks.length,
              moveIncompleteToSprintId: input.moveIncompleteToSprintId,
            },
          },
          session ? { session } : {},
        );

        return { kind: 'COMPLETED', sprint: updatedSprint };
      });
    } catch (error) {
      if (error instanceof SprintRolloverConflictError) {
        return {
          kind: 'VERSION_CONFLICT',
          currentVersion: error.currentVersion,
        };
      }
      throw error;
    }
  }

  async getProjectTaskSummary(
    organizationId: string,
    projectId: string,
    asOf: Date,
  ) {
    const tasks = this.db.collection<WorkspaceTaskDocument>(
      WORKSPACE_TASKS_COLLECTION,
    );
    const projectObjectId = new Types.ObjectId(projectId);
    const orgObjectId = new Types.ObjectId(organizationId);
    const baseMatch = {
      organizationId: orgObjectId,
      projectId: projectObjectId,
    };
    const next7Days = new Date(asOf.getTime() + 7 * 24 * 60 * 60 * 1000);
    const prev7Days = new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000);
    const openStatuses: WorkspaceTaskStatus[] = [
      'TODO',
      'IN_PROGRESS',
      'IN_REVIEW',
      'BLOCKED',
    ];

    const [
      byStatusRows,
      byPriorityTypeRows,
      byAssigneeRows,
      overdue,
      dueNext7Days,
      completedLast7Days,
      createdLast7Days,
    ] = await Promise.all([
      tasks
        .aggregate<{ _id: string; n: number }>([
          { $match: baseMatch },
          { $group: { _id: '$status', n: { $sum: 1 } } },
        ])
        .toArray(),
      tasks
        .aggregate<{ _id: { p: string; t: string }; n: number }>([
          { $match: baseMatch },
          {
            $group: {
              _id: { p: '$priority', t: '$type' },
              n: { $sum: 1 },
            },
          },
        ])
        .toArray(),
      tasks
        .aggregate<{ _id: Types.ObjectId | null; n: number }>([
          { $match: baseMatch },
          { $group: { _id: '$assigneeId', n: { $sum: 1 } } },
          { $sort: { n: -1, _id: 1 } },
          { $limit: 50 },
        ])
        .toArray(),
      tasks.countDocuments({
        ...baseMatch,
        status: { $in: openStatuses },
        dueDate: { $lt: asOf },
      }),
      tasks.countDocuments({
        ...baseMatch,
        status: { $in: openStatuses },
        dueDate: { $gte: asOf, $lt: next7Days },
      }),
      tasks.countDocuments({
        ...baseMatch,
        status: 'DONE',
        completedAt: { $gte: prev7Days, $lte: asOf },
      }),
      tasks.countDocuments({
        ...baseMatch,
        createdAt: { $gte: prev7Days, $lte: asOf },
      }),
    ]);

    let total = 0;
    const byStatus = byStatusRows.map((row) => {
      total += row.n;
      return { key: row._id ?? null, count: row.n };
    });

    const priorityMap = new Map<string, number>();
    const typeMap = new Map<string, number>();
    for (const row of byPriorityTypeRows) {
      if (row._id.p) {
        priorityMap.set(row._id.p, (priorityMap.get(row._id.p) ?? 0) + row.n);
      }
      if (row._id.t) {
        typeMap.set(row._id.t, (typeMap.get(row._id.t) ?? 0) + row.n);
      }
    }

    const byPriority = [...priorityMap.entries()].map(([key, count]) => ({
      key,
      count,
    }));
    const byType = [...typeMap.entries()].map(([key, count]) => ({
      key,
      count,
    }));
    const byAssignee = byAssigneeRows.map((row) => ({
      key: row._id ? row._id.toHexString() : null,
      count: row.n,
    }));

    return {
      asOf: asOf.toISOString(),
      total,
      byStatus,
      byPriority,
      byType,
      byAssignee,
      overdue,
      dueNext7Days,
      completedLast7Days,
      createdLast7Days,
    };
  }

  async getOrganizationTaskAggregates(organizationId: string, asOf: Date) {
    const tasks = this.db.collection<WorkspaceTaskDocument>(
      WORKSPACE_TASKS_COLLECTION,
    );
    const orgObjectId = new Types.ObjectId(organizationId);
    const openStatuses: WorkspaceTaskStatus[] = [
      'TODO',
      'IN_PROGRESS',
      'IN_REVIEW',
      'BLOCKED',
    ];

    const [statusBuckets, overdueBuckets] = await Promise.all([
      tasks
        .aggregate<{
          _id: { p: Types.ObjectId; s: WorkspaceTaskStatus };
          n: number;
        }>([
          { $match: { organizationId: orgObjectId } },
          {
            $group: {
              _id: { p: '$projectId', s: '$status' },
              n: { $sum: 1 },
            },
          },
        ])
        .toArray(),
      tasks
        .aggregate<{ _id: Types.ObjectId; n: number }>([
          {
            $match: {
              organizationId: orgObjectId,
              status: { $in: openStatuses },
              dueDate: { $lt: asOf },
            },
          },
          {
            $group: {
              _id: '$projectId',
              n: { $sum: 1 },
            },
          },
        ])
        .toArray(),
    ]);

    return { statusBuckets, overdueBuckets };
  }
}
