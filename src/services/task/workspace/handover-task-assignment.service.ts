import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { IAM_PERSISTENCE } from '../../iam/infrastructure/persistence';
import {
  TASK_WORKSPACE_REPOSITORY,
  TaskWorkspaceRepository,
} from './task-workspace.repository';
import {
  WORKSPACE_TASKS_COLLECTION,
  WORKSPACE_TASK_EVENTS_COLLECTION,
  WORKSPACE_TASK_OPERATIONS_COLLECTION,
  type WorkspaceTaskDocument,
  type WorkspaceTaskEventRecord,
} from './task-workspace.types';

export type HandoverTaskTransferItemState =
  'PENDING' | 'CONFIRMED' | 'UNKNOWN' | 'CONFLICT' | 'FAILED';

export interface HandoverTaskAssignmentInput {
  organizationId: string;
  projectId: string;
  actorId: string;
  intentId: string;
  handoverId: string;
  revisionId: string;
  assignmentVersion: number;
  taskId: string;
  expectedTaskVersion: number;
  targetAssigneeId: string;
}

export interface HandoverTaskAssignmentOutcome {
  state: Exclude<HandoverTaskTransferItemState, 'PENDING'>;
  committedTaskVersion: number | null;
  safeErrorCode: string | null;
  replayed: boolean;
}

interface StoredTaskOperationReceipt {
  _id?: Types.ObjectId;
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
  result?: {
    outcome?: 'CONFIRMED' | 'CONFLICT' | 'FAILED';
    committedTaskVersion?: number | null;
    targetAssigneeId?: string;
    safeErrorCode?: string | null;
  };
}

@Injectable()
export class HandoverTaskAssignmentService {
  constructor(
    @Inject(TASK_WORKSPACE_REPOSITORY)
    private readonly repository: TaskWorkspaceRepository,
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly iamConnection?: Connection,
  ) {}

