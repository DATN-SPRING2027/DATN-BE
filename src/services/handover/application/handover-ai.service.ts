import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import {
  AI_ENGINE_CLIENT,
  type AiEngineClient,
} from '../../../integrations/ai-engine/ai-engine.port';
import type { HandoverSourceViewer } from '../../capture/application/handover-capture-source.service';
import {
  HandoverIamScopeService,
  type HandoverProjectActorContext,
} from '../../iam/application/projects/handover-iam-scope.service';
import {
  computeCommandFingerprint,
  computeDependencyFingerprint,
  computeSourceSelectionFingerprint,
  parseSourceVersionNumber,
  resolveHandoverCapabilities,
  sourceRefKey,
} from './handover.domain';
import { HandoverRepository } from './handover.repository';
import { HandoverSourcesService } from './handover-sources.service';
import type {
  CitationDto,
  GenerateRequestDto,
  HandoverAnswerDto,
  JobDto,
  QuestionRequestDto,
  RetryJobDto,
  SourceCandidateDto,
  SourceCandidatesDto,
  SourceJobRequestDto,
  SourceRefDto,
  StoredHandoverDoc,
  StoredHandoverItemSnapshot,
  StoredJobDoc,
} from './handover.types';

interface SagSourceRefPayload {
  kind: SourceRefDto['kind'];
  id: string;
  version: number;
}

interface SagCitationPayload {
  source: SagSourceRefPayload;
  locator: {
    kind: CitationDto['locator']['kind'];
    value: string;
  };
}

interface SagHandoverAssistResponse {
  task: 'SOURCE_PROPOSAL' | 'DRAFT_GENERATION' | 'QUESTION_ANSWER';
  candidates?: Array<{
    source: SagSourceRefPayload;
    reason: string;
  }>;
  items?: Array<{
    title: string;
    body: string;
    requirement: string;
    sources: SagSourceRefPayload[];
    citations: SagCitationPayload[];
  }>;
  answerStatus?: 'ANSWERED' | 'INSUFFICIENT_EVIDENCE' | null;
  message?: string | null;
  sections?: Array<{
    text: string;
    citations: SagCitationPayload[];
  }>;
}

@Injectable()
export class HandoverAiService implements OnModuleInit, OnModuleDestroy {
  private static readonly LEASE_DURATION_MS = 60_000;
  private static readonly RECOVERY_SWEEP_MS = 15_000;
  private static readonly MAX_AUTO_RECOVERY_ATTEMPTS = 3;
  private static readonly MAX_REASON_CACHE_ENTRIES = 200;

  private readonly logger = new Logger(HandoverAiService.name);
  private readonly inFlightJobs = new Set<Promise<void>>();
  private readonly activeJobIds = new Set<string>();
  private readonly candidateReasonCache = new Map<
    string,
    Map<string, string>
  >();
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private isDestroyed = false;

  constructor(
    private readonly repository: HandoverRepository,
    private readonly iamScope: HandoverIamScopeService,
    private readonly sourcesService: HandoverSourcesService,
    @Optional()
    @Inject(AI_ENGINE_CLIENT)
    private readonly aiEngine?: AiEngineClient,
  ) {}

