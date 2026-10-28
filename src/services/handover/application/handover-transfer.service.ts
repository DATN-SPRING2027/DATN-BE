import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { HandoverProjectActorContext } from '../../iam/application/projects/handover-iam-scope.service';
import { HandoverTaskAssignmentService } from '../../task/workspace/handover-task-assignment.service';
import {
  aggregateTaskTransferState,
  computeCommandFingerprint,
  deriveTaskIntentId,
} from './handover.domain';
import { HandoverRepository } from './handover.repository';
import type {
  ReconcileTransferDto,
  StartTransferDto,
  StoredAcceptanceDoc,
  StoredHandoverDoc,
  StoredOperationDoc,
  StoredRevisionDoc,
  TaskTransferAggregateState,
  TaskTransferChildResultState,
  TaskTransferResultDto,
  TransferDto,
} from './handover.types';

@Injectable()
export class HandoverTransferService {
  constructor(
    private readonly repository: HandoverRepository,
    private readonly taskAssignmentService: HandoverTaskAssignmentService,
  ) {}

  private mapChildDocToDto(child: StoredOperationDoc): TaskTransferResultDto {
    const taskId = child.taskIntent?.taskId.toHexString() ?? '';
    let state: TaskTransferChildResultState = 'PENDING';
    if (child.state === 'COMMITTED') state = 'CONFIRMED';
    else if (child.state === 'UNKNOWN') state = 'UNKNOWN';
    else if (child.state === 'CONFLICT') state = 'CONFLICT';
    else if (child.state === 'FAILED' || child.state === 'REJECTED')
      state = 'FAILED';

    return {
      taskId,
      intentId: child.key,
      state,
      expectedTaskVersion: child.taskIntent?.expectedVersion ?? 1,
      committedTaskVersion:
        state === 'CONFIRMED' ? (child.taskOutcome?.taskVersion ?? null) : null,
      safeErrorCode:
        child.safeErrorCode ?? child.taskOutcome?.safeErrorCode ?? null,
    };
  }

  private buildTransferDto(
    parent: StoredOperationDoc,
    children: StoredOperationDoc[],
  ): TransferDto {
    const tasks = children.map((c) => this.mapChildDocToDto(c));
    const aggState = aggregateTaskTransferState(tasks);
    return {
      id: parent._id.toHexString(),
      handoverId: parent.handoverId!.toHexString(),
      revisionId: parent.revisionId!.toHexString(),
      successorUserId: parent.successorUserId!,
      assignmentVersion: parent.assignmentVersion!,
      tasks,
      state: aggState,
    };
  }

  private mapAggregateToStoredState(
    agg: TaskTransferAggregateState,
  ): StoredOperationDoc['state'] {
    if (agg === 'CONFIRMED') return 'COMMITTED';
    if (agg === 'PARTIAL') return 'PARTIAL';
    if (agg === 'UNKNOWN') return 'UNKNOWN';
    if (agg === 'CONFLICT') return 'CONFLICT';
    if (agg === 'FAILED') return 'FAILED';
    return 'PENDING';
  }

  async getTransfer(input: {
    handover: StoredHandoverDoc;
    transferId: string;
  }): Promise<TransferDto> {
    const parentObjId = new Types.ObjectId(input.transferId);
    const parent = await this.repository.operations
      .findOne({
        _id: parentObjId,
        handoverId: input.handover._id,
        organizationId: input.handover.organizationId,
        projectId: input.handover.projectId,
        kind: 'TASK_TRANSFER',
      })
      .lean<StoredOperationDoc>()
      .exec();

    if (!parent) {
      throw new NotFoundException({
        code: 'TASK_TRANSFER_NOT_FOUND',
        message: 'Task transfer operation not found.',
        details: {},
      });
    }

    const children = await this.repository.operations
      .find({
        parentOperationId: parent._id,
        kind: 'TASK_TRANSFER_CHILD',
      })
      .sort({ _id: 1 })
      .lean<StoredOperationDoc[]>()
      .exec();

    return this.buildTransferDto(parent, children);
  }

