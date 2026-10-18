import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import {
  TASK_COLLECTION,
  TASK_DATABASE_NAME,
  TASK_EVENT_COLLECTION,
  buildTaskCreationDocuments,
  isObjectIdString,
  parseTaskCreateInput,
  resolveCorrelationId,
  type TaskCreationContext,
  type TaskCreationEventDocument,
  type TaskDocument,
  type TaskEventDocument,
} from './task-contract';

const DISPOSABLE_DATABASE_PATTERN = /^datn95task_[a-f\d]{32}$/;
const MAX_PAGE_SIZE = 100;

export type TaskCreateResult =
  | { state: 'REJECTED'; reason: 'INVALID_INPUT' | 'INVALID_TRUSTED_CONTEXT' }
  | { state: 'ABORTED'; reason: 'TRANSACTION_ABORTED' }
  | { state: 'COMMITTED'; task: TaskDocument; reconciled: boolean }
  | {
      state: 'UNCERTAIN';
      taskId: string;
      eventId: string;
      operationId: string;
      reason:
        | 'NO_MATCHING_PAIR_AT_SNAPSHOT'
        | 'PARTIAL_OR_MISMATCHED_PAIR'
        | 'RECONCILIATION_UNAVAILABLE';
    };

export interface TaskPageQuery {
  limit: number;
  afterId?: string;
}

export class TaskDataRepository {
  constructor(private readonly database: mongoose.mongo.Db) {
    if (
      database.databaseName !== TASK_DATABASE_NAME &&
      !DISPOSABLE_DATABASE_PATTERN.test(database.databaseName)
    )
      throw new Error('Task persistence database name is not permitted');
  }

  async create(
    context: TaskCreationContext,
    inputValue: unknown,
  ): Promise<TaskCreateResult> {
    const input = parseTaskCreateInput(inputValue);
    if (!input) return { state: 'REJECTED', reason: 'INVALID_INPUT' };
    if (
      !(context?.projectId instanceof Types.ObjectId) ||
      !(context?.actorId instanceof Types.ObjectId)
    )
      return { state: 'REJECTED', reason: 'INVALID_TRUSTED_CONTEXT' };

    const { taskId, eventId, operationId } = this.allocateIds();
    const createdAt = new Date();
    const correlationId = resolveCorrelationId(context.requestId);
    const { task, event } = buildTaskCreationDocuments({
      taskId,
      eventId,
      projectId: context.projectId,
      actorId: context.actorId,
      input,
      createdAt,
      operationId,
      correlationId,
    });
    const session = this.database.client.startSession();
    let callbackCompletedWrites = false;

    try {
      try {
        await this.executeTransaction(session, async (transactionSession) => {
          callbackCompletedWrites = false;
          await this.insertTask(transactionSession, task);
          await this.insertCreationEvent(transactionSession, event);
          callbackCompletedWrites = true;
        });
        if (callbackCompletedWrites)
          return { state: 'COMMITTED', task, reconciled: false };
        return { state: 'ABORTED', reason: 'TRANSACTION_ABORTED' };
      } catch (error) {
        if (hasErrorLabel(error, 'UnknownTransactionCommitResult'))
          return await this.reconcileUncertain(task, event);
        if (hasErrorLabel(error, 'TransientTransactionError'))
          return { state: 'ABORTED', reason: 'TRANSACTION_ABORTED' };
        if (callbackCompletedWrites)
          return await this.reconcileUncertain(task, event);
        if (!session.inTransaction())
          return { state: 'ABORTED', reason: 'TRANSACTION_ABORTED' };
        return this.uncertain(task, event, 'RECONCILIATION_UNAVAILABLE');
      }
    } finally {
      await session.endSession().catch(() => undefined);
    }
  }

  async getById(
    projectId: string,
    taskId: string,
  ): Promise<TaskDocument | null> {
    if (!isObjectIdString(projectId) || !isObjectIdString(taskId)) return null;
    return this.database.collection<TaskDocument>(TASK_COLLECTION).findOne({
      _id: new Types.ObjectId(taskId),
      projectId: new Types.ObjectId(projectId),
    });
  }

  async listByProject(
    projectId: string,
    query: TaskPageQuery,
  ): Promise<TaskDocument[]> {
    if (!isObjectIdString(projectId)) return [];
    if (
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > MAX_PAGE_SIZE
    )
      throw new Error('Task page limit is invalid');
    if (query.afterId !== undefined && !isObjectIdString(query.afterId))
      throw new Error('Task cursor is invalid');
    const projectObjectId = new Types.ObjectId(projectId);
    const cursor = this.database
      .collection<TaskDocument>(TASK_COLLECTION)
      .find({
        projectId: projectObjectId,
        ...(query.afterId
          ? { _id: { $gt: new Types.ObjectId(query.afterId) } }
          : {}),
      });
    return cursor.sort({ _id: 1 }).limit(query.limit).toArray();
  }

  async listHistory(
    projectId: string,
    taskId: string,
    limit = MAX_PAGE_SIZE,
  ): Promise<TaskEventDocument[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
      throw new Error('Task history limit is invalid');
    const task = await this.getById(projectId, taskId);
    if (!task) return [];
    return this.database
      .collection<TaskEventDocument>(TASK_EVENT_COLLECTION)
      .aggregate<TaskEventDocument>([
        { $match: { taskId: task._id, projectId: task.projectId } },
        {
          $set: {
            historyVersion: { $ifNull: ['$taskVersion', '$version'] },
          },
        },
        { $sort: { historyVersion: 1, _id: 1 } },
        { $limit: limit },
        { $unset: 'historyVersion' },
      ])
      .toArray();
  }