  onModuleInit(): void {
    this.recoveryTimer = setInterval(() => {
      void this.recoverStalledJobs();
    }, HandoverAiService.RECOVERY_SWEEP_MS);
    this.recoveryTimer.unref?.();
    setImmediate(() => {
      if (!this.isDestroyed) {
        void this.recoverStalledJobs();
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.isDestroyed = true;
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    await this.flushPendingJobs();
  }

  async flushPendingJobs(): Promise<void> {
    while (this.inFlightJobs.size > 0) {
      await Promise.allSettled([...this.inFlightJobs]);
    }
  }

  private setCandidateReasons(
    jobHex: string,
    reasons: Map<string, string>,
  ): void {
    if (this.candidateReasonCache.has(jobHex)) {
      this.candidateReasonCache.delete(jobHex);
    } else if (
      this.candidateReasonCache.size >=
      HandoverAiService.MAX_REASON_CACHE_ENTRIES
    ) {
      for (const oldestKey of this.candidateReasonCache.keys()) {
        this.candidateReasonCache.delete(oldestKey);
        break;
      }
    }
    this.candidateReasonCache.set(jobHex, reasons);
  }

  async recoverStalledJobs(): Promise<void> {
    if (this.isDestroyed || !this.repository) {
      return;
    }
    try {
      const jobsModel = this.repository.jobs;
      if (!jobsModel) {
        return;
      }
      const now = new Date();
      await jobsModel.updateMany(
        {
          schemaVersion: 2,
          state: 'RUNNING',
          leaseExpiresAt: { $lte: now },
          attempt: { $gte: HandoverAiService.MAX_AUTO_RECOVERY_ATTEMPTS },
        },
        {
          $set: {
            state: 'FAILED',
            safeErrorCode: 'WORKER_LEASE_EXPIRED',
            finishedAt: now,
          },
          $unset: {
            leaseOwner: 1,
            leaseExpiresAt: 1,
          },
        },
      );

      const reclaimable = await jobsModel
        .find({
          schemaVersion: 2,
          $or: [
            { state: 'PENDING' },
            {
              state: 'RUNNING',
              leaseExpiresAt: { $lte: now },
              attempt: { $lt: HandoverAiService.MAX_AUTO_RECOVERY_ATTEMPTS },
            },
          ],
        })
        .sort({ createdAt: 1 })
        .limit(20)
        .select({ _id: 1 })
        .lean<Array<{ _id: Types.ObjectId }>>()
        .exec();

      for (const row of reclaimable) {
        if (!this.activeJobIds.has(row._id.toHexString())) {
          this.scheduleBackgroundJob(row._id);
        }
      }
    } catch (err) {
      if (err instanceof ServiceUnavailableException) {
        return;
      }
      this.logger.warn(
        `Handover AI job recovery sweep failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private toJobDto(job: StoredJobDoc): JobDto {
    return {
      id: job._id.toHexString(),
      handoverId: job.handoverId.toHexString(),
      kind: job.kind,
      state: job.state,
      inputDraftVersion: job.inputDraftVersion,
      safeErrorCode: job.safeErrorCode ?? null,
      createdAt: job.createdAt.toISOString(),
    };
  }

  private buildSagScopeHeaders(
    actorUserId: string,
    organizationId: string,
    projectId: string,
  ): Record<string, string> {
    return {
      'X-Continuum-User-Id': actorUserId,
      'X-Continuum-Organization-Id': organizationId,
      'X-Continuum-Tenant-Id': organizationId,
      'X-Continuum-Project-Id': projectId,
      'X-Continuum-Security-Partition': projectId,
    };
  }

  async proposeSources(input: {
    actor: HandoverProjectActorContext;
    handover: StoredHandoverDoc;
    expectedVersion: number;
    idempotencyKey: string;
    dto: SourceJobRequestDto;
  }): Promise<{ job: JobDto; version: number; replayed: boolean }> {
    const namespace = `handover:${input.handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'proposeHandoverSources',
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
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED' &&
      existingOp?.receipt?.jobId
    ) {
      const existingJob = await this.repository.jobs
        .findOne({
          _id: existingOp.receipt.jobId,
          handoverId: input.handover._id,
        })
        .lean<StoredJobDoc>()
        .exec();
      if (!existingJob) {
        throw new NotFoundException({
          code: 'JOB_NOT_FOUND',
          message: 'Handover job not found.',
          details: {},
        });
      }
      return {
        job: this.toJobDto(existingJob),
        version: existingOp.receipt.resourceVersion ?? input.handover.version,
        replayed: true,
      };
    }

    if (input.handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Cannot start source discovery on a closed handover.',
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
    if (input.handover.draftVersion !== input.dto.expectedDraftVersion) {
      throw new ConflictException({
        code: 'DRAFT_VERSION_CONFLICT',
        message: 'expectedDraftVersion does not match current draftVersion.',
        details: {},
      });
    }

    const sourceFp = computeSourceSelectionFingerprint(
      input.handover.selectedSources,
    );

    const committed = await this.repository.withTransaction(async (session) => {
      const nextVersion = input.expectedVersion + 1;
      const upd = await this.repository.handovers.updateOne(
        {
          _id: input.handover._id,
          status: 'OPEN',
          version: input.expectedVersion,
        },
        { $set: { version: nextVersion } },
        { session },
      );
      if (upd.matchedCount !== 1) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          message: 'Concurrent handover version update detected.',
          details: {},
        });
      }

      const jobId = new Types.ObjectId();
      const commandId = new Types.ObjectId();
      const [createdJob] = await this.repository.jobs.create(
        [
          {
            _id: jobId,
            schemaVersion: 2,
            organizationId: input.handover.organizationId,
            projectId: input.handover.projectId,
            handoverId: input.handover._id,
            initiatedBy: input.actor.userId,
            commandId,
            kind: 'SOURCE_PROPOSAL',
            state: 'PENDING',
            inputDraftVersion: input.handover.draftVersion,
            query: input.dto.query,
            sourceFingerprint: sourceFp,
            selectedSources: input.handover.selectedSources,
            attempt: 1,
          },
        ],
        { session },
      );

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
            resourceVersion: nextVersion,
            jobId,
            outcome: 'ACCEPTED',
          },
        },
        session,
      );

      await this.repository.appendAuditAndOutbox(
        {
          organizationId: input.actor.organizationId,
          projectId: input.actor.projectId,
          actorUserId: input.actor.userId,
          action: 'handover.source_proposal.queued',
          targetResource: 'handover_job',
          targetResourceId: jobId.toHexString(),
          metadata: {
            handoverId: input.handover._id.toHexString(),
            version: nextVersion,
          },
        },
        {
          eventName: 'handover.job.queued',
          aggregateType: 'handover',
          aggregateId: input.handover._id.toHexString(),
          payload: {
            jobId: jobId.toHexString(),
            kind: 'SOURCE_PROPOSAL',
          },
        },
        session,
      );

      return {
        job: createdJob.toObject(),
        version: nextVersion,
      };
    });

    this.scheduleBackgroundJob(committed.job._id);

    return {
      job: this.toJobDto(committed.job),
      version: committed.version,
      replayed: false,
    };
  }