  private fingerprint(input: HandoverTaskAssignmentInput): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          op: 'HANDOVER_ASSIGN_TASK',
          organizationId: input.organizationId.toLowerCase(),
          projectId: input.projectId.toLowerCase(),
          handoverId: input.handoverId.toLowerCase(),
          revisionId: input.revisionId.toLowerCase(),
          assignmentVersion: input.assignmentVersion,
          taskId: input.taskId.toLowerCase(),
          expectedTaskVersion: input.expectedTaskVersion,
          targetAssigneeId: input.targetAssigneeId.toLowerCase(),
        }),
      )
      .digest('hex');
  }

  async verifyProjectTaskExists(
    organizationId: string,
    projectId: string,
    taskId: string,
  ): Promise<{
    exists: boolean;
    status: string | null;
    version: number | null;
    assigneeId: string | null;
  }> {
    const db = this.repository.db;
    const row = await db
      .collection<WorkspaceTaskDocument>(WORKSPACE_TASKS_COLLECTION)
      .findOne({
        _id: new Types.ObjectId(taskId.toLowerCase()),
        projectId: new Types.ObjectId(projectId.toLowerCase()),
      });
    if (
      !row ||
      (row.organizationId &&
        row.organizationId.toHexString() !== organizationId.toLowerCase())
    ) {
      return { exists: false, status: null, version: null, assigneeId: null };
    }
    return {
      exists: true,
      status: row.status,
      version: row.version,
      assigneeId: row.assigneeId ? row.assigneeId.toHexString() : null,
    };
  }

  async inspectTasksCurrentState(
    organizationId: string,
    projectId: string,
    taskIds: readonly string[],
  ): Promise<
    Map<
      string,
      {
        exists: boolean;
        status: string | null;
        version: number | null;
        assigneeId: string | null;
      }
    >
  > {
    const out = new Map<
      string,
      {
        exists: boolean;
        status: string | null;
        version: number | null;
        assigneeId: string | null;
      }
    >();
    const normalizedIds = [
      ...new Set(
        taskIds
          .map((id) => id.trim().toLowerCase())
          .filter((id) => /^[a-f0-9]{24}$/.test(id)),
      ),
    ];
    if (normalizedIds.length === 0) {
      return out;
    }

    const db = this.repository.db;
    const orgLower = organizationId.toLowerCase();
    const rows = await db
      .collection<WorkspaceTaskDocument>(WORKSPACE_TASKS_COLLECTION)
      .find({
        _id: { $in: normalizedIds.map((id) => new Types.ObjectId(id)) },
        projectId: new Types.ObjectId(projectId.toLowerCase()),
      })
      .toArray();

    for (const id of normalizedIds) {
      out.set(id, {
        exists: false,
        status: null,
        version: null,
        assigneeId: null,
      });
    }
    for (const row of rows) {
      if (
        row.organizationId &&
        row.organizationId.toHexString().toLowerCase() !== orgLower
      ) {
        continue;
      }
      const hex = row._id.toHexString().toLowerCase();
      out.set(hex, {
        exists: true,
        status: row.status,
        version: row.version,
        assigneeId: row.assigneeId
          ? row.assigneeId.toHexString().toLowerCase()
          : null,
      });
    }
    return out;
  }

  async assignTaskForHandover(
    input: HandoverTaskAssignmentInput,
  ): Promise<HandoverTaskAssignmentOutcome> {
    if (!this.iamConnection) {
      throw new ServiceUnavailableException({
        code: 'TASK_SERVICE_UNAVAILABLE',
        message: 'Task persistence connection is unavailable.',
      });
    }

    const db = this.repository.db;
    const fp = this.fingerprint(input);
    const orgObjId = new Types.ObjectId(input.organizationId.toLowerCase());
    const projectObjId = new Types.ObjectId(input.projectId.toLowerCase());
    const actorObjId = new Types.ObjectId(input.actorId.toLowerCase());
    const taskObjId = new Types.ObjectId(input.taskId.toLowerCase());
    const targetObjId = new Types.ObjectId(
      input.targetAssigneeId.toLowerCase(),
    );
    const operationId = `handover:${input.intentId}`;

    const session = await this.iamConnection.startSession();
    try {
      let outcome!: HandoverTaskAssignmentOutcome;
      await session.withTransaction(async () => {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
        const opsCol = db.collection<StoredTaskOperationReceipt>(
          WORKSPACE_TASK_OPERATIONS_COLLECTION,
        );
        const tasksCol = db.collection<WorkspaceTaskDocument>(
          WORKSPACE_TASKS_COLLECTION,
        );
        const eventsCol = db.collection<WorkspaceTaskEventRecord>(
          WORKSPACE_TASK_EVENTS_COLLECTION,
        );

        const existingOp = await opsCol.findOne(
          {
            actorId: actorObjId,
            projectId: projectObjId,
            operationId,
          },
          { session },
        );

        if (existingOp && existingOp.expiresAt > now) {
          if (existingOp.fingerprint !== fp) {
            outcome = {
              state: 'FAILED',
              committedTaskVersion: null,
              safeErrorCode: 'INTENT_FINGERPRINT_MISMATCH',
              replayed: false,
            };
            return;
          }
          if (existingOp.state === 'COMMITTED' && existingOp.result) {
            outcome = {
              state: 'CONFIRMED',
              committedTaskVersion:
                existingOp.result.committedTaskVersion ?? null,
              safeErrorCode: null,
              replayed: true,
            };
            return;
          }
          if (existingOp.state === 'REJECTED' && existingOp.result) {
            outcome = {
              state:
                existingOp.result.outcome === 'CONFLICT'
                  ? 'CONFLICT'
                  : 'FAILED',
              committedTaskVersion: null,
              safeErrorCode:
                existingOp.result.safeErrorCode ?? 'TASK_TRANSFER_REJECTED',
              replayed: true,
            };
            return;
          }
        }

        const task = await tasksCol.findOne(
          {
            _id: taskObjId,
            projectId: projectObjId,
          },
          { session },
        );

        const writeRejected = async (
          rejectKind: 'CONFLICT' | 'FAILED',
          safeErrorCode: string,
        ) => {
          await opsCol.updateOne(
            {
              actorId: actorObjId,
              projectId: projectObjId,
              operationId,
            },
            {
              $setOnInsert: {
                _id: new Types.ObjectId(),
                createdAt: now,
              },
              $set: {
                fingerprint: fp,
                state: 'REJECTED',
                taskId: taskObjId,
                updatedAt: now,
                leaseUntil: now,
                expiresAt,
                result: {
                  outcome: rejectKind,
                  committedTaskVersion: null,
                  targetAssigneeId: input.targetAssigneeId.toLowerCase(),
                  safeErrorCode,
                },
              },
            },
            { upsert: true, session },
          );
          outcome = {
            state: rejectKind,
            committedTaskVersion: null,
            safeErrorCode,
            replayed: false,
          };
        };

        if (
          !task ||
          (task.organizationId &&
            task.organizationId.toHexString() !==
              input.organizationId.toLowerCase())
        ) {
          await writeRejected('FAILED', 'TASK_NOT_FOUND');
          return;
        }

        if (task.status === 'DONE' || task.status === 'CANCELLED') {
          await writeRejected('FAILED', 'TASK_TERMINAL_STATE');
          return;
        }

        if (task.version !== input.expectedTaskVersion) {
          await writeRejected('CONFLICT', 'TASK_VERSION_CONFLICT');
          return;
        }

        const nextVersion = task.version + 1;
        const updateRes = await tasksCol.updateOne(
          {
            _id: taskObjId,
            projectId: projectObjId,
            version: input.expectedTaskVersion,
          },
          {
            $set: {
              assigneeId: targetObjId,
              updatedAt: now,
            },
            $unset: { subtaskCounts: '' },
            $inc: { version: 1 },
          },
          { session },
        );

        if (updateRes.matchedCount !== 1) {
          await writeRejected('CONFLICT', 'TASK_VERSION_CONFLICT');
          return;
        }

        await eventsCol.insertOne(
          {
            _id: new Types.ObjectId(),
            taskId: taskObjId,
            projectId: projectObjId,
            organizationId: orgObjId,
            eventType: 'TASK_UPDATED',
            actorType: 'USER',
            actorId: actorObjId,
            source: 'INTERNAL_SERVICE',
            changedFields: ['assigneeId'],
            taskVersion: nextVersion,
            version: nextVersion,
            occurredAt: now,
            timestamp: now,
            operationId,
            correlationId: input.handoverId.toLowerCase(),
            delta: {
              type: 'FIELD_UPDATE',
              changedFields: ['assigneeId'],
            },
          },
          { session },
        );

        await opsCol.updateOne(
          {
            actorId: actorObjId,
            projectId: projectObjId,
            operationId,
          },
          {
            $setOnInsert: {
              _id: new Types.ObjectId(),
              createdAt: now,
            },
            $set: {
              fingerprint: fp,
              state: 'COMMITTED',
              taskId: taskObjId,
              updatedAt: now,
              leaseUntil: now,
              expiresAt,
              result: {
                outcome: 'CONFIRMED',
                committedTaskVersion: nextVersion,
                targetAssigneeId: input.targetAssigneeId.toLowerCase(),
                safeErrorCode: null,
              },
            },
          },
          { upsert: true, session },
        );

        outcome = {
          state: 'CONFIRMED',
          committedTaskVersion: nextVersion,
          safeErrorCode: null,
          replayed: false,
        };
      });
      return outcome;
    } finally {
      await session.endSession();
    }
  }

  async reconcileTaskForHandover(
    input: HandoverTaskAssignmentInput,
  ): Promise<HandoverTaskAssignmentOutcome> {
    const db = this.repository.db;
    const fp = this.fingerprint(input);
    const projectObjId = new Types.ObjectId(input.projectId.toLowerCase());
    const actorObjId = new Types.ObjectId(input.actorId.toLowerCase());
    const taskObjId = new Types.ObjectId(input.taskId.toLowerCase());
    const operationId = `handover:${input.intentId}`;
    const targetLower = input.targetAssigneeId.toLowerCase();

    const [existingOp, currentTask] = await Promise.all([
      db
        .collection<StoredTaskOperationReceipt>(
          WORKSPACE_TASK_OPERATIONS_COLLECTION,
        )
        .findOne({
          actorId: actorObjId,
          projectId: projectObjId,
          operationId,
        }),
      db.collection<WorkspaceTaskDocument>(WORKSPACE_TASKS_COLLECTION).findOne({
        _id: taskObjId,
        projectId: projectObjId,
      }),
    ]);

    if (existingOp) {
      if (existingOp.fingerprint !== fp) {
        return {
          state: 'FAILED',
          committedTaskVersion: null,
          safeErrorCode: 'INTENT_FINGERPRINT_MISMATCH',
          replayed: false,
        };
      }
      if (existingOp.state === 'COMMITTED') {
        const currentAssignee = currentTask?.assigneeId
          ? currentTask.assigneeId.toHexString().toLowerCase()
          : null;
        if (
          !currentTask ||
          (currentTask.organizationId &&
            currentTask.organizationId.toHexString() !==
              input.organizationId.toLowerCase())
        ) {
          return {
            state: 'FAILED',
            committedTaskVersion: null,
            safeErrorCode: 'TASK_NOT_FOUND',
            replayed: true,
          };
        }
        // Scenario A10: receipt committed to B earlier, then task was legitimately reassigned to C -> NEVER overwrite C!
        if (currentAssignee !== targetLower) {
          return {
            state: 'CONFLICT',
            committedTaskVersion: null,
            safeErrorCode: 'TASK_REASSIGNED_AFTER_DISPATCH',
            replayed: true,
          };
        }
        return {
          state: 'CONFIRMED',
          committedTaskVersion:
            existingOp.result?.committedTaskVersion ?? currentTask.version,
          safeErrorCode: null,
          replayed: true,
        };
      }
      if (existingOp.state === 'REJECTED') {
        return {
          state:
            existingOp.result?.outcome === 'CONFLICT' ? 'CONFLICT' : 'FAILED',
          committedTaskVersion: null,
          safeErrorCode:
            existingOp.result?.safeErrorCode ?? 'TASK_TRANSFER_REJECTED',
          replayed: true,
        };
      }
    }

    // No committed/rejected receipt exists yet:
    if (
      !currentTask ||
      (currentTask.organizationId &&
        currentTask.organizationId.toHexString() !==
          input.organizationId.toLowerCase())
    ) {
      return {
        state: 'FAILED',
        committedTaskVersion: null,
        safeErrorCode: 'TASK_NOT_FOUND',
        replayed: false,
      };
    }

    const currentAssignee = currentTask.assigneeId
      ? currentTask.assigneeId.toHexString().toLowerCase()
      : null;

    // 19:132 — Current assignee matches B without any operation receipt: cannot claim our operation succeeded!
    if (currentAssignee === targetLower) {
      return {
        state: 'CONFLICT',
        committedTaskVersion: null,
        safeErrorCode: 'UNVERIFIED_ASSIGNMENT_WITHOUT_RECEIPT',
        replayed: false,
      };
    }

    // If task version already drifted (e.g., assigned to C), report CONFLICT without touching C!
    if (currentTask.version !== input.expectedTaskVersion) {
      return {
        state: 'CONFLICT',
        committedTaskVersion: null,
        safeErrorCode: 'TASK_VERSION_CONFLICT',
        replayed: false,
      };
    }

    // Original dispatch never reached Task DB and task is still untouched at expectedTaskVersion: safe to execute with same intentId
    return this.assignTaskForHandover(input);
  }
}
