import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import mongoose, { Types, type Connection } from 'mongoose';
import { IAM_PERSISTENCE } from '../../iam/infrastructure/persistence';
import {
  WORKSPACE_COLLECTION_VALIDATORS,
  WORKSPACE_INDEX_CATALOGUE,
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
  type WorkspaceIndexSpec,
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

export interface WorkspaceIdempotencyCommitSpec<T> {
  actorId: string;
  projectId: string;
  operationId: string;
  fingerprint: string;
  getEntityId: (entity: T) => Types.ObjectId;
  buildResponse: (entity: T) => {
    statusCode: number;
    body: unknown;
    etag?: string;
    location?: string;
  };
}

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

  private async syncCollectionIndexes(
    collection: mongoose.mongo.Collection,
    specs: WorkspaceIndexSpec[],
  ): Promise<void> {
    const existing = (await collection
      .listIndexes()
      .toArray()
      .catch(() => [])) as Array<{
      name?: string;
      key?: Record<string, 1 | -1>;
      unique?: boolean;
      expireAfterSeconds?: number;
      partialFilterExpression?: Record<string, unknown>;
    }>;

    for (const spec of specs) {
      const targetKeyJson = JSON.stringify(spec.key);
      for (const idx of existing) {
        if (!idx.name || idx.name === '_id_') continue;
        const sameName = idx.name === spec.name;
        const sameKey = JSON.stringify(idx.key) === targetKeyJson;
        if (!sameName && !sameKey) continue;

        const sameUnique = Boolean(idx.unique) === Boolean(spec.unique);
        const sameTtl =
          (idx.expireAfterSeconds ?? undefined) ===
          (spec.expireAfterSeconds ?? undefined);
        const samePartial =
          JSON.stringify(idx.partialFilterExpression ?? null) ===
          JSON.stringify(spec.partialFilterExpression ?? null);

        if (!sameName || !sameKey || !sameUnique || !sameTtl || !samePartial) {
          await collection.dropIndex(idx.name).catch(() => undefined);
        }
      }

      await collection.createIndex(spec.key, {
        name: spec.name,
        ...(spec.unique ? { unique: true } : {}),
        ...(spec.expireAfterSeconds !== undefined
          ? { expireAfterSeconds: spec.expireAfterSeconds }
          : {}),
        ...(spec.partialFilterExpression
          ? { partialFilterExpression: spec.partialFilterExpression }
          : {}),
      });
    }
  }

  async ensureIndexes(): Promise<void> {
    if (this.indexesEnsured) return;
    const database = this.db;

    const existingCollections = await database
      .listCollections({}, { nameOnly: true })
      .toArray()
      .catch(() => []);
    const existingNames = new Set(existingCollections.map((c) => c.name));

    for (const [collName, validator] of Object.entries(
      WORKSPACE_COLLECTION_VALIDATORS,
    )) {
      if (!existingNames.has(collName)) {
        await database
          .createCollection(collName, {
            validator,
            validationLevel: 'strict',
            validationAction: 'error',
          })
          .catch(() => undefined);
      } else {
        await database
          .command({
            collMod: collName,
            validator,
            validationLevel: 'strict',
            validationAction: 'error',
          })
          .catch(() => undefined);
      }
    }

    for (const [collName, specs] of Object.entries(WORKSPACE_INDEX_CATALOGUE)) {
      await this.syncCollectionIndexes(database.collection(collName), specs);
    }

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

  async claimIdempotency(input: {
    actorId: string;
    projectId: string;
    operationId: string;
    fingerprint: string;
  }): Promise<
    | { kind: 'CLAIMED' }
    | { kind: 'REPLAY'; record: WorkspaceIdempotencyRecord }
    | { kind: 'IN_PROGRESS' }
    | { kind: 'CONFLICT_FINGERPRINT' }
  > {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 30_000);
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const actorObjId = new Types.ObjectId(input.actorId);
    const projectObjId = new Types.ObjectId(input.projectId);
    const col = this.db.collection<WorkspaceIdempotencyRecord>(
      WORKSPACE_TASK_OPERATIONS_COLLECTION,
    );

    // Reclaim any expired record or stale IN_PROGRESS lease before atomic insert
    await col.deleteOne({
      actorId: actorObjId,
      projectId: projectObjId,
      operationId: input.operationId,
      $or: [
        { expiresAt: { $lte: now } },
        { state: 'IN_PROGRESS', leaseUntil: { $lte: now } },
      ],
    });

    try {
      await col.insertOne({
        _id: new Types.ObjectId(),
        actorId: actorObjId,
        projectId: projectObjId,
        operationId: input.operationId,
        fingerprint: input.fingerprint,
        state: 'IN_PROGRESS',
        taskId: new Types.ObjectId('000000000000000000000000'),
        createdAt: now,
        updatedAt: now,
        leaseUntil,
        expiresAt,
      });
      return { kind: 'CLAIMED' };
    } catch (error) {
      if (!(
        error instanceof mongoose.mongo.MongoServerError && error.code === 11000
      )) {
        throw error;
      }
      const existing = await col.findOne({
        actorId: actorObjId,
        projectId: projectObjId,
        operationId: input.operationId,
      });
      if (!existing) {
        return { kind: 'IN_PROGRESS' };
      }
      if (existing.fingerprint !== input.fingerprint) {
        return { kind: 'CONFLICT_FINGERPRINT' };
      }
      if (existing.state === 'COMMITTED' && existing.httpResponse) {
        return { kind: 'REPLAY', record: existing };
      }
      return { kind: 'IN_PROGRESS' };
    }
  }

  async releaseIdempotency(
    actorId: string,
    projectId: string,
    operationId: string,
  ): Promise<void> {
    await this.db
      .collection<WorkspaceIdempotencyRecord>(
        WORKSPACE_TASK_OPERATIONS_COLLECTION,
      )
      .deleteOne({
        actorId: new Types.ObjectId(actorId),
        projectId: new Types.ObjectId(projectId),
        operationId,
        state: 'IN_PROGRESS',
      })
      .catch(() => undefined);
  }

  async saveIdempotency(
    record: {
      actorId: string;
      projectId: string;
      operationId: string;
      fingerprint: string;
      taskId: Types.ObjectId;
      statusCode: number;
      body: unknown;
      etag?: string;
      location?: string;
    },
    session?: mongoose.mongo.ClientSession,
  ): Promise<void> {
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
        {
          upsert: true,
          ...(session ? { session } : {}),
        },
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

  private async verifyParentTaskInSession(
    projectObjectId: Types.ObjectId,
    parentObjectId: Types.ObjectId,
    session?: mongoose.mongo.ClientSession,
  ): Promise<void> {
    const parentTask = await this.db
      .collection<WorkspaceTaskDocument>(WORKSPACE_TASKS_COLLECTION)
      .findOne(
        {
          _id: parentObjectId,
          projectId: projectObjectId,
        },
        session ? { session } : {},
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

  private async commitIdempotencySpec<T>(
    spec: WorkspaceIdempotencyCommitSpec<T> | undefined,
    entity: T,
    session?: mongoose.mongo.ClientSession,
  ): Promise<void> {
    if (!spec) return;
    const res = spec.buildResponse(entity);
    await this.saveIdempotency(
      {
        actorId: spec.actorId,
        projectId: spec.projectId,
        operationId: spec.operationId,
        fingerprint: spec.fingerprint,
        taskId: spec.getEntityId(entity),
        statusCode: res.statusCode,
        body: res.body,
        etag: res.etag,
        location: res.location,
      },
      session,
    );
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
    idempotency?: WorkspaceIdempotencyCommitSpec<WorkspaceTaskDocument>;
  }): Promise<WorkspaceTaskDocument> {
    return this.runInTransaction(async (session) => {
      const orgObjectId = new Types.ObjectId(input.organizationId);
      const projectObjectId = new Types.ObjectId(input.projectId);
      const actorObjectId = new Types.ObjectId(input.actorId);

      if (input.parentId) {
        await this.verifyParentTaskInSession(
          projectObjectId,
          new Types.ObjectId(input.parentId),
          session,
        );
      }

      const key = await this.allocateNextTaskKey(
        input.projectId,
        input.projectCode,
        session,
      );
      const now = new Date();
      const taskId = new Types.ObjectId();

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
      await this.commitIdempotencySpec(input.idempotency, task, session);

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

      if (input.updates.parentId) {
        const childCount = await tasks.countDocuments(
          {
            projectId: projectObjectId,
            parentId: taskObjectId,
          },
          session ? { session } : {},
        );
        if (childCount > 0) {
          throw new UnprocessableEntityException({
            code: 'TASK_SUBTASK_DEPTH_EXCEEDED',
            message:
              'A task that already has subtasks cannot become a subtask.',
          });
        }
        await this.verifyParentTaskInSession(
          projectObjectId,
          input.updates.parentId,
          session,
        );
      }

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
    idempotency?: WorkspaceIdempotencyCommitSpec<{
      task: WorkspaceTaskDocument;
      subtaskCounts: WorkspaceSubtaskCounts;
    }>;
  }): Promise<
    | {
        kind: 'UPDATED';
        task: WorkspaceTaskDocument;
        subtaskCounts: WorkspaceSubtaskCounts;
      }
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

      let subtaskCounts: WorkspaceSubtaskCounts = { total: 0, done: 0 };
      if (updated.parentId === null) {
        const rows = await tasks
          .aggregate<{ total: number; done: number }>(
            [
              {
                $match: {
                  projectId: projectObjectId,
                  parentId: taskObjectId,
                },
              },
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  done: {
                    $sum: { $cond: [{ $eq: ['$status', 'DONE'] }, 1, 0] },
                  },
                },
              },
            ],
            session ? { session } : {},
          )
          .toArray();
        if (rows[0]) {
          subtaskCounts = { total: rows[0].total, done: rows[0].done };
        }
      }

      const resultPayload = { task: updated, subtaskCounts };
      await this.commitIdempotencySpec(
        input.idempotency,
        resultPayload,
        session,
      );

      return { kind: 'UPDATED', task: updated, subtaskCounts };
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
    idempotency?: WorkspaceIdempotencyCommitSpec<WorkspaceTaskCommentDocument>;
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
      await this.commitIdempotencySpec(input.idempotency, comment, session);

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
    idempotency?: WorkspaceIdempotencyCommitSpec<WorkspaceTaskWorklogDocument>;
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
      await this.commitIdempotencySpec(input.idempotency, worklog, session);

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
    idempotency?: WorkspaceIdempotencyCommitSpec<WorkspaceProjectSprintDocument>;
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
      await this.commitIdempotencySpec(input.idempotency, sprint, session);

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
    idempotency?: WorkspaceIdempotencyCommitSpec<{
      sprint: WorkspaceProjectSprintDocument;
      counts: {
        totalTasks: number;
        doneTasks: number;
        inProgressTasks: number;
        todoTasks: number;
      };
    }>;
  }): Promise<
    | {
        kind: 'COMPLETED';
        sprint: WorkspaceProjectSprintDocument;
        counts: {
          totalTasks: number;
          doneTasks: number;
          inProgressTasks: number;
          todoTasks: number;
        };
      }
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

        const remainingBuckets = await tasks
          .aggregate<{ _id: WorkspaceTaskStatus; n: number }>(
            [
              {
                $match: {
                  projectId: projectObjectId,
                  sprintId: sprintObjectId,
                },
              },
              {
                $group: {
                  _id: '$status',
                  n: { $sum: 1 },
                },
              },
            ],
            session ? { session } : {},
          )
          .toArray();

        const counts = {
          totalTasks: 0,
          doneTasks: 0,
          inProgressTasks: 0,
          todoTasks: 0,
        };
        for (const b of remainingBuckets) {
          counts.totalTasks += b.n;
          if (b._id === 'DONE') counts.doneTasks += b.n;
          else if (
            b._id === 'IN_PROGRESS' ||
            b._id === 'IN_REVIEW' ||
            b._id === 'BLOCKED'
          ) {
            counts.inProgressTasks += b.n;
          } else if (b._id === 'TODO') {
            counts.todoTasks += b.n;
          }
        }

        await this.commitIdempotencySpec(
          input.idempotency,
          { sprint: updatedSprint, counts },
          session,
        );

        return { kind: 'COMPLETED', sprint: updatedSprint, counts };
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

  async getOrganizationTaskAggregates(
    organizationId: string,
    asOf: Date,
    pinSnapshot = false,
  ) {
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
    const baseMatch: Record<string, unknown> = {
      organizationId: orgObjectId,
      ...(pinSnapshot ? { createdAt: { $lte: asOf } } : {}),
    };

    const [statusBuckets, overdueBuckets] = await Promise.all([
      tasks
        .aggregate<{
          _id: { p: Types.ObjectId; s: WorkspaceTaskStatus };
          n: number;
        }>([
          { $match: baseMatch },
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
              ...baseMatch,
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