  async generateDraft(input: {
    actor: HandoverProjectActorContext;
    handover: StoredHandoverDoc;
    expectedVersion: number;
    idempotencyKey: string;
    dto: GenerateRequestDto;
  }): Promise<{ job: JobDto; version: number; replayed: boolean }> {
    const namespace = `handover:${input.handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'generateHandoverDraft',
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
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED' &&
      existingOp?.receipt?.jobId
    ) {
      const existingJob = await this.repository.jobs
        .findOne({
          _id: existingOp.receipt.jobId,
          handoverId: input.handover._id,
        })
        .lean<StoredJobDoc>()
        .exec();
      if (!existingJob) {
        throw new NotFoundException({
          code: 'JOB_NOT_FOUND',
          message: 'Handover job not found.',
          details: {},
        });
      }
      return {
        job: this.toJobDto(existingJob),
        version: existingOp.receipt.resourceVersion ?? input.handover.version,
        replayed: true,
      };
    }

    if (input.handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Cannot generate draft on a closed handover.',
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
    if (input.handover.draftVersion !== input.dto.expectedDraftVersion) {
      throw new ConflictException({
        code: 'DRAFT_VERSION_CONFLICT',
        message: 'expectedDraftVersion does not match current draftVersion.',
        details: {},
      });
    }
    if (input.handover.selectedSources.length === 0) {
      throw new UnprocessableEntityException({
        code: 'NO_SELECTED_SOURCES',
        message:
          'At least one official source must be selected before AI draft generation.',
        details: {},
      });
    }

    const viewer: HandoverSourceViewer = {
      organizationId: input.actor.organizationId,
      projectId: input.actor.projectId,
      userId: input.actor.userId,
      isProjectMember: input.actor.isProjectMember,
      isProjectLeader: input.actor.isProjectLeader,
    };
    const evalMap = await this.sourcesService.evaluateSourceRefsMap(
      viewer,
      input.handover.selectedSources,
    );
    for (const ref of input.handover.selectedSources) {
      const ev = evalMap.get(sourceRefKey(ref));
      if (!ev || !ev.eligible || !ev.readable) {
        throw new UnprocessableEntityException({
          code: 'SELECTED_SOURCE_INELIGIBLE',
          message:
            'One or more selected sources are ineligible or inaccessible.',
          details: { sourceKind: ref.kind, sourceId: ref.id },
        });
      }
    }

    const sourceFp = computeSourceSelectionFingerprint(
      input.handover.selectedSources,
    );

    const committed = await this.repository.withTransaction(async (session) => {
      const nextVersion = input.expectedVersion + 1;
      const upd = await this.repository.handovers.updateOne(
        {
          _id: input.handover._id,
          status: 'OPEN',
          version: input.expectedVersion,
        },
        { $set: { version: nextVersion } },
        { session },
      );
      if (upd.matchedCount !== 1) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          message: 'Concurrent handover version update detected.',
          details: {},
        });
      }

      const jobId = new Types.ObjectId();
      const commandId = new Types.ObjectId();
      const [createdJob] = await this.repository.jobs.create(
        [
          {
            _id: jobId,
            schemaVersion: 2,
            organizationId: input.handover.organizationId,
            projectId: input.handover.projectId,
            handoverId: input.handover._id,
            initiatedBy: input.actor.userId,
            commandId,
            kind: 'GENERATION',
            state: 'PENDING',
            inputDraftVersion: input.handover.draftVersion,
            sourceFingerprint: sourceFp,
            selectedSources: input.handover.selectedSources,
            attempt: 1,
          },
        ],
        { session },
      );

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
            resourceVersion: nextVersion,
            jobId,
            outcome: 'ACCEPTED',
          },
        },
        session,
      );

      await this.repository.appendAuditAndOutbox(
        {
          organizationId: input.actor.organizationId,
          projectId: input.actor.projectId,
          actorUserId: input.actor.userId,
          action: 'handover.draft_generation.queued',
          targetResource: 'handover_job',
          targetResourceId: jobId.toHexString(),
          metadata: {
            handoverId: input.handover._id.toHexString(),
            version: nextVersion,
          },
        },
        {
          eventName: 'handover.job.queued',
          aggregateType: 'handover',
          aggregateId: input.handover._id.toHexString(),
          payload: {
            jobId: jobId.toHexString(),
            kind: 'GENERATION',
          },
        },
        session,
      );

      return {
        job: createdJob.toObject(),
        version: nextVersion,
      };
    });

    this.scheduleBackgroundJob(committed.job._id);

    return {
      job: this.toJobDto(committed.job),
      version: committed.version,
      replayed: false,
    };
  }

  async retryJob(input: {
    actor: HandoverProjectActorContext;
    handover: StoredHandoverDoc;
    jobId: string;
    expectedVersion: number;
    idempotencyKey: string;
    dto: RetryJobDto;
  }): Promise<{ job: JobDto; version: number; replayed: boolean }> {
    const namespace = `handover:${input.handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'retryHandoverJob',
      organizationId: input.actor.organizationId,
      projectId: input.actor.projectId,
      resourceScope: `${namespace}:job:${input.jobId}`,
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
      ) === 'REPLAY_COMMITTED' &&
      existingOp?.receipt?.jobId
    ) {
      const existingJob = await this.repository.jobs
        .findOne({
          _id: existingOp.receipt.jobId,
          handoverId: input.handover._id,
        })
        .lean<StoredJobDoc>()
        .exec();
      if (!existingJob) {
        throw new NotFoundException({
          code: 'JOB_NOT_FOUND',
          message: 'Handover job not found.',
          details: {},
        });
      }
      return {
        job: this.toJobDto(existingJob),
        version: existingOp.receipt.resourceVersion ?? input.handover.version,
        replayed: true,
      };
    }

    const jobObjId = new Types.ObjectId(input.jobId);
    const job = await this.repository.jobs
      .findOne({
        _id: jobObjId,
        handoverId: input.handover._id,
        organizationId: input.handover.organizationId,
        projectId: input.handover.projectId,
      })
      .lean<StoredJobDoc>()
      .exec();

    if (!job) {
      throw new NotFoundException({
        code: 'JOB_NOT_FOUND',
        message: 'Handover job not found.',
        details: {},
      });
    }
    if (input.handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Cannot retry job on a closed handover.',
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
    if (input.handover.draftVersion !== input.dto.expectedDraftVersion) {
      throw new ConflictException({
        code: 'DRAFT_VERSION_CONFLICT',
        message: 'expectedDraftVersion does not match current draftVersion.',
        details: {},
      });
    }
    const retryNow = new Date();
    const isExpiredRunningLease =
      job.state === 'RUNNING' &&
      Boolean(
        job.leaseExpiresAt &&
        job.leaseExpiresAt.getTime() <= retryNow.getTime(),
      );
    if (job.state !== 'FAILED' && !isExpiredRunningLease) {
      throw new ConflictException({
        code: 'JOB_NOT_RETRYABLE',
        message: 'Only FAILED or lease-expired RUNNING jobs can be retried.',
        details: { state: job.state },
      });
    }

    const sourceFp = computeSourceSelectionFingerprint(
      input.handover.selectedSources,
    );

    const committed = await this.repository.withTransaction(async (session) => {
      const nextVersion = input.expectedVersion + 1;
      const updHandover = await this.repository.handovers.updateOne(
        {
          _id: input.handover._id,
          status: 'OPEN',
          version: input.expectedVersion,
        },
        { $set: { version: nextVersion } },
        { session },
      );
      if (updHandover.matchedCount !== 1) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          message: 'Concurrent handover version update detected.',
          details: {},
        });
      }