  protected allocateIds() {
    return {
      taskId: new Types.ObjectId(),
      eventId: new Types.ObjectId(),
      operationId: randomUUID(),
    };
  }

  protected async insertTask(
    session: mongoose.mongo.ClientSession,
    task: TaskDocument,
  ): Promise<void> {
    await this.database
      .collection<TaskDocument>(TASK_COLLECTION)
      .insertOne(task, { session });
  }

  protected async insertCreationEvent(
    session: mongoose.mongo.ClientSession,
    event: TaskCreationEventDocument,
  ): Promise<void> {
    await this.database
      .collection<TaskCreationEventDocument>(TASK_EVENT_COLLECTION)
      .insertOne(event, { session });
  }

  protected async executeTransaction(
    session: mongoose.mongo.ClientSession,
    callback: (session: mongoose.mongo.ClientSession) => Promise<void>,
  ): Promise<void> {
    await session.withTransaction(() => callback(session), {
      readPreference: 'primary',
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
  }

  private async reconcileUncertain(
    expectedTask: TaskDocument,
    expectedEvent: TaskCreationEventDocument,
  ): Promise<TaskCreateResult> {
    const session = this.database.client.startSession({
      snapshot: true,
      causalConsistency: false,
    });
    try {
      const task = await this.database
        .collection<TaskDocument>(TASK_COLLECTION)
        .findOne(
          { _id: expectedTask._id, projectId: expectedTask.projectId },
          { session, readPreference: 'primary' },
        );
      const event = await this.database
        .collection<TaskCreationEventDocument>(TASK_EVENT_COLLECTION)
        .findOne(
          {
            _id: expectedEvent._id,
            taskId: expectedEvent.taskId,
            projectId: expectedEvent.projectId,
          },
          { session, readPreference: 'primary' },
        );
      if (
        task &&
        event &&
        sameTask(task, expectedTask) &&
        sameEvent(event, expectedEvent)
      )
        return { state: 'COMMITTED', task, reconciled: true };
      if (task || event)
        return this.uncertain(
          expectedTask,
          expectedEvent,
          'PARTIAL_OR_MISMATCHED_PAIR',
        );
      return this.uncertain(
        expectedTask,
        expectedEvent,
        'NO_MATCHING_PAIR_AT_SNAPSHOT',
      );
    } catch {
      return this.uncertain(
        expectedTask,
        expectedEvent,
        'RECONCILIATION_UNAVAILABLE',
      );
    } finally {
      await session.endSession().catch(() => undefined);
    }
  }

  private uncertain(
    task: TaskDocument,
    event: TaskCreationEventDocument,
    reason: Extract<TaskCreateResult, { state: 'UNCERTAIN' }>['reason'],
  ): Extract<TaskCreateResult, { state: 'UNCERTAIN' }> {
    return {
      state: 'UNCERTAIN',
      taskId: task._id.toHexString(),
      eventId: event._id.toHexString(),
      operationId: event.operationId,
      reason,
    };
  }
}

function hasErrorLabel(error: unknown, label: string): boolean {
  return (
    error instanceof mongoose.mongo.MongoError && error.hasErrorLabel(label)
  );
}

function sameTask(actual: TaskDocument, expected: TaskDocument): boolean {
  return (
    actual._id.equals(expected._id) &&
    actual.projectId.equals(expected.projectId) &&
    actual.title === expected.title &&
    actual.createdBy.equals(expected.createdBy) &&
    actual.createdAt.getTime() === expected.createdAt.getTime() &&
    actual.updatedAt.getTime() === expected.updatedAt.getTime() &&
    actual.status === expected.status &&
    ((actual.assigneeId === null && expected.assigneeId === null) ||
      (actual.assigneeId instanceof Types.ObjectId &&
        expected.assigneeId instanceof Types.ObjectId &&
        actual.assigneeId.equals(expected.assigneeId))) &&
    ((actual.completedAt === null && expected.completedAt === null) ||
      (actual.completedAt instanceof Date &&
        expected.completedAt instanceof Date &&
        actual.completedAt.getTime() === expected.completedAt.getTime())) &&
    actual.version === expected.version
  );
}

function sameEvent(
  actual: TaskCreationEventDocument,
  expected: TaskCreationEventDocument,
): boolean {
  return (
    actual._id.equals(expected._id) &&
    actual.taskId.equals(expected.taskId) &&
    actual.projectId.equals(expected.projectId) &&
    actual.eventName === expected.eventName &&
    actual.actorType === expected.actorType &&
    actual.actorId.equals(expected.actorId) &&
    actual.source === expected.source &&
    actual.changedFields.join('\u0000') ===
      expected.changedFields.join('\u0000') &&
    actual.taskVersion === expected.taskVersion &&
    actual.occurredAt.getTime() === expected.occurredAt.getTime() &&
    actual.operationId === expected.operationId &&
    actual.correlationId === expected.correlationId
  );
}