  async listTransfersForHandover(
    handover: StoredHandoverDoc,
  ): Promise<TransferDto[]> {
    const parents = await this.repository.operations
      .find({
        handoverId: handover._id,
        organizationId: handover.organizationId,
        projectId: handover.projectId,
        kind: 'TASK_TRANSFER',
      })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean<StoredOperationDoc[]>()
      .exec();

    if (parents.length === 0) return [];
    const parentIds = parents.map((p) => p._id);
    const allChildren = await this.repository.operations
      .find({
        parentOperationId: { $in: parentIds },
        kind: 'TASK_TRANSFER_CHILD',
      })
      .sort({ _id: 1 })
      .lean<StoredOperationDoc[]>()
      .exec();

    return parents.map((p) =>
      this.buildTransferDto(
        p,
        allChildren.filter(
          (c) => c.parentOperationId?.toHexString() === p._id.toHexString(),
        ),
      ),
    );
  }

  async startTransfer(input: {
    actor: HandoverProjectActorContext;
    handover: StoredHandoverDoc;
    expectedVersion: number;
    idempotencyKey: string;
    dto: StartTransferDto;
  }): Promise<{ transfer: TransferDto; version: number; replayed: boolean }> {
    const namespace = `handover:${input.handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'startHandoverTaskTransfer',
      organizationId: input.actor.organizationId,
      projectId: input.actor.projectId,
      resourceScope: namespace,
      expectedVersion: input.expectedVersion,
      payload: input.dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: input.actor.organizationId,
      projectId: input.actor.projectId,
      actorUserId: input.actor.userId,
      namespace,
      key: input.idempotencyKey,
    });

    if (existingOp) {
      if (existingOp.fingerprint !== fingerprint) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_CONFLICT',
          message:
            'Idempotency-Key was already used with a different payload or version.',
          details: {},
        });
      }
      if (existingOp.kind === 'TASK_TRANSFER') {
        const children = await this.repository.operations
          .find({
            parentOperationId: existingOp._id,
            kind: 'TASK_TRANSFER_CHILD',
          })
          .sort({ _id: 1 })
          .lean<StoredOperationDoc[]>()
          .exec();
        return {
          transfer: this.buildTransferDto(existingOp, children),
          version:
            existingOp.receipt?.resourceVersion ?? input.handover.version,
          replayed: true,
        };
      }
    }

    if (input.handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Task transfer requires an OPEN handover.',
        details: {},
      });
    }
    if (input.handover.version !== input.expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Handover aggregate version conflict.',
        details: {},
      });
    }
    if (!input.handover.successorUserId) {
      throw new ConflictException({
        code: 'SUCCESSOR_NOT_ASSIGNED',
        message: 'Cannot transfer tasks before successor B is assigned.',
        details: {},
      });
    }
    if (
      !input.handover.publishedRevisionId ||
      input.handover.publishedRevisionId.toHexString() !== input.dto.revisionId
    ) {
      throw new ConflictException({
        code: 'STALE_REVISION_REFERENCE',
        message: 'revisionId does not match the current published revision.',
        details: {},
      });
    }
    if (input.handover.assignmentVersion !== input.dto.assignmentVersion) {
      throw new ConflictException({
        code: 'ASSIGNMENT_EPOCH_MISMATCH',
        message: 'assignmentVersion does not match the current handover epoch.',
        details: {},
      });
    }

    const successorUserId = input.handover.successorUserId;
    const revision = await this.repository.revisions
      .findOne({
        _id: input.handover.publishedRevisionId,
        handoverId: input.handover._id,
      })
      .lean<StoredRevisionDoc>()
      .exec();
    if (!revision) {
      throw new NotFoundException({
        code: 'REVISION_NOT_FOUND',
        message: 'Published revision not found.',
        details: {},
      });
    }

    // Verify B has accepted the current published package before transferring tasks!
    const pkgAcc = await this.repository.acceptances
      .findOne({
        handoverId: input.handover._id,
        revisionId: revision._id,
        successorUserId: successorUserId.toLowerCase(),
        assignmentVersion: input.handover.assignmentVersion,
        kind: 'PACKAGE',
        decision: 'ACCEPTED',
      })
      .lean<StoredAcceptanceDoc>()
      .exec();

    if (!pkgAcc) {
      throw new ConflictException({
        code: 'PACKAGE_NOT_ACCEPTED',
        message:
          'Successor B must accept the current published package before task transfer.',
        details: {},
      });
    }

    const selectedByTaskId = new Map(
      revision.selectedTasks.map((t) => [t.taskId.toHexString(), t]),
    );
    for (const reqTask of input.dto.tasks) {
      if (!selectedByTaskId.has(reqTask.taskId.toLowerCase())) {
        throw new UnprocessableEntityException({
          code: 'TASK_NOT_IN_HANDOVER_SELECTION',
          message:
            'All transferred tasks must belong to the published handover task selection.',
          details: { taskId: reqTask.taskId },
        });
      }
    }

    // Phase 1: Durable intent creation inside Handover DB transaction
    const { parentId, childDocs, nextVersion } =
      await this.repository.withTransaction(async (session) => {
        const nextVer = input.expectedVersion + 1;
        const upd = await this.repository.handovers.updateOne(
          {
            _id: input.handover._id,
            status: 'OPEN',
            version: input.expectedVersion,
          },
          { $set: { version: nextVer } },
          { session },
        );
        if (upd.matchedCount !== 1) {
          throw new ConflictException({
            code: 'VERSION_CONFLICT',
            message: 'Concurrent handover version update detected.',
            details: {},
          });
        }

        const pId = new Types.ObjectId();
        const now = new Date();
        await this.repository.operations.create(
          [
            {
              _id: pId,
              schemaVersion: 2,
              organizationId: input.handover.organizationId,
              projectId: input.handover.projectId,
              handoverId: input.handover._id,
              actorUserId: input.actor.userId,
              namespace,
              key: input.idempotencyKey,
              fingerprint,
              kind: 'TASK_TRANSFER',
              state: 'DISPATCHED',
              expectedVersion: input.expectedVersion,
              assignmentVersion: input.handover.assignmentVersion,
              revisionId: revision._id,
              successorUserId,
              receipt: {
                resourceId: input.handover._id,
                resourceVersion: nextVer,
                transferId: pId,
                outcome: 'DISPATCHED',
              },
              leaseOwner: 'handover-transfer',
              leaseExpiresAt: new Date(now.getTime() + 60_000),
              fence: 1,
            },
          ],
          { session },
        );

        const createdChildren = await this.repository.operations.create(
          input.dto.tasks.map((reqTask) => {
            const sel = selectedByTaskId.get(reqTask.taskId.toLowerCase());
            const intentKey = deriveTaskIntentId(
              pId.toHexString(),
              reqTask.taskId,
            );
            return {
              _id: new Types.ObjectId(),
              schemaVersion: 2 as const,
              organizationId: input.handover.organizationId,
              projectId: input.handover.projectId,
              handoverId: input.handover._id,
              actorUserId: input.actor.userId,
              namespace: `transfer-child:${pId.toHexString()}`,
              key: intentKey,
              fingerprint: computeCommandFingerprint({
                operation: 'startHandoverTaskTransferChild',
                organizationId: input.actor.organizationId,
                projectId: input.actor.projectId,
                resourceScope: `transfer-child:${pId.toHexString()}`,
                expectedVersion: reqTask.expectedTaskVersion,
                payload: reqTask,
              }),
              kind: 'TASK_TRANSFER_CHILD' as const,
              state: 'DISPATCHED' as const,
              expectedVersion: input.expectedVersion,
              assignmentVersion: input.handover.assignmentVersion,
              revisionId: revision._id,
              successorUserId,
              parentOperationId: pId,
              taskIntent: {
                taskId: new Types.ObjectId(reqTask.taskId),
                expectedVersion: reqTask.expectedTaskVersion,
                expectedAssigneeId: sel?.expectedAssigneeId ?? null,
                targetUserId: successorUserId,
              },
            };
          }),
          { session, ordered: true },
        );

        await this.repository.appendAuditAndOutbox(
          {
            organizationId: input.actor.organizationId,
            projectId: input.actor.projectId,
            actorUserId: input.actor.userId,
            action: 'handover.task_transfer.started',
            targetResource: 'handover_transfer',
            targetResourceId: pId.toHexString(),
            metadata: {
              handoverId: input.handover._id.toHexString(),
              taskCount: input.dto.tasks.length,
            },
          },
          {
            eventName: 'handover.task_transfer.started',
            aggregateType: 'handover',
            aggregateId: input.handover._id.toHexString(),
            payload: {
              transferId: pId.toHexString(),
              revisionId: revision._id.toHexString(),
            },
          },
          session,
        );

        return {
          parentId: pId,
          childDocs: createdChildren.map((c) => c.toObject()),
          nextVersion: nextVer,
        };
      });

    // Phase 2: Dispatch each durable child intent through the owning Task application service
    for (const child of childDocs) {
      const taskIdHex = child.taskIntent!.taskId.toHexString();
      try {
        const res = await this.taskAssignmentService.assignTaskForHandover({
          organizationId: input.actor.organizationId,
          projectId: input.actor.projectId,
          actorId: input.actor.userId,
          intentId: child.key,
          handoverId: input.handover._id.toHexString(),
          revisionId: revision._id.toHexString(),
          assignmentVersion: input.handover.assignmentVersion,
          taskId: taskIdHex,
          expectedTaskVersion: child.taskIntent!.expectedVersion,
          targetAssigneeId: successorUserId,
        });

        if (res.state === 'CONFIRMED') {
          await this.repository.operations.updateOne(
            { _id: child._id },
            {
              $set: {
                state: 'COMMITTED',
                taskOutcome: {
                  state: 'COMMITTED',
                  ...(res.committedTaskVersion !== null
                    ? { taskVersion: res.committedTaskVersion }
                    : {}),
                  assigneeId: successorUserId,
                  owningOperationId: `handover:${child.key}`,
                },
              },
            },
          );
        } else if (res.state === 'CONFLICT') {
          const code = res.safeErrorCode ?? 'TASK_VERSION_CONFLICT';
          await this.repository.operations.updateOne(
            { _id: child._id },
            {
              $set: {
                state: 'CONFLICT',
                safeErrorCode: code,
                taskOutcome: {
                  state: 'CONFLICT',
                  safeErrorCode: code,
                },
              },
            },
          );
        } else {
          const code = res.safeErrorCode ?? 'TASK_TRANSFER_FAILED';
          await this.repository.operations.updateOne(
            { _id: child._id },
            {
              $set: {
                state: 'FAILED',
                safeErrorCode: code,
                taskOutcome: {
                  state: 'REJECTED',
                  safeErrorCode: code,
                },
              },
            },
          );
        }
      } catch {
        // Network/timeout/transient loss after dispatch -> record UNKNOWN, NEVER roll back or guess! (A10 / A11)
        await this.repository.operations.updateOne(
          { _id: child._id },
          {
            $set: {
              state: 'UNKNOWN',
              safeErrorCode: 'TASK_OUTCOME_UNKNOWN',
              taskOutcome: {
                state: 'UNKNOWN',
                safeErrorCode: 'TASK_OUTCOME_UNKNOWN',
              },
            },
          },
        );
      }
    }

    const updatedChildren = await this.repository.operations
      .find({ parentOperationId: parentId, kind: 'TASK_TRANSFER_CHILD' })
      .sort({ _id: 1 })
      .lean<StoredOperationDoc[]>()
      .exec();

    const taskDtos = updatedChildren.map((c) => this.mapChildDocToDto(c));
    const aggState = aggregateTaskTransferState(taskDtos);
    const storedState = this.mapAggregateToStoredState(aggState);

    const updatedParent = await this.repository.operations
      .findOneAndUpdate(
        { _id: parentId },
        {
          $set: {
            state: storedState,
            receipt: {
              resourceId: input.handover._id,
              resourceVersion: nextVersion,
              transferId: parentId,
              outcome: aggState,
            },
          },
        },
        { new: true },
      )
      .lean<StoredOperationDoc>()
      .exec();

    return {
      transfer: this.buildTransferDto(updatedParent!, updatedChildren),
      version: nextVersion,
      replayed: false,
    };
  }

  async reconcileTransfer(input: {
    actor: HandoverProjectActorContext;
    handover: StoredHandoverDoc;
    transferId: string;
    expectedVersion: number;
    idempotencyKey: string;
    dto: ReconcileTransferDto;
  }): Promise<{ transfer: TransferDto; version: number; replayed: boolean }> {
    if (input.dto.transferId !== input.transferId) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Body transferId must equal path transferId.',
        details: { field: 'transferId' },
      });
    }

    const namespace = `handover:${input.handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'reconcileHandoverTaskTransfer',
      organizationId: input.actor.organizationId,
      projectId: input.actor.projectId,
      resourceScope: `${namespace}:transfer:${input.transferId}`,
      expectedVersion: input.expectedVersion,
      payload: input.dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: input.actor.organizationId,
      projectId: input.actor.projectId,
      actorUserId: input.actor.userId,
      namespace,
      key: input.idempotencyKey,
    });
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED'
    ) {
      const transfer = await this.getTransfer({
        handover: input.handover,
        transferId: input.transferId,
      });
      return {
        transfer,
        version: existingOp?.receipt?.resourceVersion ?? input.handover.version,
        replayed: true,
      };
    }

    if (input.handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Cannot reconcile task transfer on a closed handover.',
        details: {},
      });
    }
    if (input.handover.version !== input.expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Handover aggregate version conflict.',
        details: {},
      });
    }

    const parentObjId = new Types.ObjectId(input.transferId);
    const parent = await this.repository.operations
      .findOne({
        _id: parentObjId,
        handoverId: input.handover._id,
        organizationId: input.handover.organizationId,
        projectId: input.handover.projectId,
        kind: 'TASK_TRANSFER',
      })
      .lean<StoredOperationDoc>()
      .exec();

    if (!parent) {
      throw new NotFoundException({
        code: 'TASK_TRANSFER_NOT_FOUND',
        message: 'Task transfer operation not found.',
        details: {},
      });
    }

    const children = await this.repository.operations
      .find({ parentOperationId: parent._id, kind: 'TASK_TRANSFER_CHILD' })
      .sort({ _id: 1 })
      .lean<StoredOperationDoc[]>()
      .exec();

    // Reconcile any PENDING / DISPATCHED / UNKNOWN child intents against owning Task receipt + current Task state (A10)
    for (const child of children) {
      if (
        child.state !== 'PENDING' &&
        child.state !== 'DISPATCHED' &&
        child.state !== 'UNKNOWN'
      ) {
        continue;
      }
      const outcome = await this.taskAssignmentService.reconcileTaskForHandover(
        {
          organizationId: input.actor.organizationId,
          projectId: input.actor.projectId,
          actorId: parent.actorUserId,
          intentId: child.key,
          handoverId: input.handover._id.toHexString(),
          revisionId: parent.revisionId!.toHexString(),
          assignmentVersion: parent.assignmentVersion!,
          taskId: child.taskIntent!.taskId.toHexString(),
          expectedTaskVersion: child.taskIntent!.expectedVersion,
          targetAssigneeId: child.taskIntent!.targetUserId,
        },
      );

      if (outcome.state === 'CONFIRMED') {
        await this.repository.operations.updateOne(
          { _id: child._id },
          {
            $set: {
              state: 'COMMITTED',
              taskOutcome: {
                state: 'COMMITTED',
                ...(outcome.committedTaskVersion !== null
                  ? { taskVersion: outcome.committedTaskVersion }
                  : {}),
                assigneeId: child.taskIntent!.targetUserId,
                owningOperationId: `handover:${child.key}`,
              },
            },
            $unset: { safeErrorCode: 1 },
          },
        );
      } else if (outcome.state === 'CONFLICT') {
        const code = outcome.safeErrorCode ?? 'TASK_VERSION_CONFLICT';
        await this.repository.operations.updateOne(
          { _id: child._id },
          {
            $set: {
              state: 'CONFLICT',
              safeErrorCode: code,
              taskOutcome: {
                state: 'CONFLICT',
                safeErrorCode: code,
              },
            },
          },
        );
      } else {
        const code = outcome.safeErrorCode ?? 'TASK_TRANSFER_FAILED';
        await this.repository.operations.updateOne(
          { _id: child._id },
          {
            $set: {
              state: 'FAILED',
              safeErrorCode: code,
              taskOutcome: {
                state: 'REJECTED',
                safeErrorCode: code,
              },
            },
          },
        );
      }
    }

    const refreshedChildren = await this.repository.operations
      .find({ parentOperationId: parent._id, kind: 'TASK_TRANSFER_CHILD' })
      .sort({ _id: 1 })
      .lean<StoredOperationDoc[]>()
      .exec();

    const taskDtos = refreshedChildren.map((c) => this.mapChildDocToDto(c));
    const aggState = aggregateTaskTransferState(taskDtos);
    const storedState = this.mapAggregateToStoredState(aggState);

    const committed = await this.repository.withTransaction(async (session) => {
      const nextVer = input.expectedVersion + 1;
      const upd = await this.repository.handovers.updateOne(
        {
          _id: input.handover._id,
          status: 'OPEN',
          version: input.expectedVersion,
        },
        { $set: { version: nextVer } },
        { session },
      );
      if (upd.matchedCount !== 1) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          message: 'Concurrent handover version update detected.',
          details: {},
        });
      }

      const updParent = await this.repository.operations
        .findOneAndUpdate(
          { _id: parent._id },
          {
            $set: {
              state: storedState,
              receipt: {
                resourceId: input.handover._id,
                resourceVersion: nextVer,
                transferId: parent._id,
                outcome: aggState,
              },
            },
          },
          { new: true, session },
        )
        .lean<StoredOperationDoc>()
        .exec();

      await this.repository.createOrClaimCommandOperation(
        {
          organizationId: input.actor.organizationId,
          projectId: input.actor.projectId,
          handoverId: input.handover._id,
          actorUserId: input.actor.userId,
          namespace,
          key: input.idempotencyKey,
          fingerprint,
          expectedVersion: input.expectedVersion,
          receipt: {
            resourceId: input.handover._id,
            resourceVersion: nextVer,
            transferId: parent._id,
            outcome: aggState,
          },
        },
        session,
      );

      await this.repository.appendAuditAndOutbox(
        {
          organizationId: input.actor.organizationId,
          projectId: input.actor.projectId,
          actorUserId: input.actor.userId,
          action: 'handover.task_transfer.reconciled',
          targetResource: 'handover_transfer',
          targetResourceId: parent._id.toHexString(),
          metadata: {
            handoverId: input.handover._id.toHexString(),
            outcome: aggState,
          },
        },
        null,
        session,
      );

      return {
        parent: updParent!,
        version: nextVer,
      };
    });

    return {
      transfer: this.buildTransferDto(committed.parent, refreshedChildren),
      version: committed.version,
      replayed: false,
    };
  }
}