      const updJob = await this.repository.jobs
        .findOneAndUpdate(
          {
            _id: job._id,
            $or: [
              { state: 'FAILED' },
              { state: 'RUNNING', leaseExpiresAt: { $lte: retryNow } },
            ],
          },
          {
            $set: {
              state: 'PENDING',
              initiatedBy: input.actor.userId,
              inputDraftVersion: input.handover.draftVersion,
              sourceFingerprint: sourceFp,
              selectedSources: input.handover.selectedSources,
            },
            $unset: {
              safeErrorCode: 1,
              finishedAt: 1,
              leaseOwner: 1,
              leaseExpiresAt: 1,
            },
            $inc: { attempt: 1 },
          },
          { new: true, session },
        )
        .lean<StoredJobDoc>()
        .exec();
      if (!updJob) {
        throw new ConflictException({
          code: 'JOB_NOT_RETRYABLE',
          message: 'Job state changed concurrently.',
          details: {},
        });
      }

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
            resourceVersion: nextVersion,
            jobId: job._id,
            outcome: 'RETRIED',
          },
        },
        session,
      );

      await this.repository.appendAuditAndOutbox(
        {
          organizationId: input.actor.organizationId,
          projectId: input.actor.projectId,
          actorUserId: input.actor.userId,
          action: 'handover.job.retried',
          targetResource: 'handover_job',
          targetResourceId: job._id.toHexString(),
          metadata: {
            handoverId: input.handover._id.toHexString(),
            attempt: job.attempt + 1,
          },
        },
        null,
        session,
      );

      return {
        job: updJob,
        version: nextVersion,
      };
    });

    this.scheduleBackgroundJob(committed.job._id);

    return {
      job: this.toJobDto(committed.job),
      version: committed.version,
      replayed: false,
    };
  }

  private async maybeNudgeStalledJob(job: StoredJobDoc): Promise<StoredJobDoc> {
    const now = new Date();
    const isExpiredLease =
      job.state === 'RUNNING' &&
      Boolean(
        job.leaseExpiresAt && job.leaseExpiresAt.getTime() <= now.getTime(),
      );
    if (
      isExpiredLease &&
      job.attempt >= HandoverAiService.MAX_AUTO_RECOVERY_ATTEMPTS
    ) {
      const failed = await this.repository.jobs
        .findOneAndUpdate(
          {
            _id: job._id,
            state: 'RUNNING',
            leaseExpiresAt: { $lte: now },
          },
          {
            $set: {
              state: 'FAILED',
              safeErrorCode: 'WORKER_LEASE_EXPIRED',
              finishedAt: now,
            },
            $unset: {
              leaseOwner: 1,
              leaseExpiresAt: 1,
            },
          },
          { new: true },
        )
        .lean<StoredJobDoc>()
        .exec();
      if (failed) {
        return failed;
      }
    }
    if (
      (job.state === 'PENDING' || isExpiredLease) &&
      !this.activeJobIds.has(job._id.toHexString())
    ) {
      this.scheduleBackgroundJob(job._id);
    }
    return job;
  }

  async getJob(input: {
    handover: StoredHandoverDoc;
    jobId: string;
  }): Promise<JobDto> {
    const job = await this.repository.jobs
      .findOne({
        _id: new Types.ObjectId(input.jobId),
        handoverId: input.handover._id,
        organizationId: input.handover.organizationId,
        projectId: input.handover.projectId,
      })
      .lean<StoredJobDoc>()
      .exec();

    if (!job) {
      throw new NotFoundException({
        code: 'JOB_NOT_FOUND',
        message: 'Handover job not found.',
        details: {},
      });
    }
    const effectiveJob = await this.maybeNudgeStalledJob(job);
    return this.toJobDto(effectiveJob);
  }

  async getCandidates(input: {
    actor: HandoverProjectActorContext;
    handover: StoredHandoverDoc;
    jobId: string;
  }): Promise<SourceCandidatesDto> {
    const rawJob = await this.repository.jobs
      .findOne({
        _id: new Types.ObjectId(input.jobId),
        handoverId: input.handover._id,
        organizationId: input.handover.organizationId,
        projectId: input.handover.projectId,
      })
      .lean<StoredJobDoc>()
      .exec();

    if (!rawJob || rawJob.kind !== 'SOURCE_PROPOSAL') {
      throw new NotFoundException({
        code: 'SOURCE_PROPOSAL_JOB_NOT_FOUND',
        message: 'Source proposal job not found.',
        details: {},
      });
    }

    const job = await this.maybeNudgeStalledJob(rawJob);

    if (job.state !== 'SUCCEEDED' || !job.candidates?.length) {
      return {
        jobId: job._id.toHexString(),
        data: [],
        state: job.state,
      };
    }

    // Reauthorize every candidate under current actor ACL before serving (A03 / A04 / A13)
    const viewer: HandoverSourceViewer = {
      organizationId: input.actor.organizationId,
      projectId: input.actor.projectId,
      userId: input.actor.userId,
      isProjectMember: input.actor.isProjectMember,
      isProjectLeader: input.actor.isProjectLeader,
    };
    const evalMap = await this.sourcesService.evaluateSourceRefsMap(
      viewer,
      job.candidates,
    );
    const reasonMap = this.candidateReasonCache.get(job._id.toHexString());

    const data: SourceCandidateDto[] = [];
    for (const cand of job.candidates) {
      if (cand.kind === 'TASK_NOTE') continue;
      const key = sourceRefKey(cand);
      const ev = evalMap.get(key);
      if (!ev || !ev.eligible || !ev.readable || !ev.title) {
        continue;
      }
      data.push({
        source: {
          kind: cand.kind,
          id: cand.id.toLowerCase(),
          version: String(
            parseSourceVersionNumber(cand.version) ?? cand.version,
          ),
        },
        title: ev.title,
        reason:
          reasonMap?.get(key) ??
          'Authorized project knowledge source matching handover query.',
      });
    }

    return {
      jobId: job._id.toHexString(),
      data,
      state: job.state,
    };
  }

  async askQuestion(input: {
    actor: HandoverProjectActorContext;
    handover: StoredHandoverDoc;
    dto: QuestionRequestDto;
  }): Promise<HandoverAnswerDto> {
    if (!this.aiEngine) {
      throw new ServiceUnavailableException({
        code: 'AI_ENGINE_NOT_CONFIGURED',
        message: 'AI Engine is not configured.',
        details: {},
      });
    }

    const caps = resolveHandoverCapabilities({
      actorUserId: input.actor.userId,
      isProjectMember: input.actor.isProjectMember,
      isProjectLeader: input.actor.isProjectLeader,
      handover: input.handover,
      packageAcceptedByCurrentSuccessor: false,
      isFollowUpOwner: false,
    });
    if (!caps.includes('READ')) {
      throw new NotFoundException({
        code: 'HANDOVER_NOT_FOUND',
        message: 'Handover not found.',
        details: {},
      });
    }

    if (
      !input.handover.publishedRevisionId ||
      input.handover.publishedRevisionId.toHexString() !== input.dto.revisionId
    ) {
      throw new ConflictException({
        code: 'STALE_REVISION_REFERENCE',
        message:
          'Questions may only be asked against the current published revision.',
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

    const revision = await this.repository.revisions
      .findOne({
        _id: input.handover.publishedRevisionId,
        handoverId: input.handover._id,
      })
      .lean()
      .exec();
    if (!revision) {
      throw new NotFoundException({
        code: 'REVISION_NOT_FOUND',
        message: 'Published revision not found.',
        details: {},
      });
    }

    // Collect ONLY official sources from the published revision (Task Notes never enter official Q&A)
    const candidateSources = revision.selectedSources.filter(
      (s) => s.kind !== 'TASK_NOTE',
    );
    const viewer: HandoverSourceViewer = {
      organizationId: input.actor.organizationId,
      projectId: input.actor.projectId,
      userId: input.actor.userId,
      isProjectMember: input.actor.isProjectMember,
      isProjectLeader: input.actor.isProjectLeader,
    };

    const evalMap = await this.sourcesService.evaluateSourceRefsMap(
      viewer,
      candidateSources,
    );
    const permittedSources = candidateSources.flatMap((ref) => {
      const ev = evalMap.get(sourceRefKey(ref));
      const verNum = parseSourceVersionNumber(ref.version);
      if (!ev || !ev.eligible || !ev.readable || !verNum || !ev.title) {
        return [];
      }
      return [
        {
          kind: ref.kind,
          id: ref.id.toLowerCase(),
          version: verNum,
          title: ev.title,
          ...(ev.logicalSourceId
            ? { logicalSourceId: ev.logicalSourceId }
            : {}),
          excerpts: ev.excerpts
            .filter((ex) => ex.content.trim().length > 0)
            .slice(0, 25),
        },
      ];
    });

    if (permittedSources.length === 0) {
      return {
        revisionId: revision._id.toHexString(),
        answerStatus: 'INSUFFICIENT_EVIDENCE',
        message:
          'No accessible official sources in the current published handover provide grounded evidence for this question.',
        sections: [],
      };
    }

    const sagRes = await this.aiEngine.request<SagHandoverAssistResponse>({
      path: `/api/v1/projects/${encodeURIComponent(input.actor.projectId)}/handover/assist`,
      method: 'POST',
      headers: this.buildSagScopeHeaders(
        input.actor.userId,
        input.actor.organizationId,
        input.actor.projectId,
      ),
      body: {
        task: 'QUESTION_ANSWER',
        query: input.dto.question,
        maxItems: 10,
        sources: permittedSources,
      },
    });

    const allowedKeys = new Set(
      permittedSources.map((s) => `${s.kind}:${s.id}:${s.version}`),
    );
    // Reauthorize again before returning citations
    const postEvalMap = await this.sourcesService.evaluateSourceRefsMap(
      viewer,
      permittedSources.map((s) => ({
        kind: s.kind,
        id: s.id,
        version: String(s.version),
      })),
    );

    const verifiedSections = (sagRes.body.sections ?? []).flatMap((sec) => {
      const validCitations: CitationDto[] = [];
      for (const cit of sec.citations ?? []) {
        const key = `${cit.source.kind}:${cit.source.id.toLowerCase()}:${cit.source.version}`;
        const postEv = postEvalMap.get(key);
        if (
          !allowedKeys.has(key) ||
          !postEv ||
          !postEv.eligible ||
          !postEv.readable
        ) {
          return [];
        }
        validCitations.push({
          source: {
            kind: cit.source.kind,
            id: cit.source.id.toLowerCase(),
            version: String(cit.source.version),
          },
          locator: {
            kind: cit.locator.kind,
            value: cit.locator.value,
          },
        });
      }
      if (!sec.text?.trim() || validCitations.length === 0) {
        return [];
      }
      return [
        { text: sec.text.trim().slice(0, 10000), citations: validCitations },
      ];
    });

    if (
      sagRes.body.answerStatus !== 'ANSWERED' ||
      verifiedSections.length === 0
    ) {
      return {
        revisionId: revision._id.toHexString(),
        answerStatus: 'INSUFFICIENT_EVIDENCE',
        message:
          (sagRes.body.message && sagRes.body.message.trim()) ||
          'Insufficient grounded evidence in the authorized published handover sources.',
        sections: [],
      };
    }

    return {
      revisionId: revision._id.toHexString(),
      answerStatus: 'ANSWERED',
      message:
        (sagRes.body.message && sagRes.body.message.trim()) ||
        'Answered from authorized published handover sources.',
      sections: verifiedSections.slice(0, 20),
    };
  }

  private scheduleBackgroundJob(jobId: Types.ObjectId): void {
    const jobHex = jobId.toHexString();
    if (this.isDestroyed || this.activeJobIds.has(jobHex)) {
      return;
    }
    this.activeJobIds.add(jobHex);
    const task = new Promise<void>((resolve) => {
      setImmediate(() => {
        if (this.isDestroyed) {
          this.activeJobIds.delete(jobHex);
          resolve();
          return;
        }
        this.runBackgroundJob(jobId)
          .catch((err: unknown) => {
            this.logger.error(
              `Unhandled error in handover AI background job ${jobHex}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          })
          .finally(() => {
            this.activeJobIds.delete(jobHex);
            resolve();
          });
      });
    });
    this.inFlightJobs.add(task);
    void task.finally(() => {
      this.inFlightJobs.delete(task);
    });
  }

  private async claimRunnableJob(
    jobId: Types.ObjectId,
    leaseOwner: string,
  ): Promise<StoredJobDoc | null> {
    const now = new Date();
    const leaseExpiresAt = new Date(
      now.getTime() + HandoverAiService.LEASE_DURATION_MS,
    );

    const pendingClaim = await this.repository.jobs
      .findOneAndUpdate(
        { _id: jobId, state: 'PENDING' },
        {
          $set: {
            state: 'RUNNING',
            leaseOwner,
            leaseExpiresAt,
          },
        },
        { new: true },
      )
      .lean<StoredJobDoc>()
      .exec();
    if (pendingClaim) {
      return pendingClaim;
    }

    const reclaimed = await this.repository.jobs
      .findOneAndUpdate(
        {
          _id: jobId,
          state: 'RUNNING',
          leaseExpiresAt: { $lte: now },
          attempt: { $lt: HandoverAiService.MAX_AUTO_RECOVERY_ATTEMPTS },
        },
        {
          $set: {
            state: 'RUNNING',
            leaseOwner,
            leaseExpiresAt,
          },
          $inc: { attempt: 1 },
          $unset: {
            safeErrorCode: 1,
            finishedAt: 1,
          },
        },
        { new: true },
      )
      .lean<StoredJobDoc>()
      .exec();
    if (reclaimed) {
      return reclaimed;
    }

    await this.repository.jobs.updateOne(
      {
        _id: jobId,
        state: 'RUNNING',
        leaseExpiresAt: { $lte: now },
        attempt: { $gte: HandoverAiService.MAX_AUTO_RECOVERY_ATTEMPTS },
      },
      {
        $set: {
          state: 'FAILED',
          safeErrorCode: 'WORKER_LEASE_EXPIRED',
          finishedAt: now,
        },
        $unset: {
          leaseOwner: 1,
          leaseExpiresAt: 1,
        },
      },
    );
    return null;
  }

  private async runBackgroundJob(jobId: Types.ObjectId): Promise<void> {
    const leaseOwner = `worker:${process.pid}:${randomUUID()}`.slice(0, 100);
    let job: StoredJobDoc | null = null;
    try {
      job = await this.claimRunnableJob(jobId, leaseOwner);
    } catch (claimErr) {
      this.logger.warn(
        `Failed to claim handover AI job ${jobId.toHexString()}: ${
          claimErr instanceof Error ? claimErr.message : String(claimErr)
        }`,
      );
      return;
    }

    if (!job) {
      return;
    }

    const claimedJob = job;

    const markFailed = async (safeErrorCode: string) => {
      try {
        await this.repository.jobs.updateOne(
          { _id: claimedJob._id, state: 'RUNNING', leaseOwner },
          {
            $set: {
              state: 'FAILED',
              safeErrorCode: safeErrorCode.slice(0, 100),
              finishedAt: new Date(),
            },
            $unset: {
              leaseOwner: 1,
              leaseExpiresAt: 1,
            },
          },
        );
      } catch (writeErr) {
        this.logger.warn(
          `Failed to persist FAILED state on job ${claimedJob._id.toHexString()}: ${
            writeErr instanceof Error ? writeErr.message : String(writeErr)
          }`,
        );
      }
    };

    const markSuperseded = async (safeErrorCode: string) => {
      try {
        await this.repository.jobs.updateOne(
          { _id: claimedJob._id, state: 'RUNNING', leaseOwner },
          {
            $set: {
              state: 'SUPERSEDED',
              safeErrorCode: safeErrorCode.slice(0, 100),
              finishedAt: new Date(),
            },
            $unset: {
              leaseOwner: 1,
              leaseExpiresAt: 1,
            },
          },
        );
      } catch (writeErr) {
        this.logger.warn(
          `Failed to persist SUPERSEDED state on job ${claimedJob._id.toHexString()}: ${
            writeErr instanceof Error ? writeErr.message : String(writeErr)
          }`,
        );
      }
    };

    try {
      if (!this.aiEngine) {
        await markFailed('AI_ENGINE_NOT_CONFIGURED');
        return;
      }

      const orgIdStr = claimedJob.organizationId.toHexString();
      const projectIdStr = claimedJob.projectId.toHexString();

      // Re-verify initiator is still an eligible active Project Leader in IAM
      try {
        await this.iamScope.assertEligibleCoordinator(
          orgIdStr,
          projectIdStr,
          claimedJob.initiatedBy,
        );
      } catch (err) {
        if (err instanceof ForbiddenException || err instanceof HttpException) {
          await markFailed('INITIATOR_AUTHORITY_REVOKED');
          return;
        }
        throw err;
      }

      const handover = await this.repository.handovers
        .findOne({ _id: claimedJob.handoverId })
        .lean<StoredHandoverDoc>()
        .exec();
      if (!handover || handover.status !== 'OPEN') {
        await markSuperseded('HANDOVER_CLOSED');
        return;
      }

      const viewer: HandoverSourceViewer = {
        organizationId: orgIdStr,
        projectId: projectIdStr,
        userId: claimedJob.initiatedBy,
        isProjectMember: true,
        isProjectLeader: true,
      };

      if (claimedJob.kind === 'SOURCE_PROPOSAL') {
        const discovered = await this.sourcesService.discoverOfficialCandidates(
          viewer,
          handover.departingUserId,
          claimedJob.query ?? '',
          30,
        );
        if (discovered.length === 0) {
          await this.repository.jobs.updateOne(
            { _id: claimedJob._id, state: 'RUNNING', leaseOwner },
            {
              $set: {
                state: 'SUCCEEDED',
                candidates: [],
                finishedAt: new Date(),
              },
              $unset: {
                leaseOwner: 1,
                leaseExpiresAt: 1,
              },
            },
          );
          return;
        }

        const sagSources = discovered.map((d) => ({
          kind: d.kind,
          id: d.id.toLowerCase(),
          version: d.version,
          title: d.title,
          ...(d.logicalSourceId ? { logicalSourceId: d.logicalSourceId } : {}),
          excerpts: d.excerpts
            .filter((ex) => ex.content.trim().length > 0)
            .slice(0, 10),
        }));

        const sagRes = await this.aiEngine.request<SagHandoverAssistResponse>({
          path: `/api/v1/projects/${encodeURIComponent(projectIdStr)}/handover/assist`,
          method: 'POST',
          headers: this.buildSagScopeHeaders(
            claimedJob.initiatedBy,
            orgIdStr,
            projectIdStr,
          ),
          body: {
            task: 'SOURCE_PROPOSAL',
            query: claimedJob.query ?? '',
            maxItems: 20,
            sources: sagSources,
          },
        });

        try {
          await this.iamScope.assertEligibleCoordinator(
            orgIdStr,
            projectIdStr,
            claimedJob.initiatedBy,
          );
        } catch (err) {
          if (
            err instanceof ForbiddenException ||
            err instanceof HttpException
          ) {
            await markFailed('INITIATOR_AUTHORITY_REVOKED');
            return;
          }
          throw err;
        }

        const freshHandover = await this.repository.handovers
          .findOne({ _id: claimedJob.handoverId })
          .lean<StoredHandoverDoc>()
          .exec();
        if (!freshHandover || freshHandover.status !== 'OPEN') {
          await markSuperseded('HANDOVER_CLOSED');
          return;
        }

        const allowedDiscovered = new Map(
          discovered.map((d) => [
            `${d.kind}:${d.id.toLowerCase()}:${d.version}`,
            d,
          ]),
        );

        const reasonMap = new Map<string, string>();
        const verifiedCandidates: SourceRefDto[] = [];
        for (const cand of sagRes.body.candidates ?? []) {
          if (cand.source.kind === 'TASK_NOTE') continue;
          const key = `${cand.source.kind}:${cand.source.id.toLowerCase()}:${cand.source.version}`;
          if (!allowedDiscovered.has(key)) continue;
          const ref: SourceRefDto = {
            kind: cand.source.kind,
            id: cand.source.id.toLowerCase(),
            version: String(cand.source.version),
          };
          if (!reasonMap.has(key)) {
            reasonMap.set(key, cand.reason);
            verifiedCandidates.push(ref);
          }
        }

        // Candidate proposals NEVER mutate selectedSources or draft items automatically (A03)
        const propUpd = await this.repository.jobs.updateOne(
          { _id: claimedJob._id, state: 'RUNNING', leaseOwner },
          {
            $set: {
              state: 'SUCCEEDED',
              candidates: verifiedCandidates,
              finishedAt: new Date(),
            },
            $unset: {
              leaseOwner: 1,
              leaseExpiresAt: 1,
            },
          },
        );
        if (propUpd.matchedCount === 1) {
          this.setCandidateReasons(claimedJob._id.toHexString(), reasonMap);
        }
        return;
      }

      // GENERATION job
      const evalMap = await this.sourcesService.evaluateSourceRefsMap(
        viewer,
        claimedJob.selectedSources,
      );
      const sagGenSources = [];
      for (const ref of claimedJob.selectedSources) {
        const ev = evalMap.get(sourceRefKey(ref));
        const verNum = parseSourceVersionNumber(ref.version);
        if (!ev || !ev.eligible || !ev.readable || !verNum || !ev.title) {
          await markFailed('SELECTED_SOURCE_UNAVAILABLE');
          return;
        }
        sagGenSources.push({
          kind: ref.kind,
          id: ref.id.toLowerCase(),
          version: verNum,
          title: ev.title,
          ...(ev.logicalSourceId
            ? { logicalSourceId: ev.logicalSourceId }
            : {}),
          excerpts: ev.excerpts
            .filter((ex) => ex.content.trim().length > 0)
            .slice(0, 25),
        });
      }

      const sagRes = await this.aiEngine.request<SagHandoverAssistResponse>({
        path: `/api/v1/projects/${encodeURIComponent(projectIdStr)}/handover/assist`,
        method: 'POST',
        headers: this.buildSagScopeHeaders(
          claimedJob.initiatedBy,
          orgIdStr,
          projectIdStr,
        ),
        body: {
          task: 'DRAFT_GENERATION',
          maxItems: 20,
          sources: sagGenSources,
        },
      });

      const allowedGenKeys = new Set(
        sagGenSources.map((s) => `${s.kind}:${s.id}:${s.version}`),
      );
      const generatedSnapshots: StoredHandoverItemSnapshot[] = [];
      for (const rawItem of sagRes.body.items ?? []) {
        const itemSources: SourceRefDto[] = [];
        const seenSrc = new Set<string>();
        for (const s of rawItem.sources ?? []) {
          const k = `${s.kind}:${s.id.toLowerCase()}:${s.version}`;
          if (!allowedGenKeys.has(k) || seenSrc.has(k)) continue;
          seenSrc.add(k);
          itemSources.push({
            kind: s.kind,
            id: s.id.toLowerCase(),
            version: String(s.version),
          });
        }

        const itemCitations: CitationDto[] = [];
        const seenCit = new Set<string>();
        for (const c of rawItem.citations ?? []) {
          const k = `${c.source.kind}:${c.source.id.toLowerCase()}:${c.source.version}`;
          const ck = `${k}:${c.locator.kind}:${c.locator.value}`;
          if (!allowedGenKeys.has(k) || seenCit.has(ck)) continue;
          seenCit.add(ck);
          if (!seenSrc.has(k)) {
            seenSrc.add(k);
            itemSources.push({
              kind: c.source.kind,
              id: c.source.id.toLowerCase(),
              version: String(c.source.version),
            });
          }
          itemCitations.push({
            source: {
              kind: c.source.kind,
              id: c.source.id.toLowerCase(),
              version: String(c.source.version),
            },
            locator: {
              kind: c.locator.kind,
              value: c.locator.value,
            },
          });
        }

        if (
          !rawItem.title?.trim() ||
          !rawItem.body?.trim() ||
          itemCitations.length === 0
        ) {
          continue;
        }

        const isRequired = false;
        const evidenceRequired = false;
        generatedSnapshots.push({
          itemId: new Types.ObjectId(),
          contentVersion: 1,
          dependencyFingerprint: computeDependencyFingerprint({
            sources: itemSources,
            citations: itemCitations,
            isRequired,
            evidenceRequired,
          }),
          title: rawItem.title.trim().slice(0, 255),
          body: rawItem.body.trim().slice(0, 20000),
          requirement:
            rawItem.requirement?.trim().slice(0, 2000) ||
            'Review grounded summary and confirm understanding.',
          isRequired,
          evidenceRequired,
          sources: itemSources,
          citations: itemCitations,
        });
      }

      if (generatedSnapshots.length === 0) {
        await markFailed('AI_EMPTY_GROUNDED_OUTPUT');
        return;
      }

      // Re-verify initiator authority & CAS apply against inputDraftVersion + sourceFingerprint (A12)
      try {
        await this.iamScope.assertEligibleCoordinator(
          orgIdStr,
          projectIdStr,
          claimedJob.initiatedBy,
        );
      } catch (err) {
        if (err instanceof ForbiddenException || err instanceof HttpException) {
          await markFailed('INITIATOR_AUTHORITY_REVOKED');
          return;
        }
        throw err;
      }

      await this.repository.withTransaction(async (session) => {
        const freshJob = await this.repository.jobs
          .findOne({ _id: claimedJob._id, state: 'RUNNING', leaseOwner })
          .session(session)
          .lean<StoredJobDoc>()
          .exec();
        if (!freshJob) {
          // Lease was reclaimed by another worker; abort cleanly without touching draft!
          return;
        }

        const freshHandover = await this.repository.handovers
          .findOne({ _id: claimedJob.handoverId })
          .session(session)
          .lean<StoredHandoverDoc>()
          .exec();

        if (!freshHandover || freshHandover.status !== 'OPEN') {
          await this.repository.jobs.updateOne(
            { _id: claimedJob._id, state: 'RUNNING', leaseOwner },
            {
              $set: {
                state: 'SUPERSEDED',
                safeErrorCode: 'HANDOVER_CLOSED',
                finishedAt: new Date(),
              },
              $unset: {
                leaseOwner: 1,
                leaseExpiresAt: 1,
              },
            },
            { session },
          );
          return;
        }

        const currentSourceFp = computeSourceSelectionFingerprint(
          freshHandover.selectedSources,
        );
        if (
          freshHandover.draftVersion !== claimedJob.inputDraftVersion ||
          currentSourceFp !== claimedJob.sourceFingerprint
        ) {
          // Stale generation MUST NOT overwrite newer human/AI draft (Scenario A12)
          await this.repository.jobs.updateOne(
            { _id: claimedJob._id, state: 'RUNNING', leaseOwner },
            {
              $set: {
                state: 'SUPERSEDED',
                safeErrorCode: 'DRAFT_SUPERSEDED',
                finishedAt: new Date(),
              },
              $unset: {
                leaseOwner: 1,
                leaseExpiresAt: 1,
              },
            },
            { session },
          );
          return;
        }

        const nextDraftVersion = freshHandover.draftVersion + 1;
        const nextAggregateVersion = freshHandover.version + 1;

        const jobUpd = await this.repository.jobs.updateOne(
          { _id: claimedJob._id, state: 'RUNNING', leaseOwner },
          {
            $set: {
              state: 'SUCCEEDED',
              resultItems: generatedSnapshots,
              appliedDraftVersion: nextDraftVersion,
              finishedAt: new Date(),
            },
            $unset: {
              leaseOwner: 1,
              leaseExpiresAt: 1,
            },
          },
          { session },
        );
        if (jobUpd.matchedCount !== 1) {
          return;
        }

        const upd = await this.repository.handovers.updateOne(
          {
            _id: freshHandover._id,
            status: 'OPEN',
            version: freshHandover.version,
            draftVersion: claimedJob.inputDraftVersion,
          },
          {
            $set: {
              version: nextAggregateVersion,
              draftVersion: nextDraftVersion,
            },
          },
          { session },
        );

        if (upd.matchedCount !== 1) {
          await this.repository.jobs.updateOne(
            { _id: claimedJob._id },
            {
              $set: {
                state: 'SUPERSEDED',
                safeErrorCode: 'DRAFT_SUPERSEDED',
                finishedAt: new Date(),
              },
              $unset: {
                resultItems: 1,
                appliedDraftVersion: 1,
                leaseOwner: 1,
                leaseExpiresAt: 1,
              },
            },
            { session },
          );
          return;
        }

        await this.repository.draftItems.deleteMany(
          { handoverId: freshHandover._id, schemaVersion: 2 },
          { session },
        );

        await this.repository.draftItems.create(
          generatedSnapshots.map((snap) => ({
            ...snap,
            schemaVersion: 2 as const,
            organizationId: freshHandover.organizationId,
            projectId: freshHandover.projectId,
            handoverId: freshHandover._id,
            updatedBy: claimedJob.initiatedBy,
          })),
          { session, ordered: true },
        );

        await this.repository.appendAuditAndOutbox(
          {
            organizationId: orgIdStr,
            projectId: projectIdStr,
            actorUserId: claimedJob.initiatedBy,
            action: 'handover.draft_generation.succeeded',
            targetResource: 'handover',
            targetResourceId: freshHandover._id.toHexString(),
            metadata: {
              jobId: claimedJob._id.toHexString(),
              appliedDraftVersion: nextDraftVersion,
              itemCount: generatedSnapshots.length,
            },
          },
          null,
          session,
        );
      });
    } catch (err) {
      if (err instanceof ServiceUnavailableException) {
        await markFailed('AI_ENGINE_UNAVAILABLE');
        return;
      }
      if (err instanceof BadGatewayException || err instanceof HttpException) {
        await markFailed('AI_ENGINE_REQUEST_FAILED');
        return;
      }
      await markFailed('AI_JOB_INTERNAL_ERROR');
    }
  }
}
