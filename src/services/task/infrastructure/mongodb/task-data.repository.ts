import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import {
  TASK_COLLECTION,
  TASK_DATABASE_NAME,
  TASK_EVENT_COLLECTION,
  TASK_OPERATION_COLLECTION,
  TASK_OPERATION_RETENTION_MS,
  buildTaskCreationDocuments,
  isObjectIdString,
  isUuidV4,
  parseTaskCreateInput,
  resolveCorrelationId,
  type TaskCreationContext,
  type TaskCreationEventDocument,
  type TaskDocument,
  type TaskEventDocument,
  type TaskLifecycleOperationDocument,
  type TaskLifecycleOperationResult,
  type TaskStatusTransitionEventDocument,
} from './task-contract';
import type {
  TaskLifecycleCommandResult,
  TaskLifecycleDecisionFunction,
  TaskLifecyclePersistenceRequest,
} from '../../runtime/task-lifecycle-policy';

const DISPOSABLE_DATABASE_PATTERN = /^datn95task_[a-f\d]{32}$/;
const MAX_PAGE_SIZE = 100;
const TASK_OPERATION_LEASE_MS = 60_000;
const TASK_OPERATION_CLAIM_ATTEMPTS = 8;

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

type TaskLifecycleOperationClaim =
  | { kind: 'CLAIMED'; claimUpdatedAt: Date }
  | { kind: 'REPLAY'; operation: TaskLifecycleOperationDocument }
  | { kind: 'PAYLOAD_MISMATCH' }
  | { kind: 'IN_PROGRESS' };

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

  async transitionStatus(
    request: TaskLifecyclePersistenceRequest,
    decide: TaskLifecycleDecisionFunction,
  ): Promise<TaskLifecycleCommandResult> {
    if (
      !isUuidV4(request.command.operationId) ||
      !/^[a-f\d]{64}$/.test(request.fingerprint) ||
      !Number.isSafeInteger(request.command.expectedVersion) ||
      request.command.expectedVersion < 1 ||
      !(request.now instanceof Date) ||
      !Number.isFinite(request.now.getTime()) ||
      !(request.context.actorId instanceof Types.ObjectId) ||
      !(request.context.projectId instanceof Types.ObjectId) ||
      !(request.command.taskId instanceof Types.ObjectId)
    )
      return { kind: 'REJECTED', code: 'INVALID_COMMAND', replayed: false };

    let claim: TaskLifecycleOperationClaim;
    try {
      claim = await this.claimLifecycleOperation(request);
    } catch {
      return {
        kind: 'UNCERTAIN',
        operationId: request.command.operationId,
      };
    }
    if (claim.kind === 'IN_PROGRESS')
      return {
        kind: 'IN_PROGRESS',
        operationId: request.command.operationId,
      };
    if (claim.kind === 'PAYLOAD_MISMATCH')
      return {
        kind: 'REJECTED',
        code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
        replayed: false,
      };
    if (claim.kind === 'REPLAY')
      return lifecycleOperationResult(claim.operation, true, false);

    const session = this.database.client.startSession();
    const eventId = new Types.ObjectId();
    let outcome: TaskLifecycleCommandResult | undefined;
    try {
      await this.executeTransaction(session, async (transactionSession) => {
        outcome = undefined;
        const task = await this.database
          .collection<TaskDocument>(TASK_COLLECTION)
          .findOne(
            {
              _id: request.command.taskId,
              projectId: request.context.projectId,
            },
            { session: transactionSession },
          );
        const decision = decide(task, request.context, request.command);

        if (decision.kind === 'REJECTED') {
          await this.finishLifecycleOperation(
            transactionSession,
            request,
            claim.claimUpdatedAt,
            {
              outcome: 'REJECTED',
              code: decision.code,
              ...(decision.currentStatus
                ? { currentStatus: decision.currentStatus }
                : {}),
              ...(decision.currentVersion !== undefined
                ? { currentVersion: decision.currentVersion }
                : {}),
            },
          );
          outcome = {
            kind: 'REJECTED',
            code: decision.code,
            ...(decision.currentStatus
              ? { currentStatus: decision.currentStatus }
              : {}),
            ...(decision.currentVersion !== undefined
              ? { currentVersion: decision.currentVersion }
              : {}),
            replayed: false,
          };
          return;
        }

        const updatedAt = request.now;
        const completedAt = decision.toStatus === 'DONE' ? updatedAt : null;
        const nextVersion = decision.expectedVersion + 1;
        const update = await this.database
          .collection<TaskDocument>(TASK_COLLECTION)
          .updateOne(
            {
              _id: request.command.taskId,
              projectId: request.context.projectId,
              status: decision.fromStatus,
              version: decision.expectedVersion,
            },
            {
              $set: {
                status: decision.toStatus,
                completedAt,
                updatedAt,
              },
              $inc: { version: 1 },
            },
            { session: transactionSession },
          );

        if (update.matchedCount !== 1) {
          const rejection: TaskLifecycleOperationResult = {
            outcome: 'REJECTED',
            code: 'TASK_VERSION_CONFLICT',
            currentStatus: decision.fromStatus,
            currentVersion: decision.expectedVersion,
          };
          await this.finishLifecycleOperation(
            transactionSession,
            request,
            claim.claimUpdatedAt,
            rejection,
          );
          outcome = {
            kind: 'REJECTED',
            code: rejection.code,
            currentStatus: rejection.currentStatus,
            currentVersion: rejection.currentVersion,
            replayed: false,
          };
          return;
        }

        const event: TaskStatusTransitionEventDocument = {
          _id: eventId,
          taskId: request.command.taskId,
          projectId: request.context.projectId,
          actorId: request.context.actorId,
          actorType: 'USER',
          source: request.context.source,
          eventType: 'TASK_STATUS_TRANSITIONED',
          operationId: request.command.operationId,
          correlationId: request.context.correlationId,
          timestamp: updatedAt,
          version: nextVersion,
          changedFields: ['status'],
          delta: {
            type: 'STATUS_TRANSITION',
            fromStatus: decision.fromStatus,
            toStatus: decision.toStatus,
            ...(decision.reason === undefined
              ? {}
              : { reason: decision.reason }),
          },
        };
        await this.insertStatusTransitionEvent(transactionSession, event);

        const committedResult: TaskLifecycleOperationResult = {
          outcome: 'COMMITTED',
          status: decision.toStatus,
          version: nextVersion,
          completedAt,
          updatedAt,
        };
        await this.finishLifecycleOperation(
          transactionSession,
          request,
          claim.claimUpdatedAt,
          committedResult,
        );
        outcome = {
          kind: 'COMMITTED',
          status: decision.toStatus,
          version: nextVersion,
          completedAt,
          updatedAt,
          replayed: false,
          reconciled: false,
        };
      });

      if (outcome) return outcome;
      await this.makeLifecycleOperationRetryable(request, claim.claimUpdatedAt);
      return {
        kind: 'ABORTED',
        operationId: request.command.operationId,
      };
    } catch (error) {
      const operation = await this.findLifecycleOperation(request).catch(
        () => null,
      );
      if (
        operation &&
        operation.fingerprint === request.fingerprint &&
        (operation.state === 'COMMITTED' || operation.state === 'REJECTED')
      )
        return lifecycleOperationResult(operation, true, true);

      if (hasErrorLabel(error, 'TransientTransactionError')) {
        await this.makeLifecycleOperationRetryable(
          request,
          claim.claimUpdatedAt,
        ).catch(() => undefined);
        return {
          kind: 'ABORTED',
          operationId: request.command.operationId,
        };
      }

      if (!session.inTransaction()) {
        await this.makeLifecycleOperationRetryable(
          request,
          claim.claimUpdatedAt,
        ).catch(() => undefined);
        return {
          kind: 'ABORTED',
          operationId: request.command.operationId,
        };
      }

      return {
        kind: 'UNCERTAIN',
        operationId: request.command.operationId,
      };
    } finally {
      await session.endSession().catch(() => undefined);
    }
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

  protected async insertStatusTransitionEvent(
    session: mongoose.mongo.ClientSession,
    event: TaskStatusTransitionEventDocument,
  ): Promise<void> {
    await this.database
      .collection<TaskStatusTransitionEventDocument>(TASK_EVENT_COLLECTION)
      .insertOne(event, { session });
  }

  private async claimLifecycleOperation(
    request: TaskLifecyclePersistenceRequest,
  ): Promise<TaskLifecycleOperationClaim> {
    const collection = this.database.collection<TaskLifecycleOperationDocument>(
      TASK_OPERATION_COLLECTION,
    );
    const { context, command, fingerprint, now } = request;
    const key = {
      actorId: context.actorId,
      projectId: context.projectId,
      operationId: command.operationId,
    };

    for (
      let attempt = 0;
      attempt < TASK_OPERATION_CLAIM_ATTEMPTS;
      attempt += 1
    ) {
      const existing = await collection.findOne(key);
      if (!existing) {
        const operation: TaskLifecycleOperationDocument = {
          _id: new Types.ObjectId(),
          ...key,
          fingerprint,
          state: 'IN_PROGRESS',
          taskId: command.taskId,
          createdAt: now,
          updatedAt: now,
          leaseUntil: new Date(now.getTime() + TASK_OPERATION_LEASE_MS),
          expiresAt: new Date(now.getTime() + TASK_OPERATION_RETENTION_MS),
        };
        try {
          await collection.insertOne(operation);
          return { kind: 'CLAIMED', claimUpdatedAt: operation.updatedAt };
        } catch (error) {
          if (isDuplicateKeyError(error)) continue;
          throw error;
        }
      }

      if (existing.expiresAt.getTime() <= now.getTime()) {
        const updatedAt = nextOperationTimestamp(now, existing.updatedAt);
        const replacement = await collection.updateOne(
          {
            _id: existing._id,
            updatedAt: existing.updatedAt,
            expiresAt: existing.expiresAt,
          },
          {
            $set: {
              ...key,
              fingerprint,
              state: 'IN_PROGRESS',
              taskId: command.taskId,
              createdAt: updatedAt,
              updatedAt,
              leaseUntil: new Date(
                updatedAt.getTime() + TASK_OPERATION_LEASE_MS,
              ),
              expiresAt: new Date(
                updatedAt.getTime() + TASK_OPERATION_RETENTION_MS,
              ),
            },
            $unset: { result: '' },
          },
        );
        if (replacement.matchedCount === 1)
          return { kind: 'CLAIMED', claimUpdatedAt: updatedAt };
        continue;
      }

      if (existing.fingerprint !== fingerprint)
        return { kind: 'PAYLOAD_MISMATCH' };
      if (existing.state === 'COMMITTED' || existing.state === 'REJECTED')
        return { kind: 'REPLAY', operation: existing };
      if (existing.leaseUntil.getTime() > now.getTime())
        return { kind: 'IN_PROGRESS' };

      const claimUpdatedAt = nextOperationTimestamp(now, existing.updatedAt);
      const claimed = await collection.updateOne(
        {
          _id: existing._id,
          state: 'IN_PROGRESS',
          fingerprint,
          updatedAt: existing.updatedAt,
          leaseUntil: { $lte: now },
          expiresAt: { $gt: now },
        },
        {
          $set: {
            updatedAt: claimUpdatedAt,
            leaseUntil: new Date(
              claimUpdatedAt.getTime() + TASK_OPERATION_LEASE_MS,
            ),
          },
        },
      );
      if (claimed.matchedCount === 1)
        return { kind: 'CLAIMED', claimUpdatedAt };
    }

    return { kind: 'IN_PROGRESS' };
  }

  private async findLifecycleOperation(
    request: TaskLifecyclePersistenceRequest,
  ): Promise<TaskLifecycleOperationDocument | null> {
    return this.database
      .collection<TaskLifecycleOperationDocument>(TASK_OPERATION_COLLECTION)
      .findOne({
        actorId: request.context.actorId,
        projectId: request.context.projectId,
        operationId: request.command.operationId,
      });
  }

  private async finishLifecycleOperation(
    session: mongoose.mongo.ClientSession,
    request: TaskLifecyclePersistenceRequest,
    claimUpdatedAt: Date,
    result: TaskLifecycleOperationResult,
  ): Promise<void> {
    const updatedAt = nextOperationTimestamp(request.now, claimUpdatedAt);
    const update = await this.database
      .collection<TaskLifecycleOperationDocument>(TASK_OPERATION_COLLECTION)
      .updateOne(
        {
          actorId: request.context.actorId,
          projectId: request.context.projectId,
          operationId: request.command.operationId,
          taskId: request.command.taskId,
          fingerprint: request.fingerprint,
          state: 'IN_PROGRESS',
          updatedAt: claimUpdatedAt,
        },
        {
          $set: {
            state: result.outcome,
            result,
            updatedAt,
            leaseUntil: updatedAt,
          },
        },
        { session },
      );
    if (update.matchedCount !== 1)
      throw new Error('Task lifecycle operation claim was lost');
  }

  private async makeLifecycleOperationRetryable(
    request: TaskLifecyclePersistenceRequest,
    claimUpdatedAt: Date,
  ): Promise<void> {
    const updatedAt = nextOperationTimestamp(request.now, claimUpdatedAt);
    await this.database
      .collection<TaskLifecycleOperationDocument>(TASK_OPERATION_COLLECTION)
      .updateOne(
        {
          actorId: request.context.actorId,
          projectId: request.context.projectId,
          operationId: request.command.operationId,
          fingerprint: request.fingerprint,
          state: 'IN_PROGRESS',
          updatedAt: claimUpdatedAt,
        },
        { $set: { updatedAt, leaseUntil: updatedAt } },
      );
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

function lifecycleOperationResult(
  operation: TaskLifecycleOperationDocument,
  replayed: boolean,
  reconciled: boolean,
): TaskLifecycleCommandResult {
  const result = operation.result;
  if (!result) throw new Error('Task lifecycle operation result is missing');
  if (result.outcome === 'COMMITTED') {
    return {
      kind: 'COMMITTED',
      status: result.status,
      version: result.version,
      completedAt: result.completedAt,
      updatedAt: result.updatedAt,
      replayed,
      reconciled,
    };
  }
  return {
    kind: 'REJECTED',
    code: result.code,
    ...(result.currentStatus ? { currentStatus: result.currentStatus } : {}),
    ...(result.currentVersion !== undefined
      ? { currentVersion: result.currentVersion }
      : {}),
    replayed,
  };
}

function nextOperationTimestamp(now: Date, previous: Date): Date {
  return new Date(Math.max(now.getTime(), previous.getTime() + 1));
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    error instanceof mongoose.mongo.MongoServerError && error.code === 11000
  );
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
