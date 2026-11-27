import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type {
  EvaluatedHandoverSource,
  HandoverSourceViewer,
} from '../../capture/application/handover-capture-source.service';
import {
  HandoverIamScopeService,
  type HandoverProjectActorContext,
} from '../../iam/application/projects/handover-iam-scope.service';
import { HandoverTaskAssignmentService } from '../../task/workspace/handover-task-assignment.service';
import { RedisService } from '../infrastructure/redis/redis.service';
import { HandoverAiService } from './handover-ai.service';
import {
  collectItemDependencyRefs,
  computeCommandFingerprint,
  computeDependencyFingerprint,
  computeSourceSelectionFingerprint,
  evaluateCarriedItemAcceptances,
  evaluateCompletionReadiness,
  hasMeaningfulDraftItemChange,
  hasUnresolvedTaskTransferFence,
  parseSourceVersionNumber,
  projectRevisionItemForViewer,
  resolveHandoverCapabilities,
  resolveItemBindingState,
  sourceRefKey,
} from './handover.domain';
import { HandoverRepository } from './handover.repository';
import { HandoverSourcesService } from './handover-sources.service';
import { HandoverTransferService } from './handover-transfer.service';
import type {
  CitationDto,
  DepartingMemberPreviewDto,
  DraftItemDto,
  DraftProjectionDto,
  EvidenceReceiptDto,
  FollowUpDto,
  FollowUpListDto,
  HandoverAnswerDto,
  HandoverDetailDto,
  HandoverListDto,
  HandoverParticipantView,
  HandoverRequestHeaders,
  HandoverSummaryDto,
  ItemEvidenceDetailDto,
  JobDto,
  ReceiptDto,
  RevisionProjectionDto,
  SourceCandidatesDto,
  SourceRefDto,
  StoredAcceptanceDoc,
  StoredDraftItemDoc,
  StoredEvidenceDoc,
  StoredEvidenceReviewDoc,
  StoredFollowUpDoc,
  StoredHandoverDoc,
  StoredHandoverItemSnapshot,
  StoredHandoverTaskRef,
  StoredOperationDoc,
  StoredRevisionDoc,
  TransferDto,
} from './handover.types';
import {
  assertHexId,
  formatFollowUpEtag,
  formatHandoverEtag,
  parseListPagination,
  parseRequiredIfMatch,
  validateAcceptRequest,
  validateAcknowledgeRequest,
  validateAutoBundleRequest,
  validateCancelRequest,
  validateCompleteRequest,
  validateCreateHandover,
  validateDraftRequest,
  validateGenerateRequest,
  validateIdempotencyKeyHeader,
  validateOptionalException,
  validatePublishRequest,
  validateQuestionRequest,
  validateQuickAcceptRequest,
  validateQuickTransferRequest,
  validateReconcileTransfer,
  validateResolveFollowUp,
  validateRetryJob,
  validateReviewEvidence,
  validateSetCoordinator,
  validateSetSuccessor,
  validateSourceJobRequest,
  validateStartTransfer,
  validateSubmitEvidence,
  validateUpdateMetadata,
} from './handover.validation';

const LEGACY_AUTO_BUNDLE = 'AUTO_BUNDLED_AND_PUBLISHED';
const SAFE_AUTO_BUNDLE = 'AUTO_BUNDLE_SAFE_V2';

type HandoverRateLimitBucket = 'read' | 'mutate' | 'ai' | 'preview';

const HANDOVER_RATE_LIMITS: Record<
  HandoverRateLimitBucket,
  { limit: number; windowSeconds: number }
> = {
  ai: { limit: 15, windowSeconds: 60 },
  preview: { limit: 30, windowSeconds: 60 },
  mutate: { limit: 60, windowSeconds: 60 },
  read: { limit: 180, windowSeconds: 60 },
};

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 11000
  );
}

function isOpenHandoverUniqueDuplicate(err: unknown): boolean {
  if (!isDuplicateKeyError(err)) return false;
  const record = err as {
    message?: unknown;
    keyPattern?: Record<string, unknown>;
  };
  const msg = typeof record.message === 'string' ? record.message : '';
  if (msg.includes('handover_v2_open_unique')) return true;
  if (
    record.keyPattern &&
    Object.prototype.hasOwnProperty.call(record.keyPattern, 'departingUserId')
  ) {
    return true;
  }
  if (
    msg.includes('handover_operation_key_unique') ||
    (record.keyPattern &&
      Object.prototype.hasOwnProperty.call(record.keyPattern, 'key'))
  ) {
    return false;
  }
  return true;
}

function isIdempotencyKeyConflictError(err: unknown): boolean {
  if (!(err instanceof ConflictException)) return false;
  const res = err.getResponse();
  return (
    typeof res === 'object' &&
    res !== null &&
    (res as { code?: unknown }).code === 'IDEMPOTENCY_KEY_CONFLICT'
  );
}

export interface HttpPayloadWithHeaders<TBody> {
  body: TBody;
  etag?: string;
  replayed?: boolean;
}

@Injectable()
export class HandoverWorkflowService {
  constructor(
    private readonly repository: HandoverRepository,
    private readonly iamScope: HandoverIamScopeService,
    private readonly sourcesService: HandoverSourcesService,
    private readonly taskAssignmentService: HandoverTaskAssignmentService,
    private readonly aiService: HandoverAiService,
    private readonly transferService: HandoverTransferService,
    @Optional()
    private readonly redis?: RedisService,
  ) {}

  private async assertRateLimit(
    actor: HandoverProjectActorContext,
    bucket: HandoverRateLimitBucket,
  ): Promise<void> {
    if (!this.redis || typeof this.redis.consumeRateLimit !== 'function') {
      return;
    }
    const cfg = HANDOVER_RATE_LIMITS[bucket];
    let allowed = true;
    try {
      allowed = await this.redis.consumeRateLimit(
        `handover:${bucket}:${actor.organizationId.toLowerCase()}:${actor.userId.toLowerCase()}`,
        cfg.limit,
        cfg.windowSeconds,
      );
    } catch {
      // Do not hard-fail requests on transient Redis connection errors.
      return;
    }
    if (!allowed) {
      throw new HttpException(
        {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many handover requests. Please retry later.',
          details: { bucket, retryAfterSeconds: cfg.windowSeconds },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async evaluateSourceRefsForViewers(
    viewers: readonly HandoverSourceViewer[],
    refs: readonly SourceRefDto[],
  ): Promise<Array<Map<string, EvaluatedHandoverSource>>> {
    if (viewers.length === 0) return [];
    if (refs.length === 0) {
      return viewers.map(() => new Map<string, EvaluatedHandoverSource>());
    }
    if (
      typeof this.sourcesService.evaluateSourceRefsMapForViewers === 'function'
    ) {
      return this.sourcesService.evaluateSourceRefsMapForViewers(viewers, refs);
    }
    const viewerKey = (v: HandoverSourceViewer) =>
      `${v.organizationId.toLowerCase()}:${v.projectId.toLowerCase()}:${v.userId.toLowerCase()}:${v.isProjectMember ? 1 : 0}:${v.isProjectLeader ? 1 : 0}`;
    const unique: HandoverSourceViewer[] = [];
    const indexByKey = new Map<string, number>();
    const mapIdx: number[] = [];
    for (const v of viewers) {
      const k = viewerKey(v);
      let idx = indexByKey.get(k);
      if (idx === undefined) {
        idx = unique.length;
        indexByKey.set(k, idx);
        unique.push(v);
      }
      mapIdx.push(idx);
    }
    const uniqueResults = await Promise.all(
      unique.map((v) => this.sourcesService.evaluateSourceRefsMap(v, refs)),
    );
    return mapIdx.map((idx) => uniqueResults[idx]);
  }

  private async resolveActor(
    projectId: string,
    headers: HandoverRequestHeaders,
    requireCsrf: boolean,
    rateLimitBucket?: HandoverRateLimitBucket,
  ): Promise<HandoverProjectActorContext> {
    if (requireCsrf) {
      this.iamScope.assertValidCsrf(headers.cookie, headers.csrfToken);
    }
    const identity = await this.iamScope.authenticateActor(
      headers.authorization,
      headers.cookie,
    );
    const actor = await this.iamScope.resolveProjectActorContext({
      actor: identity,
      projectId,
      organizationHeader: headers.organizationId,
    });
    await this.assertRateLimit(
      actor,
      rateLimitBucket ?? (requireCsrf ? 'mutate' : 'read'),
    );
    return actor;
  }

  private assertLeaderAuthority(actor: HandoverProjectActorContext): void {
    if (!actor.isProjectMember || !actor.isProjectLeader) {
      throw new ForbiddenException({
        code: 'HANDOVER_FORBIDDEN',
        message:
          'Active Project Leader authority is required for this operation.',
        details: {},
      });
    }
  }

  private async loadHandoverOrNotFound(
    actor: HandoverProjectActorContext,
    handoverId: string,
  ): Promise<StoredHandoverDoc> {
    const cleanId = assertHexId(handoverId, 'handoverId');
    const doc = await this.repository.handovers
      .findOne({
        _id: new Types.ObjectId(cleanId),
        organizationId: new Types.ObjectId(actor.organizationId),
        projectId: new Types.ObjectId(actor.projectId),
        schemaVersion: 2,
      })
      .lean<StoredHandoverDoc>()
      .exec();

    if (!doc) {
      throw new NotFoundException({
        code: 'HANDOVER_NOT_FOUND',
        message: 'Handover not found.',
        details: {},
      });
    }
    return doc;
  }

  private toSummaryDto(doc: StoredHandoverDoc): HandoverSummaryDto {
    const now = Date.now();
    const overdue =
      doc.status === 'OPEN' && doc.targetCompletionDate.getTime() < now;
    return {
      id: doc._id.toHexString(),
      projectId: doc.projectId.toHexString(),
      teamId: null,
      departingUserId: doc.departingUserId,
      assignedLeaderId: doc.assignedLeaderId,
      successorUserId: doc.successorUserId,
      assignmentVersion: Math.max(1, doc.assignmentVersion),
      title: doc.title,
      version: doc.version,
      status: doc.status,
      publishedRevisionId: doc.publishedRevisionId
        ? doc.publishedRevisionId.toHexString()
        : null,
      draftVersion: doc.draftVersion,
      targetCompletionDate: doc.targetCompletionDate.toISOString(),
      overdue,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  }

  private async assertFollowUpReadable(
    actor: HandoverProjectActorContext,
    doc: Pick<StoredFollowUpDoc, 'handoverId' | 'revisionId' | 'itemId'>,
  ): Promise<void> {
    // Follow-ups outlive the current revision and even parent completion.
    // Resolve the originating snapshot, then apply today's source ACL.
    const scope = {
      organizationId: new Types.ObjectId(actor.organizationId),
      projectId: new Types.ObjectId(actor.projectId),
    };
    const revision = await this.repository.revisions
      .findOne({ _id: doc.revisionId, handoverId: doc.handoverId, ...scope })
      .lean<StoredRevisionDoc>()
      .exec();
    const item = revision?.items.find((row) => row.itemId.equals(doc.itemId));
    if (item) {
      const refs = await this.guardedItemDependencies(
        doc.handoverId,
        item,
        scope,
      );
      const evaluations = await this.sourcesService.evaluateSourceRefsMap(
        actor,
        refs,
      );
      if (
        refs.every((ref) => {
          const evaluated = evaluations.get(sourceRefKey(ref));
          return evaluated?.eligible && evaluated.readable;
        })
      )
        return;
    }
    throw new ForbiddenException({
      code: 'ITEM_DEPENDENCY_UNAVAILABLE',
      message: 'Item dependencies are restricted or unavailable.',
      details: {},
    });
  }

  private async toFollowUpDto(
    doc: StoredFollowUpDoc,
    actor: HandoverProjectActorContext,
  ): Promise<FollowUpDto> {
    await this.assertFollowUpReadable(actor, doc);
    return {
      id: doc._id.toHexString(),
      handoverId: doc.handoverId.toHexString(),
      revisionId: doc.revisionId.toHexString(),
      itemId: doc.itemId.toHexString(),
      ownerUserId: doc.ownerUserId,
      dueAt: doc.dueAt.toISOString(),
      reason: doc.reason,
      status: doc.status,
      version: doc.version,
      resolvedAt: doc.resolvedAt ? doc.resolvedAt.toISOString() : null,
    };
  }

  private toReceiptDto(input: {
    operationId: string;
    handover: Pick<
      StoredHandoverDoc,
      '_id' | 'version' | 'status' | 'publishedRevisionId'
    >;
    versionOverride?: number;
    revisionIdOverride?: Types.ObjectId | null;
    replayed: boolean;
  }): ReceiptDto {
    const revObj =
      input.revisionIdOverride !== undefined
        ? input.revisionIdOverride
        : input.handover.publishedRevisionId;
    return {
      operationId: input.operationId,
      handoverId: input.handover._id.toHexString(),
      version: input.versionOverride ?? input.handover.version,
      status: input.handover.status,
      revisionId: revObj ? revObj.toHexString() : null,
      replayed: input.replayed,
    };
  }

  private async assertNoTaskTransferFence(
    handover: Pick<StoredHandoverDoc, '_id' | 'organizationId' | 'projectId'>,
  ): Promise<void> {
    const pendingTransfers = await this.repository.operations
      .find({
        handoverId: handover._id,
        organizationId: handover.organizationId,
        projectId: handover.projectId,
        kind: { $in: ['TASK_TRANSFER', 'TASK_TRANSFER_CHILD'] },
        state: { $in: ['PENDING', 'DISPATCHED', 'UNKNOWN'] },
      })
      .select({ kind: 1, state: 1 })
      .lean<Array<Pick<StoredOperationDoc, 'kind' | 'state'>>>()
      .exec();

    if (hasUnresolvedTaskTransferFence(pendingTransfers)) {
      throw new ConflictException({
        code: 'UNRESOLVED_TASK_TRANSFER_FENCE',
        message:
          'Cannot change recipient, publish revision, complete, or cancel while task transfer operations have unresolved PENDING/UNKNOWN state. Reconcile transfers first.',
        details: {},
      });
    }
  }

  private encodeCursor(id: Types.ObjectId): string {
    return Buffer.from(
      JSON.stringify({ id: id.toHexString() }),
      'utf8',
    ).toString('base64url');
  }

  private decodeCursor(cursor: string): Types.ObjectId {
    try {
      const parsed = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      ) as { id?: unknown };
      if (typeof parsed.id !== 'string' || !/^[a-f0-9]{24}$/.test(parsed.id)) {
        throw new Error('bad cursor');
      }
      return new Types.ObjectId(parsed.id);
    } catch {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Invalid pagination cursor.',
        details: { field: 'cursor' },
      });
    }
  }

  async listHandovers(
    projectId: string,
    query: Record<string, unknown>,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<HandoverListDto>> {
    const actor = await this.resolveActor(projectId, headers, false);
    if (!actor.isProjectMember && !actor.canAdministerCoordinator) {
      throw new ForbiddenException({
        code: 'HANDOVER_FORBIDDEN',
        message: 'Active project membership is required to read handovers.',
        details: {},
      });
    }

    const { participantRole, ...pagination } = query;
    const { cursor, limit } = parseListPagination(pagination);
    if (
      participantRole !== undefined &&
      participantRole !== 'DEPARTING' &&
      participantRole !== 'SUCCESSOR'
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Invalid participantRole.',
        details: { field: 'participantRole' },
      });
    }
    if (participantRole && !actor.isProjectMember) {
      throw new ForbiddenException({
        code: 'HANDOVER_FORBIDDEN',
        message: 'Active project membership is required.',
        details: {},
      });
    }
    const orgObj = new Types.ObjectId(actor.organizationId);
    const projObj = new Types.ObjectId(actor.projectId);

    const mongoFilter: Record<string, unknown> = {
      schemaVersion: 2,
      organizationId: orgObj,
      projectId: projObj,
    };

    if (participantRole) {
      mongoFilter[
        participantRole === 'DEPARTING' ? 'departingUserId' : 'successorUserId'
      ] = actor.userId;
    } else if (!actor.isProjectLeader && !actor.canAdministerCoordinator) {
      const ownedFollowUps = await this.repository.followUps
        .find({
          schemaVersion: 2,
          organizationId: orgObj,
          projectId: projObj,
          ownerUserId: actor.userId,
        })
        .select({ handoverId: 1 })
        .lean<Array<{ handoverId: Types.ObjectId }>>()
        .exec();

      const followUpHandoverIds = ownedFollowUps.map((f) => f.handoverId);
      mongoFilter.$or = [
        { successorUserId: actor.userId },
        { departingUserId: actor.userId },
        ...(followUpHandoverIds.length > 0
          ? [{ _id: { $in: followUpHandoverIds } }]
          : []),
      ];
    }

    if (cursor) {
      const cursorObjId = this.decodeCursor(cursor);
      mongoFilter._id = mongoFilter._id
        ? { $and: [{ _id: mongoFilter._id }, { _id: { $lt: cursorObjId } }] }
        : { $lt: cursorObjId };
    }

    const rows = await this.repository.handovers
      .find(mongoFilter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean<StoredHandoverDoc[]>()
      .exec();

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && pageRows.length > 0
        ? this.encodeCursor(pageRows[pageRows.length - 1]._id)
        : null;

    const headVer = pageRows.reduce((acc, r) => acc + r.version, 1);
    return {
      body: {
        data: pageRows.map((r) => this.toSummaryDto(r)),
        nextCursor,
      },
      etag: formatHandoverEtag(actor.projectId, headVer),
    };
  }

  async createHandover(
    projectId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<ReceiptDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const dto = validateCreateHandover(rawBody);
    this.assertLeaderAuthority(actor);

    const namespace = 'project';
    const fingerprint = computeCommandFingerprint({
      operation: 'createHandover',
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      resourceScope: namespace,
      expectedVersion: null,
      payload: dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      namespace,
      key: idempotencyKey,
    });
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED' &&
      existingOp?.receipt?.resourceId
    ) {
      const existingHandover = await this.repository.handovers
        .findOne({
          _id: existingOp.receipt.resourceId,
          organizationId: new Types.ObjectId(actor.organizationId),
          projectId: new Types.ObjectId(actor.projectId),
          schemaVersion: 2,
        })
        .lean<StoredHandoverDoc>()
        .exec();
      if (!existingHandover) {
        throw new NotFoundException({
          code: 'HANDOVER_NOT_FOUND',
          message: 'Handover not found.',
          details: {},
        });
      }
      const ver = existingOp.receipt.resourceVersion ?? 1;
      return {
        body: this.toReceiptDto({
          operationId: idempotencyKey,
          handover: existingHandover,
          versionOverride: ver,
          revisionIdOverride: null,
          replayed: true,
        }),
        etag: formatHandoverEtag(existingHandover._id.toHexString(), ver),
        replayed: true,
      };
    }

    if (dto.teamId !== null) {
      throw new UnprocessableEntityException({
        code: 'TEAM_SCOPE_UNSUPPORTED',
        message: 'Team-scoped handover creation is gated; pass teamId: null.',
        details: { field: 'teamId' },
      });
    }

    if (
      dto.successorUserId !== null &&
      dto.successorUserId.toLowerCase() === dto.departingUserId.toLowerCase()
    ) {
      throw new UnprocessableEntityException({
        code: 'SUCCESSOR_CANNOT_BE_DEPARTING_USER',
        message:
          'Departing member A cannot be assigned as their own successor B.',
        details: { field: 'successorUserId' },
      });
    }

    await this.iamScope.assertHistoricalDepartingMember(
      actor.organizationId,
      actor.projectId,
      dto.departingUserId,
    );
    await this.iamScope.assertEligibleCoordinator(
      actor.organizationId,
      actor.projectId,
      dto.assignedLeaderId,
    );
    if (dto.successorUserId !== null) {
      await this.iamScope.assertEligibleActiveProjectMember(
        actor.organizationId,
        actor.projectId,
        dto.successorUserId,
        'SUCCESSOR_NOT_ELIGIBLE',
      );
    }

    let created: StoredHandoverDoc;
    try {
      created = await this.repository.withTransaction(async (session) => {
        const handoverId = new Types.ObjectId();
        const [doc] = await this.repository.handovers.create(
          [
            {
              _id: handoverId,
              schemaVersion: 2,
              organizationId: new Types.ObjectId(actor.organizationId),
              projectId: new Types.ObjectId(actor.projectId),
              departingUserId: dto.departingUserId,
              assignedLeaderId: dto.assignedLeaderId,
              successorUserId: dto.successorUserId,
              title: dto.title.trim(),
              targetCompletionDate: new Date(dto.targetCompletionDate),
              status: 'OPEN',
              version: 1,
              draftVersion: 0,
              assignmentVersion: 1,
              publishedRevisionId: null,
              selectedSources: [],
              selectedTasks: [],
              createdBy: actor.userId,
            },
          ],
          { session },
        );

        await this.repository.createOrClaimCommandOperation(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            handoverId,
            actorUserId: actor.userId,
            namespace,
            key: idempotencyKey,
            fingerprint,
            receipt: {
              resourceId: handoverId,
              resourceVersion: 1,
              outcome: 'CREATED',
            },
          },
          session,
        );

        await this.repository.appendAuditAndOutbox(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            actorUserId: actor.userId,
            action: 'handover.created',
            targetResource: 'handover',
            targetResourceId: handoverId.toHexString(),
            metadata: {
              departingUserId: dto.departingUserId,
              assignedLeaderId: dto.assignedLeaderId,
              hasSuccessor: dto.successorUserId !== null,
            },
          },
          {
            eventName: 'handover.created',
            aggregateType: 'handover',
            aggregateId: handoverId.toHexString(),
            payload: {
              projectId: actor.projectId,
              version: 1,
            },
          },
          session,
        );

        return doc.toObject();
      });
    } catch (err: unknown) {
      // BE-DATA-007: Re-read handover_operations outside the aborted transaction
      // so concurrent retries with the same Idempotency-Key replay cleanly instead
      // of being misclassified as OPEN_HANDOVER_ALREADY_EXISTS.
      if (isDuplicateKeyError(err) || isIdempotencyKeyConflictError(err)) {
        const racedOp = await this.repository.findExistingOperation({
          organizationId: actor.organizationId,
          projectId: actor.projectId,
          actorUserId: actor.userId,
          namespace,
          key: idempotencyKey,
        });
        if (racedOp) {
          if (
            this.repository.assertIdempotencyMatchOrReplay(
              racedOp,
              fingerprint,
            ) === 'REPLAY_COMMITTED' &&
            racedOp.receipt?.resourceId
          ) {
            const committedHandover = await this.repository.handovers
              .findOne({
                _id: racedOp.receipt.resourceId,
                organizationId: new Types.ObjectId(actor.organizationId),
                projectId: new Types.ObjectId(actor.projectId),
                schemaVersion: 2,
              })
              .lean<StoredHandoverDoc>()
              .exec();
            if (committedHandover) {
              const ver = racedOp.receipt.resourceVersion ?? 1;
              return {
                body: this.toReceiptDto({
                  operationId: idempotencyKey,
                  handover: committedHandover,
                  versionOverride: ver,
                  revisionIdOverride: null,
                  replayed: true,
                }),
                etag: formatHandoverEtag(
                  committedHandover._id.toHexString(),
                  ver,
                ),
                replayed: true,
              };
            }
          }
        }
        if (isOpenHandoverUniqueDuplicate(err)) {
          throw new ConflictException({
            code: 'OPEN_HANDOVER_ALREADY_EXISTS',
            message:
              'An OPEN handover already exists for this departing member in this project.',
            details: {},
          });
        }
      }
      throw err;
    }

    return {
      body: this.toReceiptDto({
        operationId: idempotencyKey,
        handover: created,
        replayed: false,
      }),
      etag: formatHandoverEtag(created._id.toHexString(), created.version),
    };
  }

  private async bindLegacyBundleDependencies<
    T extends StoredHandoverItemSnapshot,
  >(
    handoverId: Types.ObjectId,
    items: T[],
    scope?: { organizationId: Types.ObjectId; projectId: Types.ObjectId },
  ): Promise<{ items: T[]; unverified: Set<string> }> {
    const unverified = new Set<string>();
    if (!items.length) return { items, unverified };
    const tenantScope = scope
      ? { organizationId: scope.organizationId, projectId: scope.projectId }
      : {};
    const receipts = await this.repository.operations
      .find({
        handoverId,
        ...tenantScope,
        kind: 'COMMAND',
        'receipt.outcome': { $in: [LEGACY_AUTO_BUNDLE, SAFE_AUTO_BUNDLE] },
      })
      .select({ receipt: 1 })
      .lean<StoredOperationDoc[]>()
      .exec();
    const outcomes = new Map(
      receipts.flatMap(({ receipt }) =>
        receipt?.revisionId
          ? [[receipt.revisionId.toHexString(), receipt.outcome] as const]
          : [],
      ),
    );
    const origins = outcomes.size
      ? await this.repository.revisions
          .find({
            handoverId,
            ...tenantScope,
            _id: {
              $in: [...outcomes.keys()].map((id) => new Types.ObjectId(id)),
            },
            'items.itemId': { $in: items.map((item) => item.itemId) },
          })
          .select({ items: 1, selectedSources: 1 })
          .lean<StoredRevisionDoc[]>()
          .exec()
      : [];
    const originByItem = new Map(
      origins.flatMap((revision) =>
        revision.items.map(
          (item) => [item.itemId.toHexString(), revision] as const,
        ),
      ),
    );
    const projected = items.map((item) => {
      const id = item.itemId.toHexString();
      const origin = originByItem.get(id);
      if (!origin) {
        if (
          item.body.includes('Nguồn tài liệu & Tri thức liên quan (') &&
          item.requirement.startsWith('Người tiếp nối (Successor) xác nhận')
        )
          unverified.add(id);
        return item;
      }
      if (outcomes.get(origin._id.toHexString()) !== LEGACY_AUTO_BUNDLE)
        return item;
      const sources = new Map(
        [...item.sources, ...origin.selectedSources].map((ref) => [
          sourceRefKey(ref),
          ref,
        ]),
      );
      return { ...item, sources: [...sources.values()] };
    });
    return { items: projected, unverified };
  }

  private async guardedItemDependencies(
    handoverId: Types.ObjectId,
    item: StoredHandoverItemSnapshot,
    scope?: { organizationId: Types.ObjectId; projectId: Types.ObjectId },
  ): Promise<SourceRefDto[]> {
    const provenance = await this.bindLegacyBundleDependencies(
      handoverId,
      [item],
      scope,
    );
    if (provenance.unverified.size) {
      throw new ForbiddenException({
        code: 'ITEM_DEPENDENCY_UNAVAILABLE',
        message: 'Item dependencies are restricted or unavailable.',
        details: {},
      });
    }
    return collectItemDependencyRefs(provenance.items[0]);
  }

  private async buildRevisionProjectionAndReadiness(input: {
    viewer: HandoverProjectActorContext;
    handover: StoredHandoverDoc;
    revision: StoredRevisionDoc;
    isCurrent: boolean;
    isFollowUpOwner?: boolean;
  }): Promise<{
    projection: RevisionProjectionDto;
    requiredPendingCount: number;
    canComplete: boolean;
    packageAccepted: boolean;
    children: StoredOperationDoc[];
    liveTaskStateMap?: Map<
      string,
      {
        exists: boolean;
        version: number | null;
        assigneeId: string | null;
        status: string | null;
        key?: string | null;
        title?: string | null;
        dueDate?: string | null;
      }
    >;
    viewerSourceMap: Map<string, EvaluatedHandoverSource>;
  }> {
    const scope = {
      organizationId: input.handover.organizationId,
      projectId: input.handover.projectId,
    };
    const [
      acceptances,
      evidences,
      evidenceReviews,
      followUps,
      transfers,
      children,
    ] = await Promise.all([
      this.repository.acceptances
        .find({
          handoverId: input.handover._id,
          revisionId: input.revision._id,
          ...scope,
        })
        .lean<StoredAcceptanceDoc[]>()
        .exec(),
      this.repository.evidences
        .find({
          handoverId: input.handover._id,
          revisionId: input.revision._id,
          ...scope,
        })
        .lean<StoredEvidenceDoc[]>()
        .exec(),
      this.repository.evidenceReviews
        .find({
          handoverId: input.handover._id,
          revisionId: input.revision._id,
          ...scope,
        })
        .lean<StoredEvidenceReviewDoc[]>()
        .exec(),
      this.repository.followUps
        .find({
          schemaVersion: 2,
          handoverId: input.handover._id,
          revisionId: input.revision._id,
          ...scope,
        })
        .lean<StoredFollowUpDoc[]>()
        .exec(),
      this.repository.operations
        .find({
          handoverId: input.handover._id,
          ...scope,
          kind: 'TASK_TRANSFER',
        })
        .lean<StoredOperationDoc[]>()
        .exec(),
      this.repository.operations
        .find({
          handoverId: input.handover._id,
          ...scope,
          kind: 'TASK_TRANSFER_CHILD',
        })
        .lean<StoredOperationDoc[]>()
        .exec(),
    ]);

    const provenance = await this.bindLegacyBundleDependencies(
      input.handover._id,
      input.revision.items,
      scope,
    );
    const guardedRevision = { ...input.revision, items: provenance.items };
    const allItemDeps = guardedRevision.items.flatMap(
      collectItemDependencyRefs,
    );

    const viewerLower = input.viewer.userId.toLowerCase();
    const assignedLeaderLower = input.handover.assignedLeaderId.toLowerCase();
    const successorLower =
      input.handover.successorUserId?.toLowerCase() ?? null;
    const departingLower = input.handover.departingUserId.toLowerCase();

    // SEC-AUTH-010: Full content access is limited to active leader, successor, or departing member.
    // A regular follow-up owner may ONLY inspect the specific item(s) bound to their follow-up.
    const hasFullContentReadAccess =
      input.viewer.isProjectMember &&
      (input.viewer.isProjectLeader ||
        successorLower === viewerLower ||
        departingLower === viewerLower);

    const ownedFollowUpItemIds = new Set(
      followUps
        .filter((f) => f.ownerUserId.toLowerCase() === viewerLower)
        .map((f) => f.itemId.toHexString()),
    );
    const viewerNeedsSourceEval =
      hasFullContentReadAccess ||
      (input.viewer.isProjectMember && ownedFollowUpItemIds.size > 0);

    const viewerCtx: HandoverSourceViewer = {
      organizationId: input.viewer.organizationId,
      projectId: input.viewer.projectId,
      userId: input.viewer.userId,
      isProjectMember: input.viewer.isProjectMember,
      isProjectLeader: input.viewer.isProjectLeader,
    };

    const [leaderScope, successorScope] = await Promise.all([
      assignedLeaderLower === viewerLower
        ? Promise.resolve({
            isProjectMember: input.viewer.isProjectMember,
            isProjectLeader: input.viewer.isProjectLeader,
          })
        : this.iamScope.resolveActiveProjectMemberScope(
            input.viewer.organizationId,
            input.viewer.projectId,
            input.handover.assignedLeaderId,
          ),
      !input.handover.successorUserId
        ? Promise.resolve({ isProjectMember: false, isProjectLeader: false })
        : successorLower === viewerLower
          ? Promise.resolve({
              isProjectMember: input.viewer.isProjectMember,
              isProjectLeader: input.viewer.isProjectLeader,
            })
          : this.iamScope.resolveActiveProjectMemberScope(
              input.viewer.organizationId,
              input.viewer.projectId,
              input.handover.successorUserId,
            ),
    ]);

    const leaderCtx: HandoverSourceViewer = {
      organizationId: input.viewer.organizationId,
      projectId: input.viewer.projectId,
      userId: input.handover.assignedLeaderId,
      isProjectMember: leaderScope.isProjectMember,
      isProjectLeader: leaderScope.isProjectLeader,
    };

    const successorMemberActive = successorScope.isProjectMember;
    const evalRefs = hasFullContentReadAccess
      ? [...allItemDeps, ...input.revision.selectedSources]
      : allItemDeps;

    const batchViewers: HandoverSourceViewer[] = [];
    const viewerBatchIdx = viewerNeedsSourceEval
      ? batchViewers.push(viewerCtx) - 1
      : -1;
    const leaderBatchIdx = batchViewers.push(leaderCtx) - 1;
    const successorBatchIdx =
      input.handover.successorUserId && successorMemberActive
        ? batchViewers.push({
            organizationId: input.viewer.organizationId,
            projectId: input.viewer.projectId,
            userId: input.handover.successorUserId,
            isProjectMember: successorScope.isProjectMember,
            isProjectLeader: successorScope.isProjectLeader,
          }) - 1
        : -1;

    const [sourceMaps, liveTaskStateMap] = await Promise.all([
      this.evaluateSourceRefsForViewers(batchViewers, evalRefs),
      input.isCurrent && input.revision.selectedTasks.length > 0
        ? this.taskAssignmentService.inspectTasksCurrentState(
            input.viewer.organizationId,
            input.viewer.projectId,
            input.revision.selectedTasks.map((t) => t.taskId.toHexString()),
          )
        : Promise.resolve(undefined),
    ]);

    const viewerSourceMap =
      viewerBatchIdx >= 0
        ? (sourceMaps[viewerBatchIdx] ??
          new Map<string, EvaluatedHandoverSource>())
        : new Map<string, EvaluatedHandoverSource>();
    const leaderSourceMap =
      sourceMaps[leaderBatchIdx] ?? new Map<string, EvaluatedHandoverSource>();
    const successorSourceMap =
      successorBatchIdx >= 0
        ? (sourceMaps[successorBatchIdx] ??
          new Map<string, EvaluatedHandoverSource>())
        : new Map<string, EvaluatedHandoverSource>();

    const reviewByItem = new Map(
      input.revision.reviews.map((r) => [r.itemId.toHexString(), r]),
    );

    const projectedItems = guardedRevision.items.map((item) => {
      const itemHex = item.itemId.toHexString();
      const canReadItem =
        hasFullContentReadAccess ||
        (input.viewer.isProjectMember && ownedFollowUpItemIds.has(itemHex));
      if (!canReadItem || provenance.unverified.has(itemHex)) {
        return {
          itemId: itemHex,
          access: 'UNAVAILABLE' as const,
        };
      }
      const bindingState = resolveItemBindingState({
        revisionId: input.revision._id.toHexString(),
        successorUserId: input.handover.successorUserId,
        assignmentVersion: input.handover.assignmentVersion,
        item,
        acceptances,
        evidences,
        evidenceReviews,
        followUps,
      });
      const contentReview =
        reviewByItem.get(itemHex)?.decision ?? 'GAP_REMAINS';
      return projectRevisionItemForViewer({
        item,
        contentReviewDecision: contentReview,
        bindingState,
        viewerSourceMap,
      });
    });

    const readiness = evaluateCompletionReadiness({
      handover: input.handover,
      currentRevision: input.isCurrent ? guardedRevision : null,
      acceptances,
      evidences,
      evidenceReviews,
      followUps,
      transferOperations: transfers,
      transferChildOperations: children,
      leaderSourceMap,
      successorSourceMap,
      liveTaskStateMap,
    });

    return {
      projection: {
        id: input.revision._id.toHexString(),
        handoverId: input.handover._id.toHexString(),
        number: input.revision.number,
        publishedAt: input.revision.publishedAt.toISOString(),
        publishedBy: input.revision.publishedBy,
        items: projectedItems,
        isCurrent: input.isCurrent,
      },
      requiredPendingCount: readiness.requiredPendingCount,
      canComplete:
        successorMemberActive &&
        readiness.canComplete &&
        provenance.unverified.size === 0,
      packageAccepted: readiness.packageAccepted,
      children,
      liveTaskStateMap,
      viewerSourceMap,
    };
  }

  private async getParticipantView(
    actor: HandoverProjectActorContext,
    handover: StoredHandoverDoc,
    revision: StoredRevisionDoc | null,
    packageAccepted: boolean,
    verified: Map<string, 'TRANSFERRED' | 'ALREADY_ASSIGNED'>,
    preloadedLiveTasks?: Map<
      string,
      {
        exists: boolean;
        version: number | null;
        assigneeId: string | null;
        status: string | null;
        key?: string | null;
        title?: string | null;
        dueDate?: string | null;
      }
    >,
    preloadedSourceMap?: Map<string, EvaluatedHandoverSource>,
  ): Promise<HandoverParticipantView | undefined> {
    if (!actor.isProjectMember) return;
    const actorLower = actor.userId.toLowerCase();
    const isSuccessor = handover.successorUserId?.toLowerCase() === actorLower;
    if (!isSuccessor && handover.departingUserId.toLowerCase() !== actorLower) {
      return;
    }
    const role = isSuccessor ? 'SUCCESSOR' : 'DEPARTING';
    if (!revision && isSuccessor) {
      return {
        role,
        packageAccepted,
        canQuickAccept: false,
        tasks: [],
        sources: [],
      };
    }
    const hasAllRevisionSources =
      Boolean(revision && preloadedSourceMap) &&
      revision!.selectedSources.every((ref) =>
        preloadedSourceMap!.has(sourceRefKey(ref)),
      );
    const [departingTasks, sourceMap] = await Promise.all([
      !revision
        ? this.taskAssignmentService.listDepartingMemberTasksForHandover(
            actor.organizationId,
            actor.projectId,
            actor.userId,
          )
        : Promise.resolve([]),
      revision
        ? hasAllRevisionSources
          ? Promise.resolve(preloadedSourceMap!)
          : this.sourcesService.evaluateSourceRefsMap(
              actor,
              revision.selectedSources,
            )
        : Promise.resolve(new Map<string, EvaluatedHandoverSource>()),
    ]);
    const taskIds = isSuccessor
      ? [...verified.keys()]
      : (revision?.selectedTasks.map((task) => task.taskId.toHexString()) ??
        departingTasks.map((task) => task.id));
    const hasAllLiveTasks =
      Boolean(preloadedLiveTasks) &&
      taskIds.every((id) => preloadedLiveTasks!.has(id));
    const [liveTasks, draftSources] = await Promise.all([
      taskIds.length === 0
        ? Promise.resolve(
            new Map<
              string,
              {
                exists: boolean;
                version: number | null;
                assigneeId: string | null;
                status: string | null;
                key?: string | null;
                title?: string | null;
                dueDate?: string | null;
              }
            >(),
          )
        : hasAllLiveTasks
          ? Promise.resolve(preloadedLiveTasks!)
          : this.taskAssignmentService.inspectTasksCurrentState(
              actor.organizationId,
              actor.projectId,
              taskIds,
            ),
      revision
        ? Promise.resolve([])
        : this.sourcesService
            .discoverDepartingMemberFullScope(actor, actor.userId, taskIds)
            .then(({ sources }) =>
              sources.map(({ kind, id, version, title }) => ({
                kind,
                id,
                version,
                title,
              })),
            ),
    ]);
    const tasks: HandoverParticipantView['tasks'] = taskIds.flatMap((id) => {
      const task = liveTasks.get(id);
      const taskAssigneeLower = task?.assigneeId?.toLowerCase() ?? null;
      // SEC-AUTH-010: Enforce current live task read ACL for DEPARTING member as well as SUCCESSOR.
      const departingCanReadTask =
        actor.isProjectMember &&
        (actor.isProjectLeader || taskAssigneeLower === actorLower);
      if (
        !task?.exists ||
        !task.status ||
        !task.title ||
        (isSuccessor && taskAssigneeLower !== actorLower) ||
        (!isSuccessor &&
          (!departingCanReadTask ||
            task.status === 'DONE' ||
            task.status === 'CANCELLED'))
      )
        return [];
      return [
        {
          id,
          key: task.key ?? id.slice(-6).toUpperCase(),
          title: task.title,
          status: task.status,
          dueDate: task.dueDate ?? null,
          disposition:
            (isSuccessor ? verified.get(id) : undefined) ?? 'DEPARTING',
          canAddNote:
            !isSuccessor &&
            handover.status === 'OPEN' &&
            taskAssigneeLower === actorLower,
        },
      ];
    });
    const sources =
      revision?.selectedSources.flatMap((ref) => {
        const source = sourceMap.get(sourceRefKey(ref));
        return source?.eligible && source.readable
          ? [{ ...ref, title: source.title }]
          : [];
      }) ?? draftSources;
    return {
      role,
      tasks,
      sources,
      packageAccepted,
      canQuickAccept: Boolean(
        isSuccessor &&
        revision &&
        handover.status === 'OPEN' &&
        !packageAccepted,
      ),
    };
  }

  async getHandover(
    projectId: string,
    handoverId: string,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<HandoverDetailDto>> {
    const actor = await this.resolveActor(projectId, headers, false);
    const handover = await this.loadHandoverOrNotFound(actor, handoverId);
    const scope = {
      organizationId: handover.organizationId,
      projectId: handover.projectId,
    };

    const ownedFollowUpCount = await this.repository.followUps.countDocuments({
      schemaVersion: 2,
      handoverId: handover._id,
      ...scope,
      ownerUserId: actor.userId,
    });
    const isFollowUpOwner = ownedFollowUpCount > 0;

    const initialCapabilities = resolveHandoverCapabilities({
      actorUserId: actor.userId,
      isProjectMember: actor.isProjectMember,
      isProjectLeader: actor.isProjectLeader,
      canAdministerCoordinator: actor.canAdministerCoordinator,
      handover,
      packageAcceptedByCurrentSuccessor: false,
      isFollowUpOwner,
    });

    if (!initialCapabilities.includes('READ')) {
      throw new NotFoundException({
        code: 'HANDOVER_NOT_FOUND',
        message: 'Handover not found.',
        details: {},
      });
    }

    let currentRevision: StoredRevisionDoc | null = null;
    let publishedRevision: RevisionProjectionDto | null = null;
    let requiredPendingCount = 0;
    let canComplete = false;
    let packageAccepted = false;
    let preloadedChildren: StoredOperationDoc[] | undefined;
    let preloadedLiveTasks:
      | Map<
          string,
          {
            exists: boolean;
            version: number | null;
            assigneeId: string | null;
            status: string | null;
            key?: string | null;
            title?: string | null;
            dueDate?: string | null;
          }
        >
      | undefined;
    let preloadedViewerSources:
      Map<string, EvaluatedHandoverSource> | undefined;

    if (handover.publishedRevisionId) {
      const revDoc = await this.repository.revisions
        .findOne({
          _id: handover.publishedRevisionId,
          handoverId: handover._id,
          ...scope,
        })
        .lean<StoredRevisionDoc>()
        .exec();

      if (revDoc) {
        currentRevision = revDoc;
        const built = await this.buildRevisionProjectionAndReadiness({
          viewer: actor,
          handover,
          revision: revDoc,
          isCurrent: true,
          isFollowUpOwner,
        });
        publishedRevision = built.projection;
        requiredPendingCount = built.requiredPendingCount;
        canComplete = built.canComplete;
        packageAccepted = built.packageAccepted;
        preloadedChildren = built.children;
        preloadedLiveTasks = built.liveTaskStateMap;
        preloadedViewerSources = built.viewerSourceMap;
      }
    }

    const capabilities = resolveHandoverCapabilities({
      actorUserId: actor.userId,
      isProjectMember: actor.isProjectMember,
      isProjectLeader: actor.isProjectLeader,
      canAdministerCoordinator: actor.canAdministerCoordinator,
      handover,
      packageAcceptedByCurrentSuccessor: packageAccepted,
      isFollowUpOwner,
    });

    const verified =
      currentRevision &&
      actor.isProjectMember &&
      (actor.isProjectLeader ||
        actor.userId.toLowerCase() === handover.successorUserId?.toLowerCase())
        ? await this.transferService.verifiedTaskDispositions(
            handover,
            currentRevision,
            preloadedChildren,
            preloadedLiveTasks,
          )
        : new Map<string, 'TRANSFERRED' | 'ALREADY_ASSIGNED'>();
    const participantView = await this.getParticipantView(
      actor,
      handover,
      currentRevision,
      packageAccepted,
      verified,
      preloadedLiveTasks,
      preloadedViewerSources,
    );
    return {
      body: {
        handover: this.toSummaryDto(handover),
        publishedRevision,
        capabilities,
        requiredPendingCount,
        canComplete,
        ...(participantView ? { participantView } : {}),
        ...(actor.isProjectLeader && currentRevision
          ? {
              taskTransfer: {
                selectedCount: currentRevision.selectedTasks.length,
                verifiedCount: verified.size,
              },
            }
          : {}),
      },
      etag: formatHandoverEtag(handover._id.toHexString(), handover.version),
    };
  }

  async getHandoverRevision(
    projectId: string,
    handoverId: string,
    revisionId: string,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<RevisionProjectionDto>> {
    const actor = await this.resolveActor(projectId, headers, false);
    const handover = await this.loadHandoverOrNotFound(actor, handoverId);
    const cleanRevId = assertHexId(revisionId, 'revisionId');

    const ownedFollowUpCount = await this.repository.followUps.countDocuments({
      schemaVersion: 2,
      handoverId: handover._id,
      organizationId: handover.organizationId,
      projectId: handover.projectId,
      ownerUserId: actor.userId,
    });
    const isFollowUpOwner = ownedFollowUpCount > 0;
    const caps = resolveHandoverCapabilities({
      actorUserId: actor.userId,
      isProjectMember: actor.isProjectMember,
      isProjectLeader: actor.isProjectLeader,
      handover,
      packageAcceptedByCurrentSuccessor: false,
      isFollowUpOwner,
    });
    if (!caps.includes('READ')) {
      throw new NotFoundException({
        code: 'HANDOVER_NOT_FOUND',
        message: 'Handover not found.',
        details: {},
      });
    }

    const revDoc = await this.repository.revisions
      .findOne({
        _id: new Types.ObjectId(cleanRevId),
        handoverId: handover._id,
        organizationId: handover.organizationId,
        projectId: handover.projectId,
      })
      .lean<StoredRevisionDoc>()
      .exec();
    if (!revDoc) {
      throw new NotFoundException({
        code: 'REVISION_NOT_FOUND',
        message: 'Handover revision not found.',
        details: {},
      });
    }

    const isCurrent =
      handover.publishedRevisionId?.toHexString() === revDoc._id.toHexString();
    const built = await this.buildRevisionProjectionAndReadiness({
      viewer: actor,
      handover,
      revision: revDoc,
      isCurrent,
      isFollowUpOwner,
    });

    return {
      body: built.projection,
      etag: formatHandoverEtag(handover._id.toHexString(), handover.version),
    };
  }

  async updateHandoverMetadata(
    projectId: string,
    handoverId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<ReceiptDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );
    const dto = validateUpdateMetadata(rawBody);
    this.assertLeaderAuthority(actor);

    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);
    const namespace = `handover:${handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'updateHandoverMetadata',
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      resourceScope: namespace,
      expectedVersion,
      payload: dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      namespace,
      key: idempotencyKey,
    });
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED'
    ) {
      const ver = existingOp?.receipt?.resourceVersion ?? handover.version;
      return {
        body: this.toReceiptDto({
          operationId: idempotencyKey,
          handover,
          versionOverride: ver,
          revisionIdOverride: existingOp?.receipt?.revisionId ?? null,
          replayed: true,
        }),
        etag: formatHandoverEtag(handover._id.toHexString(), ver),
        replayed: true,
      };
    }

    if (handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Metadata can only be updated while handover is OPEN.',
        details: {},
      });
    }
    if (handover.version !== expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Handover aggregate version conflict.',
        details: {},
      });
    }

    const nextVersion = await this.repository.withTransaction(
      async (session) => {
        const nextVer = expectedVersion + 1;
        const setFields: Record<string, unknown> = { version: nextVer };
        if (dto.title !== undefined) setFields.title = dto.title.trim();
        if (dto.targetCompletionDate !== undefined) {
          setFields.targetCompletionDate = new Date(dto.targetCompletionDate);
        }

        const upd = await this.repository.handovers.updateOne(
          {
            _id: handover._id,
            organizationId: handover.organizationId,
            projectId: handover.projectId,
            status: 'OPEN',
            version: expectedVersion,
          },
          { $set: setFields },
          { session },
        );
        if (upd.matchedCount !== 1) {
          throw new ConflictException({
            code: 'VERSION_CONFLICT',
            message: 'Concurrent handover version update detected.',
            details: {},
          });
        }

        await this.repository.createOrClaimCommandOperation(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            handoverId: handover._id,
            actorUserId: actor.userId,
            namespace,
            key: idempotencyKey,
            fingerprint,
            expectedVersion,
            receipt: {
              resourceId: handover._id,
              resourceVersion: nextVer,
              ...(handover.publishedRevisionId
                ? { revisionId: handover.publishedRevisionId }
                : {}),
              outcome: 'UPDATED',
            },
          },
          session,
        );

        await this.repository.appendAuditAndOutbox(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            actorUserId: actor.userId,
            action: 'handover.metadata.updated',
            targetResource: 'handover',
            targetResourceId: handover._id.toHexString(),
            metadata: { version: nextVer },
          },
          null,
          session,
        );
        return nextVer;
      },
    );

    return {
      body: this.toReceiptDto({
        operationId: idempotencyKey,
        handover,
        versionOverride: nextVersion,
        replayed: false,
      }),
      etag: formatHandoverEtag(handover._id.toHexString(), nextVersion),
    };
  }

  async setHandoverSuccessor(
    projectId: string,
    handoverId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<ReceiptDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );
    const dto = validateSetSuccessor(rawBody);
    this.assertLeaderAuthority(actor);

    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);
    const namespace = `handover:${handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'setHandoverSuccessor',
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      resourceScope: namespace,
      expectedVersion,
      payload: dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      namespace,
      key: idempotencyKey,
    });
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED'
    ) {
      const ver = existingOp?.receipt?.resourceVersion ?? handover.version;
      return {
        body: this.toReceiptDto({
          operationId: idempotencyKey,
          handover,
          versionOverride: ver,
          revisionIdOverride: existingOp?.receipt?.revisionId ?? null,
          replayed: true,
        }),
        etag: formatHandoverEtag(handover._id.toHexString(), ver),
        replayed: true,
      };
    }

    if (handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Successor B can only be changed while handover is OPEN.',
        details: {},
      });
    }
    if (handover.version !== expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Handover aggregate version conflict.',
        details: {},
      });
    }
    await this.assertNoTaskTransferFence(handover);

    if (
      dto.successorUserId !== null &&
      dto.successorUserId.toLowerCase() ===
        handover.departingUserId.toLowerCase()
    ) {
      throw new UnprocessableEntityException({
        code: 'SUCCESSOR_CANNOT_BE_DEPARTING_USER',
        message: 'Departing member A cannot be assigned as successor B.',
        details: { field: 'successorUserId' },
      });
    }
    if (dto.successorUserId !== null) {
      await this.iamScope.assertEligibleActiveProjectMember(
        actor.organizationId,
        actor.projectId,
        dto.successorUserId,
        'SUCCESSOR_NOT_ELIGIBLE',
      );
    }

    const nextVersion = await this.repository.withTransaction(
      async (session) => {
        const nextVer = expectedVersion + 1;
        const nextEpoch = handover.assignmentVersion + 1;

        const upd = await this.repository.handovers.updateOne(
          {
            _id: handover._id,
            organizationId: handover.organizationId,
            projectId: handover.projectId,
            status: 'OPEN',
            version: expectedVersion,
          },
          {
            $set: {
              successorUserId: dto.successorUserId,
              assignmentVersion: nextEpoch,
              version: nextVer,
            },
          },
          { session },
        );
        if (upd.matchedCount !== 1) {
          throw new ConflictException({
            code: 'VERSION_CONFLICT',
            message: 'Concurrent handover version update detected.',
            details: {},
          });
        }

        await this.repository.createOrClaimCommandOperation(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            handoverId: handover._id,
            actorUserId: actor.userId,
            namespace,
            key: idempotencyKey,
            fingerprint,
            expectedVersion,
            receipt: {
              resourceId: handover._id,
              resourceVersion: nextVer,
              ...(handover.publishedRevisionId
                ? { revisionId: handover.publishedRevisionId }
                : {}),
              outcome: 'SUCCESSOR_UPDATED',
            },
          },
          session,
        );

        await this.repository.appendAuditAndOutbox(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            actorUserId: actor.userId,
            action: 'handover.successor.updated',
            targetResource: 'handover',
            targetResourceId: handover._id.toHexString(),
            metadata: {
              assignmentVersion: nextEpoch,
              hasSuccessor: dto.successorUserId !== null,
            },
          },
          {
            eventName: 'handover.successor.updated',
            aggregateType: 'handover',
            aggregateId: handover._id.toHexString(),
            payload: {
              version: nextVer,
              assignmentVersion: nextEpoch,
            },
          },
          session,
        );

        return nextVer;
      },
    );

    return {
      body: this.toReceiptDto({
        operationId: idempotencyKey,
        handover,
        versionOverride: nextVersion,
        replayed: false,
      }),
      etag: formatHandoverEtag(handover._id.toHexString(), nextVersion),
    };
  }

  async setHandoverCoordinator(
    projectId: string,
    handoverId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<ReceiptDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );
    const dto = validateSetCoordinator(rawBody);

    if (!actor.canAdministerCoordinator) {
      throw new ForbiddenException({
        code: 'COORDINATOR_ADMINISTRATION_FORBIDDEN',
        message: 'Coordinator appointment authority is required.',
        details: {},
      });
    }

    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);
    const namespace = `handover:${handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'setHandoverCoordinator',
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      resourceScope: namespace,
      expectedVersion,
      payload: dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      namespace,
      key: idempotencyKey,
    });
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED'
    ) {
      const ver = existingOp?.receipt?.resourceVersion ?? handover.version;
      return {
        body: this.toReceiptDto({
          operationId: idempotencyKey,
          handover,
          versionOverride: ver,
          revisionIdOverride: existingOp?.receipt?.revisionId ?? null,
          replayed: true,
        }),
        etag: formatHandoverEtag(handover._id.toHexString(), ver),
        replayed: true,
      };
    }

    if (handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Coordinator D can only be changed while handover is OPEN.',
        details: {},
      });
    }
    if (handover.version !== expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Handover aggregate version conflict.',
        details: {},
      });
    }

    // Coordinator D MUST already be an active Project Leader in IAM (Scenario A02)
    await this.iamScope.assertEligibleCoordinator(
      actor.organizationId,
      actor.projectId,
      dto.assignedLeaderId,
    );

    const nextVersion = await this.repository.withTransaction(
      async (session) => {
        const nextVer = expectedVersion + 1;
        const upd = await this.repository.handovers.updateOne(
          {
            _id: handover._id,
            organizationId: handover.organizationId,
            projectId: handover.projectId,
            status: 'OPEN',
            version: expectedVersion,
          },
          {
            $set: {
              assignedLeaderId: dto.assignedLeaderId,
              version: nextVer,
            },
          },
          { session },
        );
        if (upd.matchedCount !== 1) {
          throw new ConflictException({
            code: 'VERSION_CONFLICT',
            message: 'Concurrent handover version update detected.',
            details: {},
          });
        }

        await this.repository.createOrClaimCommandOperation(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            handoverId: handover._id,
            actorUserId: actor.userId,
            namespace,
            key: idempotencyKey,
            fingerprint,
            expectedVersion,
            receipt: {
              resourceId: handover._id,
              resourceVersion: nextVer,
              ...(handover.publishedRevisionId
                ? { revisionId: handover.publishedRevisionId }
                : {}),
              outcome: 'COORDINATOR_UPDATED',
            },
          },
          session,
        );

        await this.repository.appendAuditAndOutbox(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            actorUserId: actor.userId,
            action: 'handover.coordinator.updated',
            targetResource: 'handover',
            targetResourceId: handover._id.toHexString(),
            metadata: {
              assignedLeaderId: dto.assignedLeaderId,
              version: nextVer,
            },
          },
          null,
          session,
        );
        return nextVer;
      },
    );

    return {
      body: this.toReceiptDto({
        operationId: idempotencyKey,
        handover,
        versionOverride: nextVersion,
        replayed: false,
      }),
      etag: formatHandoverEtag(handover._id.toHexString(), nextVersion),
    };
  }

  async getHandoverDraft(
    projectId: string,
    handoverId: string,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<DraftProjectionDto>> {
    const actor = await this.resolveActor(projectId, headers, false);
    const handover = await this.loadHandoverOrNotFound(actor, handoverId);
    this.assertLeaderAuthority(actor);

    const scope = {
      organizationId: handover.organizationId,
      projectId: handover.projectId,
    };
    const draftDocs = await this.repository.draftItems
      .find({ handoverId: handover._id, ...scope, schemaVersion: 2 })
      .sort({ _id: 1 })
      .lean<StoredDraftItemDoc[]>()
      .exec();

    const provenance = await this.bindLegacyBundleDependencies(
      handover._id,
      draftDocs,
      scope,
    );
    const allSources = [
      ...handover.selectedSources,
      ...provenance.items.flatMap((d) => collectItemDependencyRefs(d)),
    ];
    const viewer: HandoverSourceViewer = {
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      userId: actor.userId,
      isProjectMember: actor.isProjectMember,
      isProjectLeader: actor.isProjectLeader,
    };
    const evalMap = await this.sourcesService.evaluateSourceRefsMap(
      viewer,
      allSources,
    );

    // Filter out any item or source that the current Leader is not permitted to read
    const visibleItems: DraftItemDto[] = provenance.items
      .filter(
        (d) =>
          !provenance.unverified.has(d.itemId.toHexString()) &&
          collectItemDependencyRefs(d).every((dep) => {
            const ev = evalMap.get(sourceRefKey(dep));
            return Boolean(ev && ev.eligible && ev.readable);
          }),
      )
      .map((d) => ({
        itemId: d.itemId.toHexString(),
        contentVersion: d.contentVersion,
        title: d.title,
        body: d.body,
        isRequired: d.isRequired,
        evidenceRequired: d.evidenceRequired,
        sources: d.sources,
        citations: d.citations,
        requirement: d.requirement,
      }));

    const visibleSources = handover.selectedSources.filter((s) => {
      const ev = evalMap.get(sourceRefKey(s));
      return Boolean(ev && ev.eligible && ev.readable);
    });

    return {
      body: {
        handoverId: handover._id.toHexString(),
        draftVersion: handover.draftVersion,
        items: visibleItems,
        taskIds: handover.selectedTasks.map((t) => t.taskId.toHexString()),
        selectedSources: visibleSources,
      },
      etag: formatHandoverEtag(handover._id.toHexString(), handover.version),
    };
  }

  async replaceHandoverDraft(
    projectId: string,
    handoverId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<ReceiptDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );
    const dto = validateDraftRequest(rawBody);
    this.assertLeaderAuthority(actor);

    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);
    const namespace = `handover:${handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'replaceHandoverDraft',
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      resourceScope: namespace,
      expectedVersion,
      payload: dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      namespace,
      key: idempotencyKey,
    });
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED'
    ) {
      const ver = existingOp?.receipt?.resourceVersion ?? handover.version;
      return {
        body: this.toReceiptDto({
          operationId: idempotencyKey,
          handover,
          versionOverride: ver,
          revisionIdOverride: existingOp?.receipt?.revisionId ?? null,
          replayed: true,
        }),
        etag: formatHandoverEtag(handover._id.toHexString(), ver),
        replayed: true,
      };
    }

    if (handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Cannot edit draft of a closed handover.',
        details: {},
      });
    }
    if (handover.version !== expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Handover aggregate version conflict.',
        details: {},
      });
    }
    if (handover.draftVersion !== dto.expectedDraftVersion) {
      throw new ConflictException({
        code: 'DRAFT_VERSION_CONFLICT',
        message: 'expectedDraftVersion does not match current draftVersion.',
        details: {},
      });
    }

    const selectedKeys = new Set(
      dto.selectedSources.map((s) => sourceRefKey(s)),
    );
    for (const item of dto.items) {
      for (const dep of collectItemDependencyRefs(item)) {
        if (!selectedKeys.has(sourceRefKey(dep))) {
          throw new UnprocessableEntityException({
            code: 'ITEM_SOURCE_NOT_IN_SELECTED_SOURCES',
            message:
              'Every item source and citation source must be included in selectedSources.',
            details: { sourceKind: dep.kind, sourceId: dep.id },
          });
        }
      }
    }

    const viewer: HandoverSourceViewer = {
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      userId: actor.userId,
      isProjectMember: actor.isProjectMember,
      isProjectLeader: actor.isProjectLeader,
    };
    const evalMap = await this.sourcesService.evaluateSourceRefsMap(
      viewer,
      dto.selectedSources,
    );
    const normalizedSelectedSources: SourceRefDto[] = [];
    for (const src of dto.selectedSources) {
      const verNum = parseSourceVersionNumber(src.version);
      const ev = evalMap.get(sourceRefKey(src));
      if (!verNum || !ev || !ev.eligible || !ev.readable) {
        throw new UnprocessableEntityException({
          code: 'SOURCE_NOT_ELIGIBLE',
          message:
            'One or more selected sources are ineligible or inaccessible.',
          details: { sourceKind: src.kind, sourceId: src.id },
        });
      }
      normalizedSelectedSources.push({
        kind: src.kind,
        id: src.id.toLowerCase(),
        version: String(verNum),
      });
    }

    const selectedTasks: StoredHandoverTaskRef[] = [];
    for (const taskId of dto.taskIds) {
      const taskInfo = await this.taskAssignmentService.verifyProjectTaskExists(
        actor.organizationId,
        actor.projectId,
        taskId,
      );
      if (
        !taskInfo.exists ||
        taskInfo.version === null ||
        taskInfo.status === 'CANCELLED'
      ) {
        throw new UnprocessableEntityException({
          code: 'TASK_NOT_ELIGIBLE',
          message:
            'Selected task does not exist in this project or is cancelled.',
          details: { taskId },
        });
      }
      selectedTasks.push({
        taskId: new Types.ObjectId(taskId),
        expectedVersion: taskInfo.version,
        expectedAssigneeId: taskInfo.assigneeId,
      });
    }

    const scope = {
      organizationId: handover.organizationId,
      projectId: handover.projectId,
    };
    const existingDraftDocs = await this.repository.draftItems
      .find({ handoverId: handover._id, ...scope, schemaVersion: 2 })
      .lean<StoredDraftItemDoc[]>()
      .exec();
    const existingById = new Map<string, StoredHandoverItemSnapshot>(
      existingDraftDocs.map((d) => [d.itemId.toHexString(), d]),
    );
    if (handover.publishedRevisionId) {
      const pubRev = await this.repository.revisions
        .findOne({
          _id: handover.publishedRevisionId,
          handoverId: handover._id,
          ...scope,
        })
        .lean<StoredRevisionDoc>()
        .exec();
      for (const pubItem of pubRev?.items ?? []) {
        const hex = pubItem.itemId.toHexString();
        if (!existingById.has(hex)) {
          existingById.set(hex, pubItem);
        }
      }
    }

    const normalizedItems: StoredHandoverItemSnapshot[] = dto.items.map(
      (inputItem) => {
        let itemObjId: Types.ObjectId;
        let contentVersion = 1;
        if (inputItem.itemId !== null) {
          const prev = existingById.get(inputItem.itemId);
          if (!prev) {
            throw new UnprocessableEntityException({
              code: 'UNKNOWN_DRAFT_ITEM_ID',
              message:
                'Non-null itemId must already belong to this handover draft.',
              details: { itemId: inputItem.itemId },
            });
          }
          itemObjId = new Types.ObjectId(inputItem.itemId);
          contentVersion = hasMeaningfulDraftItemChange(prev, {
            ...inputItem,
            title: inputItem.title.trim(),
            requirement: inputItem.requirement.trim(),
          })
            ? prev.contentVersion + 1
            : prev.contentVersion;
        } else {
          itemObjId = new Types.ObjectId();
        }

        const normItemSources = inputItem.sources.map((s) => ({
          kind: s.kind,
          id: s.id.toLowerCase(),
          version: String(parseSourceVersionNumber(s.version) ?? s.version),
        }));
        const normItemCitations = inputItem.citations.map((c) => ({
          source: {
            kind: c.source.kind,
            id: c.source.id.toLowerCase(),
            version: String(
              parseSourceVersionNumber(c.source.version) ?? c.source.version,
            ),
          },
          locator: c.locator,
        }));

        return {
          itemId: itemObjId,
          contentVersion,
          dependencyFingerprint: computeDependencyFingerprint({
            sources: normItemSources,
            citations: normItemCitations,
            isRequired: inputItem.isRequired,
            evidenceRequired: inputItem.evidenceRequired,
          }),
          title: inputItem.title.trim(),
          body: inputItem.body,
          requirement: inputItem.requirement.trim(),
          isRequired: inputItem.isRequired,
          evidenceRequired: inputItem.evidenceRequired,
          sources: normItemSources,
          citations: normItemCitations,
        };
      },
    );

    const nextVersion = await this.repository.withTransaction(
      async (session) => {
        const nextVer = expectedVersion + 1;
        const nextDraftVer = dto.expectedDraftVersion + 1;
        const upd = await this.repository.handovers.updateOne(
          {
            _id: handover._id,
            ...scope,
            status: 'OPEN',
            version: expectedVersion,
            draftVersion: dto.expectedDraftVersion,
          },
          {
            $set: {
              version: nextVer,
              draftVersion: nextDraftVer,
              selectedSources: normalizedSelectedSources,
              selectedTasks,
            },
          },
          { session },
        );
        if (upd.matchedCount !== 1) {
          throw new ConflictException({
            code: 'VERSION_CONFLICT',
            message: 'Concurrent handover draft/version update detected.',
            details: {},
          });
        }

        await this.repository.draftItems.deleteMany(
          { handoverId: handover._id, ...scope, schemaVersion: 2 },
          { session },
        );
        if (normalizedItems.length > 0) {
          await this.repository.draftItems.create(
            normalizedItems.map((snap) => ({
              ...snap,
              schemaVersion: 2 as const,
              organizationId: handover.organizationId,
              projectId: handover.projectId,
              handoverId: handover._id,
              updatedBy: actor.userId,
            })),
            { session, ordered: true },
          );
        }

        await this.repository.createOrClaimCommandOperation(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            handoverId: handover._id,
            actorUserId: actor.userId,
            namespace,
            key: idempotencyKey,
            fingerprint,
            expectedVersion,
            receipt: {
              resourceId: handover._id,
              resourceVersion: nextVer,
              ...(handover.publishedRevisionId
                ? { revisionId: handover.publishedRevisionId }
                : {}),
              outcome: 'DRAFT_REPLACED',
            },
          },
          session,
        );

        await this.repository.appendAuditAndOutbox(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            actorUserId: actor.userId,
            action: 'handover.draft.replaced',
            targetResource: 'handover',
            targetResourceId: handover._id.toHexString(),
            metadata: {
              draftVersion: nextDraftVer,
              itemCount: normalizedItems.length,
            },
          },
          null,
          session,
        );

        return nextVer;
      },
    );

    return {
      body: this.toReceiptDto({
        operationId: idempotencyKey,
        handover,
        versionOverride: nextVersion,
        replayed: false,
      }),
      etag: formatHandoverEtag(handover._id.toHexString(), nextVersion),
    };
  }

  async publishHandoverRevision(
    projectId: string,
    handoverId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<ReceiptDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );
    const dto = validatePublishRequest(rawBody);
    this.assertLeaderAuthority(actor);

    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);
    const namespace = `handover:${handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'publishHandoverRevision',
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      resourceScope: namespace,
      expectedVersion,
      payload: dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      namespace,
      key: idempotencyKey,
    });
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED'
    ) {
      const ver = existingOp?.receipt?.resourceVersion ?? handover.version;
      return {
        body: this.toReceiptDto({
          operationId: idempotencyKey,
          handover,
          versionOverride: ver,
          revisionIdOverride: existingOp?.receipt?.revisionId ?? null,
          replayed: true,
        }),
        etag: formatHandoverEtag(handover._id.toHexString(), ver),
        replayed: true,
      };
    }

    if (handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Cannot publish revision on a closed handover.',
        details: {},
      });
    }
    if (handover.version !== expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Handover aggregate version conflict.',
        details: {},
      });
    }
    if (handover.draftVersion !== dto.expectedDraftVersion) {
      throw new ConflictException({
        code: 'DRAFT_VERSION_CONFLICT',
        message: 'expectedDraftVersion does not match current draftVersion.',
        details: {},
      });
    }
    const scope = {
      organizationId: handover.organizationId,
      projectId: handover.projectId,
    };
    await this.assertNoTaskTransferFence(handover);

    const draftDocs = await this.repository.draftItems
      .find({ handoverId: handover._id, ...scope, schemaVersion: 2 })
      .sort({ _id: 1 })
      .lean<StoredDraftItemDoc[]>()
      .exec();

    if (draftDocs.length === 0) {
      throw new UnprocessableEntityException({
        code: 'EMPTY_DRAFT_CANNOT_PUBLISH',
        message: 'At least one draft item is required to publish a revision.',
        details: {},
      });
    }

    if (dto.itemReviews.length !== draftDocs.length) {
      throw new UnprocessableEntityException({
        code: 'INCOMPLETE_ITEM_REVIEWS',
        message: 'Every draft item must have an explicit PublishReview.',
        details: {},
      });
    }

    const draftById = new Map(
      draftDocs.map((d) => [d.itemId.toHexString(), d]),
    );
    const gapById = new Map(dto.gapAssignments.map((g) => [g.itemId, g]));

    for (const review of dto.itemReviews) {
      const draftItem = draftById.get(review.itemId);
      if (!draftItem) {
        throw new UnprocessableEntityException({
          code: 'UNKNOWN_REVIEW_ITEM_ID',
          message:
            'itemReviews references an item not present in the current draft.',
          details: { itemId: review.itemId },
        });
      }
      if (draftItem.contentVersion !== review.contentVersion) {
        throw new ConflictException({
          code: 'ITEM_CONTENT_VERSION_CONFLICT',
          message:
            'PublishReview contentVersion does not match current draft item.',
          details: { itemId: review.itemId },
        });
      }
      if (review.decision === 'GAP_REMAINS' && !gapById.has(review.itemId)) {
        throw new UnprocessableEntityException({
          code: 'MISSING_GAP_ASSIGNMENT',
          message:
            'Items marked GAP_REMAINS require a GapAssignment (owner, dueAt, reason).',
          details: { itemId: review.itemId },
        });
      }
    }

    for (const gap of dto.gapAssignments) {
      if (!draftById.has(gap.itemId)) {
        throw new UnprocessableEntityException({
          code: 'UNKNOWN_GAP_ITEM_ID',
          message:
            'gapAssignments references an item not present in the current draft.',
          details: { itemId: gap.itemId },
        });
      }
      await this.iamScope.assertEligibleActiveProjectMember(
        actor.organizationId,
        actor.projectId,
        gap.ownerUserId,
        'GAP_OWNER_NOT_ELIGIBLE',
      );
    }

    // Reverify current source eligibility & readability for the publishing Leader (and Successor in one batch)
    const allPublishRefs = [
      ...handover.selectedSources,
      ...draftDocs.flatMap((d) => collectItemDependencyRefs(d)),
    ];
    const leaderViewer: HandoverSourceViewer = {
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      userId: actor.userId,
      isProjectMember: actor.isProjectMember,
      isProjectLeader: actor.isProjectLeader,
    };
    const successorScope = handover.successorUserId
      ? handover.successorUserId.toLowerCase() === actor.userId.toLowerCase()
        ? {
            isProjectMember: actor.isProjectMember,
            isProjectLeader: actor.isProjectLeader,
          }
        : await this.iamScope.resolveActiveProjectMemberScope(
            actor.organizationId,
            actor.projectId,
            handover.successorUserId,
          )
      : { isProjectMember: false, isProjectLeader: false };

    const publishViewers: HandoverSourceViewer[] = [leaderViewer];
    if (handover.successorUserId && successorScope.isProjectMember) {
      publishViewers.push({
        organizationId: actor.organizationId,
        projectId: actor.projectId,
        userId: handover.successorUserId,
        isProjectMember: successorScope.isProjectMember,
        isProjectLeader: successorScope.isProjectLeader,
      });
    }
    const [leaderSourceMap, maybeSuccessorSourceMap] =
      await this.evaluateSourceRefsForViewers(publishViewers, allPublishRefs);
    const successorSourceMap =
      maybeSuccessorSourceMap ?? new Map<string, EvaluatedHandoverSource>();

    for (const ref of allPublishRefs) {
      const ev = leaderSourceMap.get(sourceRefKey(ref));
      if (!ev || !ev.eligible || !ev.readable) {
        throw new UnprocessableEntityException({
          code: 'SOURCE_INELIGIBLE_FOR_PUBLISH',
          message:
            'Unknown, archived, or inaccessible source cannot be published.',
          details: { sourceKind: ref.kind, sourceId: ref.id },
        });
      }
    }

    let previousRevision: StoredRevisionDoc | null = null;
    let previousAcceptances: StoredAcceptanceDoc[] = [];
    if (handover.publishedRevisionId) {
      previousRevision = await this.repository.revisions
        .findOne({
          _id: handover.publishedRevisionId,
          handoverId: handover._id,
          ...scope,
        })
        .lean<StoredRevisionDoc>()
        .exec();
      if (previousRevision) {
        const prevItemById = new Map(
          previousRevision.items.map((it) => [it.itemId.toHexString(), it]),
        );
        for (const rev of dto.itemReviews) {
          const prevIt = prevItemById.get(rev.itemId);
          const curIt = draftById.get(rev.itemId)!;
          if (
            prevIt &&
            rev.impact === 'UNCHANGED' &&
            (prevIt.contentVersion !== curIt.contentVersion ||
              prevIt.dependencyFingerprint !== curIt.dependencyFingerprint)
          ) {
            throw new UnprocessableEntityException({
              code: 'INVALID_UNCHANGED_IMPACT',
              message:
                'Cannot mark impact UNCHANGED when item content, requirement, flags, or source dependencies changed.',
              details: { itemId: rev.itemId },
            });
          }
        }
        previousAcceptances = await this.repository.acceptances
          .find({
            handoverId: handover._id,
            revisionId: previousRevision._id,
            ...scope,
          })
          .lean<StoredAcceptanceDoc[]>()
          .exec();
      }
    }

    const itemSnapshots: StoredHandoverItemSnapshot[] = draftDocs.map((d) => ({
      itemId: d.itemId,
      contentVersion: d.contentVersion,
      dependencyFingerprint: d.dependencyFingerprint,
      title: d.title,
      body: d.body,
      requirement: d.requirement,
      isRequired: d.isRequired,
      evidenceRequired: d.evidenceRequired,
      sources: d.sources,
      citations: d.citations,
    }));

    const carriedAcceptances = evaluateCarriedItemAcceptances({
      previousRevision,
      newItems: itemSnapshots,
      reviews: dto.itemReviews,
      successorUserId: handover.successorUserId,
      assignmentVersion: handover.assignmentVersion,
      previousAcceptances,
      successorSourceMap,
    });

    const latestRev = await this.repository.revisions
      .findOne({ handoverId: handover._id, ...scope })
      .sort({ number: -1 })
      .select({ number: 1 })
      .lean<{ number: number }>()
      .exec();
    const nextRevisionNumber = (latestRev?.number ?? 0) + 1;
    const now = new Date();
    const revisionId = new Types.ObjectId();
    const sourceFp = computeSourceSelectionFingerprint(
      handover.selectedSources,
    );

    const revisionDocToInsert = {
      _id: revisionId,
      schemaVersion: 2 as const,
      organizationId: handover.organizationId,
      projectId: handover.projectId,
      handoverId: handover._id,
      number: nextRevisionNumber,
      draftVersion: handover.draftVersion,
      assignmentVersion: handover.assignmentVersion,
      successorUserId: handover.successorUserId,
      items: itemSnapshots,
      selectedSources: handover.selectedSources,
      selectedTasks: handover.selectedTasks,
      reviews: dto.itemReviews.map((r) => ({
        itemId: new Types.ObjectId(r.itemId),
        contentVersion: r.contentVersion,
        decision: r.decision,
        impact: r.impact,
        reason: r.reason.trim(),
      })),
      gaps: dto.gapAssignments.map((g) => ({
        itemId: new Types.ObjectId(g.itemId),
        ownerUserId: g.ownerUserId,
        dueAt: new Date(g.dueAt),
        reason: g.reason.trim(),
      })),
      publishedBy: actor.userId,
      publishedAt: now,
      sourceFingerprint: sourceFp,
      reviewNote: dto.reviewNote.trim(),
      createdAt: now,
    };

    // Enforce 4 MiB BSON snapshot limit -> 413 BEFORE MongoDB write!
    this.repository.assertRevisionSnapshotWithinLimit(revisionDocToInsert);

    const nextVersion = await this.repository.withTransaction(
      async (session) => {
        const nextVer = expectedVersion + 1;
        const upd = await this.repository.handovers.updateOne(
          {
            _id: handover._id,
            ...scope,
            status: 'OPEN',
            version: expectedVersion,
            draftVersion: dto.expectedDraftVersion,
          },
          {
            $set: {
              publishedRevisionId: revisionId,
              version: nextVer,
            },
          },
          { session },
        );
        if (upd.matchedCount !== 1) {
          throw new ConflictException({
            code: 'VERSION_CONFLICT',
            message:
              'Concurrent handover version update detected during publish.',
            details: {},
          });
        }

        await this.repository.revisions.create([revisionDocToInsert], {
          session,
        });

        if (carriedAcceptances.length > 0 && handover.successorUserId) {
          await this.repository.acceptances.create(
            carriedAcceptances.map((carried, idx) => ({
              _id: new Types.ObjectId(),
              schemaVersion: 2 as const,
              organizationId: handover.organizationId,
              projectId: handover.projectId,
              handoverId: handover._id,
              revisionId,
              successorUserId: handover.successorUserId!,
              assignmentVersion: handover.assignmentVersion,
              kind: 'ITEM' as const,
              itemId: carried.item.itemId,
              contentVersion: carried.item.contentVersion,
              dependencyFingerprint: carried.item.dependencyFingerprint,
              decision: 'UNDERSTOOD' as const,
              note: carried.note,
              commandId: new Types.ObjectId(),
              sequence: idx + 1,
              occurredAt: now,
              carriedFromAcceptanceId: carried.carriedFromAcceptanceId,
            })),
            { session, ordered: true },
          );
        }

        await this.repository.createOrClaimCommandOperation(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            handoverId: handover._id,
            actorUserId: actor.userId,
            namespace,
            key: idempotencyKey,
            fingerprint,
            expectedVersion,
            receipt: {
              resourceId: handover._id,
              resourceVersion: nextVer,
              revisionId,
              outcome: 'PUBLISHED',
            },
          },
          session,
        );

        await this.repository.appendAuditAndOutbox(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            actorUserId: actor.userId,
            action: 'handover.revision.published',
            targetResource: 'handover_revision',
            targetResourceId: revisionId.toHexString(),
            metadata: {
              handoverId: handover._id.toHexString(),
              revisionNumber: nextRevisionNumber,
              carriedAcceptanceCount: carriedAcceptances.length,
            },
          },
          {
            eventName: 'handover.revision.published',
            aggregateType: 'handover',
            aggregateId: handover._id.toHexString(),
            payload: {
              revisionId: revisionId.toHexString(),
              revisionNumber: nextRevisionNumber,
            },
          },
          session,
        );

        return nextVer;
      },
    );

    return {
      body: this.toReceiptDto({
        operationId: idempotencyKey,
        handover,
        versionOverride: nextVersion,
        revisionIdOverride: revisionId,
        replayed: false,
      }),
      etag: formatHandoverEtag(handover._id.toHexString(), nextVersion),
    };
  }

  async acceptHandoverPackage(
    projectId: string,
    handoverId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<ReceiptDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );
    const dto = validateAcceptRequest(rawBody);

    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);
    if (
      !actor.isProjectMember ||
      !handover.successorUserId ||
      handover.successorUserId.toLowerCase() !== actor.userId
    ) {
      throw new ForbiddenException({
        code: 'RECIPIENT_ONLY_OPERATION',
        message:
          'Only the currently assigned successor B may accept this package.',
        details: {},
      });
    }

    const namespace = `handover:${handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'acceptHandoverPackage',
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      resourceScope: namespace,
      expectedVersion,
      payload: dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      namespace,
      key: idempotencyKey,
    });
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED'
    ) {
      const ver = existingOp?.receipt?.resourceVersion ?? handover.version;
      return {
        body: this.toReceiptDto({
          operationId: idempotencyKey,
          handover,
          versionOverride: ver,
          revisionIdOverride: existingOp?.receipt?.revisionId ?? null,
          replayed: true,
        }),
        etag: formatHandoverEtag(handover._id.toHexString(), ver),
        replayed: true,
      };
    }

    if (handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Package acceptance requires an OPEN handover.',
        details: {},
      });
    }
    if (handover.version !== expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Handover aggregate version conflict.',
        details: {},
      });
    }
    if (
      !handover.publishedRevisionId ||
      handover.publishedRevisionId.toHexString() !== dto.revisionId
    ) {
      throw new ConflictException({
        code: 'STALE_REVISION_REFERENCE',
        message: 'revisionId does not match the current published revision.',
        details: {},
      });
    }

    const revisionId = handover.publishedRevisionId;
    const nextVersion = await this.repository.withTransaction(
      async (session) => {
        const nextVer = expectedVersion + 1;
        const upd = await this.repository.handovers.updateOne(
          {
            _id: handover._id,
            organizationId: handover.organizationId,
            projectId: handover.projectId,
            status: 'OPEN',
            version: expectedVersion,
            successorUserId: actor.userId,
          },
          { $set: { version: nextVer } },
          { session },
        );
        if (upd.matchedCount !== 1) {
          throw new ConflictException({
            code: 'VERSION_CONFLICT',
            message:
              'Concurrent handover version or recipient update detected.',
            details: {},
          });
        }

        const seq = await this.repository.nextSequence(
          'handover_acceptances',
          {
            organizationId: handover.organizationId,
            projectId: handover.projectId,
            handoverId: handover._id,
            revisionId,
            successorUserId: actor.userId,
            assignmentVersion: handover.assignmentVersion,
          },
          session,
        );

        await this.repository.acceptances.create(
          [
            {
              _id: new Types.ObjectId(),
              schemaVersion: 2,
              organizationId: handover.organizationId,
              projectId: handover.projectId,
              handoverId: handover._id,
              revisionId,
              successorUserId: actor.userId,
              assignmentVersion: handover.assignmentVersion,
              kind: 'PACKAGE',
              decision: 'ACCEPTED',
              note: '',
              commandId: new Types.ObjectId(),
              sequence: seq,
              occurredAt: new Date(),
            },
          ],
          { session },
        );

        await this.repository.createOrClaimCommandOperation(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            handoverId: handover._id,
            actorUserId: actor.userId,
            namespace,
            key: idempotencyKey,
            fingerprint,
            expectedVersion,
            receipt: {
              resourceId: handover._id,
              resourceVersion: nextVer,
              revisionId,
              outcome: 'PACKAGE_ACCEPTED',
            },
          },
          session,
        );

        await this.repository.appendAuditAndOutbox(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            actorUserId: actor.userId,
            action: 'handover.package.accepted',
            targetResource: 'handover',
            targetResourceId: handover._id.toHexString(),
            metadata: {
              revisionId: revisionId.toHexString(),
              assignmentVersion: handover.assignmentVersion,
            },
          },
          {
            eventName: 'handover.package.accepted',
            aggregateType: 'handover',
            aggregateId: handover._id.toHexString(),
            payload: {
              revisionId: revisionId.toHexString(),
              assignmentVersion: handover.assignmentVersion,
            },
          },
          session,
        );
        return nextVer;
      },
    );

    return {
      body: this.toReceiptDto({
        operationId: idempotencyKey,
        handover,
        versionOverride: nextVersion,
        revisionIdOverride: revisionId,
        replayed: false,
      }),
      etag: formatHandoverEtag(handover._id.toHexString(), nextVersion),
    };
  }

  async acknowledgeHandoverItem(
    projectId: string,
    handoverId: string,
    itemId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<ReceiptDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const cleanItemId = assertHexId(itemId, 'itemId');
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );
    const dto = validateAcknowledgeRequest(rawBody);

    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);
    if (
      !actor.isProjectMember ||
      !handover.successorUserId ||
      handover.successorUserId.toLowerCase() !== actor.userId
    ) {
      throw new ForbiddenException({
        code: 'RECIPIENT_ONLY_OPERATION',
        message:
          'Only the currently assigned successor B may acknowledge handover items.',
        details: {},
      });
    }

    const namespace = `handover:${handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'acknowledgeHandoverItem',
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      resourceScope: `${namespace}:item:${cleanItemId}`,
      expectedVersion,
      payload: dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      namespace,
      key: idempotencyKey,
    });
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED'
    ) {
      const ver = existingOp?.receipt?.resourceVersion ?? handover.version;
      return {
        body: this.toReceiptDto({
          operationId: idempotencyKey,
          handover,
          versionOverride: ver,
          revisionIdOverride: existingOp?.receipt?.revisionId ?? null,
          replayed: true,
        }),
        etag: formatHandoverEtag(handover._id.toHexString(), ver),
        replayed: true,
      };
    }

    if (handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Item acknowledgement requires an OPEN handover.',
        details: {},
      });
    }
    if (handover.version !== expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Handover aggregate version conflict.',
        details: {},
      });
    }
    if (
      !handover.publishedRevisionId ||
      handover.publishedRevisionId.toHexString() !== dto.revisionId
    ) {
      throw new ConflictException({
        code: 'STALE_REVISION_REFERENCE',
        message: 'revisionId does not match the current published revision.',
        details: {},
      });
    }
    if (handover.assignmentVersion !== dto.assignmentVersion) {
      throw new ConflictException({
        code: 'ASSIGNMENT_EPOCH_MISMATCH',
        message: 'assignmentVersion does not match current successor epoch.',
        details: {},
      });
    }

    const scope = {
      organizationId: handover.organizationId,
      projectId: handover.projectId,
    };
    const revision = await this.repository.revisions
      .findOne({
        _id: handover.publishedRevisionId,
        handoverId: handover._id,
        ...scope,
      })
      .lean<StoredRevisionDoc>()
      .exec();
    const targetItem = revision?.items.find(
      (it) => it.itemId.toHexString() === cleanItemId,
    );
    if (!revision || !targetItem) {
      throw new NotFoundException({
        code: 'ITEM_NOT_FOUND',
        message: 'Handover item not found in published revision.',
        details: {},
      });
    }
    if (targetItem.contentVersion !== dto.contentVersion) {
      throw new ConflictException({
        code: 'ITEM_CONTENT_VERSION_CONFLICT',
        message: 'contentVersion does not match published item version.',
        details: {},
      });
    }

    const deps = await this.guardedItemDependencies(
      handover._id,
      targetItem,
      scope,
    );
    const evalMap = await this.sourcesService.evaluateSourceRefsMap(
      {
        organizationId: actor.organizationId,
        projectId: actor.projectId,
        userId: actor.userId,
        isProjectMember: actor.isProjectMember,
        isProjectLeader: actor.isProjectLeader,
      },
      deps,
    );
    for (const dep of deps) {
      const ev = evalMap.get(sourceRefKey(dep));
      if (!ev || !ev.eligible || !ev.readable) {
        throw new ForbiddenException({
          code: 'ITEM_DEPENDENCY_UNAVAILABLE',
          message:
            'Cannot acknowledge an item whose source dependencies are restricted or unavailable.',
          details: { itemId: cleanItemId },
        });
      }
    }

    const nextVersion = await this.repository.withTransaction(
      async (session) => {
        const nextVer = expectedVersion + 1;
        const upd = await this.repository.handovers.updateOne(
          {
            _id: handover._id,
            ...scope,
            status: 'OPEN',
            version: expectedVersion,
            successorUserId: actor.userId,
            assignmentVersion: dto.assignmentVersion,
          },
          { $set: { version: nextVer } },
          { session },
        );
        if (upd.matchedCount !== 1) {
          throw new ConflictException({
            code: 'VERSION_CONFLICT',
            message:
              'Concurrent handover version or assignment epoch update detected.',
            details: {},
          });
        }

        const seq = await this.repository.nextSequence(
          'handover_acceptances',
          {
            ...scope,
            handoverId: handover._id,
            revisionId: revision._id,
            successorUserId: actor.userId,
            assignmentVersion: handover.assignmentVersion,
            itemId: targetItem.itemId,
          },
          session,
        );

        await this.repository.acceptances.create(
          [
            {
              _id: new Types.ObjectId(),
              schemaVersion: 2,
              organizationId: handover.organizationId,
              projectId: handover.projectId,
              handoverId: handover._id,
              revisionId: revision._id,
              successorUserId: actor.userId,
              assignmentVersion: handover.assignmentVersion,
              kind: 'ITEM',
              itemId: targetItem.itemId,
              contentVersion: targetItem.contentVersion,
              dependencyFingerprint: targetItem.dependencyFingerprint,
              decision: dto.decision,
              note: dto.note,
              commandId: new Types.ObjectId(),
              sequence: seq,
              occurredAt: new Date(),
            },
          ],
          { session },
        );

        await this.repository.createOrClaimCommandOperation(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            handoverId: handover._id,
            actorUserId: actor.userId,
            namespace,
            key: idempotencyKey,
            fingerprint,
            expectedVersion,
            receipt: {
              resourceId: handover._id,
              resourceVersion: nextVer,
              revisionId: revision._id,
              outcome: dto.decision,
            },
          },
          session,
        );

        await this.repository.appendAuditAndOutbox(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            actorUserId: actor.userId,
            action: 'handover.item.acknowledged',
            targetResource: 'handover_item',
            targetResourceId: cleanItemId,
            metadata: {
              handoverId: handover._id.toHexString(),
              revisionId: revision._id.toHexString(),
              decision: dto.decision,
            },
          },
          null,
          session,
        );

        return nextVer;
      },
    );

    return {
      body: this.toReceiptDto({
        operationId: idempotencyKey,
        handover,
        versionOverride: nextVersion,
        revisionIdOverride: revision._id,
        replayed: false,
      }),
      etag: formatHandoverEtag(handover._id.toHexString(), nextVersion),
    };
  }

  private async toEvidenceReceiptDto(
    evidence: StoredEvidenceDoc,
  ): Promise<EvidenceReceiptDto> {
    const latestReview = await this.repository.evidenceReviews
      .findOne({
        evidenceId: evidence._id,
        organizationId: evidence.organizationId,
        projectId: evidence.projectId,
      })
      .sort({ sequence: -1 })
      .lean<StoredEvidenceReviewDoc>()
      .exec();

    let review: EvidenceReceiptDto['review'] = 'PENDING';
    if (latestReview) {
      review =
        latestReview.decision === 'APPROVED' ? 'ACCEPTED' : 'CHANGES_REQUESTED';
    }

    return {
      id: evidence._id.toHexString(),
      handoverId: evidence.handoverId.toHexString(),
      itemId: evidence.itemId.toHexString(),
      revisionId: evidence.revisionId.toHexString(),
      submittedBy: evidence.successorUserId,
      assignmentVersion: evidence.assignmentVersion,
      review,
      createdAt: evidence.submittedAt.toISOString(),
    };
  }

  async listItemEvidence(
    projectId: string,
    handoverId: string,
    itemId: string,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<{ data: ItemEvidenceDetailDto[] }>> {
    const actor = await this.resolveActor(projectId, headers, false);
    const handover = await this.loadHandoverOrNotFound(actor, handoverId);
    const cleanItemId = assertHexId(itemId, 'itemId');

    const isLeader = actor.isProjectMember && actor.isProjectLeader;
    const isCurrentSucc =
      actor.isProjectMember &&
      handover.successorUserId?.toLowerCase() === actor.userId;

    if (!isLeader && !isCurrentSucc) {
      throw new ForbiddenException({
        code: 'HANDOVER_FORBIDDEN',
        message:
          'Not authorized to inspect evidence submissions for this item.',
        details: {},
      });
    }

    if (!handover.publishedRevisionId || !handover.successorUserId) {
      return {
        body: { data: [] },
        etag: formatHandoverEtag(handover._id.toHexString(), handover.version),
      };
    }

    const scope = {
      organizationId: handover.organizationId,
      projectId: handover.projectId,
    };
    const revision = await this.repository.revisions
      .findOne({
        _id: handover.publishedRevisionId,
        handoverId: handover._id,
        ...scope,
      })
      .lean<StoredRevisionDoc>()
      .exec();
    const targetItem = revision?.items.find(
      (it) => it.itemId.toHexString() === cleanItemId,
    );
    if (!revision || !targetItem) {
      throw new NotFoundException({
        code: 'ITEM_NOT_FOUND',
        message: 'Handover item not found.',
        details: {},
      });
    }

    const deps = await this.guardedItemDependencies(
      handover._id,
      targetItem,
      scope,
    );
    const evalMap = await this.sourcesService.evaluateSourceRefsMap(
      {
        organizationId: actor.organizationId,
        projectId: actor.projectId,
        userId: actor.userId,
        isProjectMember: actor.isProjectMember,
        isProjectLeader: actor.isProjectLeader,
      },
      deps,
    );
    if (
      !deps.every((d) => {
        const ev = evalMap.get(sourceRefKey(d));
        return Boolean(ev && ev.eligible && ev.readable);
      })
    ) {
      throw new ForbiddenException({
        code: 'ITEM_DEPENDENCY_UNAVAILABLE',
        message: 'Item dependencies are restricted or unavailable.',
        details: {},
      });
    }

    const evidences = await this.repository.evidences
      .find({
        handoverId: handover._id,
        ...scope,
        revisionId: revision._id,
        successorUserId: handover.successorUserId.toLowerCase(),
        assignmentVersion: handover.assignmentVersion,
        itemId: targetItem.itemId,
      })
      .sort({ sequence: -1 })
      .lean<StoredEvidenceDoc[]>()
      .exec();

    const reviews = await this.repository.evidenceReviews
      .find({
        ...scope,
        evidenceId: { $in: evidences.map((e) => e._id) },
      })
      .sort({ sequence: -1 })
      .lean<StoredEvidenceReviewDoc[]>()
      .exec();

    const data: ItemEvidenceDetailDto[] = evidences.map((ev) => {
      const latestRev = reviews.find(
        (r) => r.evidenceId.toHexString() === ev._id.toHexString(),
      );
      return {
        id: ev._id.toHexString(),
        handoverId: ev.handoverId.toHexString(),
        itemId: ev.itemId.toHexString(),
        revisionId: ev.revisionId.toHexString(),
        contentVersion: ev.contentVersion,
        submittedBy: ev.successorUserId,
        assignmentVersion: ev.assignmentVersion,
        resultText: ev.resultText,
        links: ev.links,
        review: !latestRev
          ? 'PENDING'
          : latestRev.decision === 'APPROVED'
            ? 'ACCEPTED'
            : 'CHANGES_REQUESTED',
        reviewNote: latestRev ? latestRev.note : null,
        createdAt: ev.submittedAt.toISOString(),
      };
    });

    return {
      body: { data },
      etag: formatHandoverEtag(handover._id.toHexString(), handover.version),
    };
  }

  async submitHandoverEvidence(
    projectId: string,
    handoverId: string,
    itemId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<EvidenceReceiptDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const cleanItemId = assertHexId(itemId, 'itemId');
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );
    const dto = validateSubmitEvidence(rawBody);

    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);
    if (
      !actor.isProjectMember ||
      !handover.successorUserId ||
      handover.successorUserId.toLowerCase() !== actor.userId
    ) {
      throw new ForbiddenException({
        code: 'RECIPIENT_ONLY_OPERATION',
        message:
          'Only the currently assigned successor B may submit item evidence.',
        details: {},
      });
    }

    const namespace = `handover:${handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'submitHandoverEvidence',
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      resourceScope: `${namespace}:item:${cleanItemId}`,
      expectedVersion,
      payload: dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      namespace,
      key: idempotencyKey,
    });
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED' &&
      existingOp?.receipt?.resourceId
    ) {
      const existingEv = await this.repository.evidences
        .findOne({
          _id: existingOp.receipt.resourceId,
          organizationId: handover.organizationId,
          projectId: handover.projectId,
        })
        .lean<StoredEvidenceDoc>()
        .exec();
      if (!existingEv) {
        throw new NotFoundException({
          code: 'EVIDENCE_NOT_FOUND',
          message: 'Evidence record not found.',
          details: {},
        });
      }
      const ver = existingOp.receipt.resourceVersion ?? handover.version;
      return {
        body: await this.toEvidenceReceiptDto(existingEv),
        etag: formatHandoverEtag(handover._id.toHexString(), ver),
        replayed: true,
      };
    }

    if (handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Evidence submission requires an OPEN handover.',
        details: {},
      });
    }
    if (handover.version !== expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Handover aggregate version conflict.',
        details: {},
      });
    }
    if (
      !handover.publishedRevisionId ||
      handover.publishedRevisionId.toHexString() !== dto.revisionId
    ) {
      throw new ConflictException({
        code: 'STALE_REVISION_REFERENCE',
        message: 'revisionId does not match the current published revision.',
        details: {},
      });
    }
    if (handover.assignmentVersion !== dto.assignmentVersion) {
      throw new ConflictException({
        code: 'ASSIGNMENT_EPOCH_MISMATCH',
        message: 'assignmentVersion does not match current successor epoch.',
        details: {},
      });
    }

    const scope = {
      organizationId: handover.organizationId,
      projectId: handover.projectId,
    };
    const revision = await this.repository.revisions
      .findOne({
        _id: handover.publishedRevisionId,
        handoverId: handover._id,
        ...scope,
      })
      .lean<StoredRevisionDoc>()
      .exec();
    const targetItem = revision?.items.find(
      (it) => it.itemId.toHexString() === cleanItemId,
    );
    if (!revision || !targetItem) {
      throw new NotFoundException({
        code: 'ITEM_NOT_FOUND',
        message: 'Handover item not found in published revision.',
        details: {},
      });
    }
    if (targetItem.contentVersion !== dto.contentVersion) {
      throw new ConflictException({
        code: 'ITEM_CONTENT_VERSION_CONFLICT',
        message: 'contentVersion does not match published item version.',
        details: {},
      });
    }

    const deps = await this.guardedItemDependencies(
      handover._id,
      targetItem,
      scope,
    );
    const evalMap = await this.sourcesService.evaluateSourceRefsMap(
      {
        organizationId: actor.organizationId,
        projectId: actor.projectId,
        userId: actor.userId,
        isProjectMember: actor.isProjectMember,
        isProjectLeader: actor.isProjectLeader,
      },
      deps,
    );
    for (const dep of deps) {
      const ev = evalMap.get(sourceRefKey(dep));
      if (!ev || !ev.eligible || !ev.readable) {
        throw new ForbiddenException({
          code: 'ITEM_DEPENDENCY_UNAVAILABLE',
          message:
            'Cannot submit evidence for an item with restricted or unavailable dependencies.',
          details: { itemId: cleanItemId },
        });
      }
    }

    const { createdEvidence, nextVersion } =
      await this.repository.withTransaction(async (session) => {
        const nextVer = expectedVersion + 1;
        const upd = await this.repository.handovers.updateOne(
          {
            _id: handover._id,
            ...scope,
            status: 'OPEN',
            version: expectedVersion,
            successorUserId: actor.userId,
            assignmentVersion: dto.assignmentVersion,
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

        const seq = await this.repository.nextSequence(
          'handover_evidence',
          {
            ...scope,
            handoverId: handover._id,
            revisionId: revision._id,
            successorUserId: actor.userId,
            assignmentVersion: handover.assignmentVersion,
            itemId: targetItem.itemId,
          },
          session,
        );

        const evId = new Types.ObjectId();
        const [evDoc] = await this.repository.evidences.create(
          [
            {
              _id: evId,
              schemaVersion: 2,
              organizationId: handover.organizationId,
              projectId: handover.projectId,
              handoverId: handover._id,
              revisionId: revision._id,
              successorUserId: actor.userId,
              assignmentVersion: handover.assignmentVersion,
              itemId: targetItem.itemId,
              contentVersion: targetItem.contentVersion,
              dependencyFingerprint: targetItem.dependencyFingerprint,
              resultText: dto.resultText,
              links: dto.links,
              commandId: new Types.ObjectId(),
              sequence: seq,
              submittedAt: new Date(),
            },
          ],
          { session },
        );

        await this.repository.createOrClaimCommandOperation(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            handoverId: handover._id,
            actorUserId: actor.userId,
            namespace,
            key: idempotencyKey,
            fingerprint,
            expectedVersion,
            receipt: {
              resourceId: evId,
              resourceVersion: nextVer,
              revisionId: revision._id,
              outcome: 'EVIDENCE_SUBMITTED',
            },
          },
          session,
        );

        await this.repository.appendAuditAndOutbox(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            actorUserId: actor.userId,
            action: 'handover.evidence.submitted',
            targetResource: 'handover_evidence',
            targetResourceId: evId.toHexString(),
            metadata: {
              handoverId: handover._id.toHexString(),
              itemId: cleanItemId,
              linkCount: dto.links.length,
            },
          },
          null,
          session,
        );

        return {
          createdEvidence: evDoc.toObject(),
          nextVersion: nextVer,
        };
      });

    return {
      body: await this.toEvidenceReceiptDto(createdEvidence),
      etag: formatHandoverEtag(handover._id.toHexString(), nextVersion),
    };
  }

  async reviewHandoverEvidence(
    projectId: string,
    handoverId: string,
    itemId: string,
    evidenceId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<ReceiptDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const cleanItemId = assertHexId(itemId, 'itemId');
    const cleanEvidenceId = assertHexId(evidenceId, 'evidenceId');
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );
    const dto = validateReviewEvidence(rawBody);
    this.assertLeaderAuthority(actor);

    if (dto.evidenceId !== cleanEvidenceId) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Body evidenceId must equal path evidenceId.',
        details: { field: 'evidenceId' },
      });
    }

    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);
    const namespace = `handover:${handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'reviewHandoverEvidence',
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      resourceScope: `${namespace}:evidence:${cleanEvidenceId}`,
      expectedVersion,
      payload: dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      namespace,
      key: idempotencyKey,
    });
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED'
    ) {
      const ver = existingOp?.receipt?.resourceVersion ?? handover.version;
      return {
        body: this.toReceiptDto({
          operationId: idempotencyKey,
          handover,
          versionOverride: ver,
          revisionIdOverride: existingOp?.receipt?.revisionId ?? null,
          replayed: true,
        }),
        etag: formatHandoverEtag(handover._id.toHexString(), ver),
        replayed: true,
      };
    }

    if (handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Evidence review requires an OPEN handover.',
        details: {},
      });
    }
    if (handover.version !== expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Handover aggregate version conflict.',
        details: {},
      });
    }
    if (
      !handover.publishedRevisionId ||
      handover.publishedRevisionId.toHexString() !== dto.revisionId
    ) {
      throw new ConflictException({
        code: 'STALE_REVISION_REFERENCE',
        message: 'revisionId does not match the current published revision.',
        details: {},
      });
    }
    if (!handover.successorUserId) {
      throw new ConflictException({
        code: 'SUCCESSOR_NOT_ASSIGNED',
        message: 'No current successor B is assigned.',
        details: {},
      });
    }
    if (handover.successorUserId.toLowerCase() === actor.userId) {
      throw new ConflictException({
        code: 'SELF_EVIDENCE_REVIEW_FORBIDDEN',
        message:
          'Successor B cannot review their own submitted evidence; another Project Leader must review.',
        details: {},
      });
    }

    const scope = {
      organizationId: handover.organizationId,
      projectId: handover.projectId,
    };
    const [revision, evidenceDoc] = await Promise.all([
      this.repository.revisions
        .findOne({
          _id: handover.publishedRevisionId,
          handoverId: handover._id,
          ...scope,
        })
        .lean<StoredRevisionDoc>()
        .exec(),
      this.repository.evidences
        .findOne({
          _id: new Types.ObjectId(cleanEvidenceId),
          handoverId: handover._id,
          ...scope,
          itemId: new Types.ObjectId(cleanItemId),
        })
        .lean<StoredEvidenceDoc>()
        .exec(),
    ]);

    const targetItem = revision?.items.find(
      (it) => it.itemId.toHexString() === cleanItemId,
    );
    if (!revision || !targetItem || !evidenceDoc) {
      throw new NotFoundException({
        code: 'EVIDENCE_NOT_FOUND',
        message: 'Evidence submission not found for this item.',
        details: {},
      });
    }

    if (
      evidenceDoc.revisionId.toHexString() !== revision._id.toHexString() ||
      evidenceDoc.successorUserId.toLowerCase() !==
        handover.successorUserId.toLowerCase() ||
      evidenceDoc.assignmentVersion !== handover.assignmentVersion ||
      evidenceDoc.contentVersion !== targetItem.contentVersion ||
      evidenceDoc.dependencyFingerprint !== targetItem.dependencyFingerprint
    ) {
      throw new ConflictException({
        code: 'STALE_EVIDENCE_BINDING',
        message:
          'Evidence belongs to a superseded revision, item version, or recipient epoch.',
        details: {},
      });
    }

    const deps = await this.guardedItemDependencies(
      handover._id,
      targetItem,
      scope,
    );
    const evalMap = await this.sourcesService.evaluateSourceRefsMap(
      {
        organizationId: actor.organizationId,
        projectId: actor.projectId,
        userId: actor.userId,
        isProjectMember: actor.isProjectMember,
        isProjectLeader: actor.isProjectLeader,
      },
      deps,
    );
    for (const dep of deps) {
      const ev = evalMap.get(sourceRefKey(dep));
      if (!ev || !ev.eligible || !ev.readable) {
        throw new ForbiddenException({
          code: 'ITEM_DEPENDENCY_UNAVAILABLE',
          message:
            'Reviewer lacks access to one or more item source dependencies.',
          details: { itemId: cleanItemId },
        });
      }
    }

    const dbDecision = dto.outcome === 'ACCEPTED' ? 'APPROVED' : 'REJECTED';

    const nextVersion = await this.repository.withTransaction(
      async (session) => {
        const nextVer = expectedVersion + 1;
        const upd = await this.repository.handovers.updateOne(
          {
            _id: handover._id,
            ...scope,
            status: 'OPEN',
            version: expectedVersion,
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

        const seq = await this.repository.nextSequence(
          'handover_evidence_reviews',
          {
            ...scope,
            handoverId: handover._id,
            revisionId: revision._id,
            successorUserId: handover.successorUserId!,
            assignmentVersion: handover.assignmentVersion,
            itemId: targetItem.itemId,
          },
          session,
        );

        await this.repository.evidenceReviews.create(
          [
            {
              _id: new Types.ObjectId(),
              schemaVersion: 2,
              organizationId: handover.organizationId,
              projectId: handover.projectId,
              handoverId: handover._id,
              revisionId: revision._id,
              successorUserId: handover.successorUserId!,
              assignmentVersion: handover.assignmentVersion,
              itemId: targetItem.itemId,
              contentVersion: targetItem.contentVersion,
              dependencyFingerprint: targetItem.dependencyFingerprint,
              evidenceId: evidenceDoc._id,
              reviewerUserId: actor.userId,
              decision: dbDecision,
              note: dto.note.trim(),
              commandId: new Types.ObjectId(),
              sequence: seq,
              reviewedAt: new Date(),
            },
          ],
          { session },
        );

        await this.repository.createOrClaimCommandOperation(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            handoverId: handover._id,
            actorUserId: actor.userId,
            namespace,
            key: idempotencyKey,
            fingerprint,
            expectedVersion,
            receipt: {
              resourceId: handover._id,
              resourceVersion: nextVer,
              revisionId: revision._id,
              outcome: dto.outcome,
            },
          },
          session,
        );

        await this.repository.appendAuditAndOutbox(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            actorUserId: actor.userId,
            action: 'handover.evidence.reviewed',
            targetResource: 'handover_evidence',
            targetResourceId: cleanEvidenceId,
            metadata: {
              handoverId: handover._id.toHexString(),
              outcome: dto.outcome,
            },
          },
          null,
          session,
        );

        return nextVer;
      },
    );

    return {
      body: this.toReceiptDto({
        operationId: idempotencyKey,
        handover,
        versionOverride: nextVersion,
        revisionIdOverride: revision._id,
        replayed: false,
      }),
      etag: formatHandoverEtag(handover._id.toHexString(), nextVersion),
    };
  }

  async acceptOptionalHandoverGap(
    projectId: string,
    handoverId: string,
    itemId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<FollowUpDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const cleanItemId = assertHexId(itemId, 'itemId');
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );
    const dto = validateOptionalException(rawBody);
    this.assertLeaderAuthority(actor);

    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);
    const namespace = `handover:${handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'acceptOptionalHandoverGap',
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      resourceScope: `${namespace}:item:${cleanItemId}`,
      expectedVersion,
      payload: dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      namespace,
      key: idempotencyKey,
    });
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED' &&
      existingOp?.receipt?.followUpId
    ) {
      const existingFollowUp = await this.repository.followUps
        .findOne({
          _id: existingOp.receipt.followUpId,
          organizationId: handover.organizationId,
          projectId: handover.projectId,
          schemaVersion: 2,
        })
        .lean<StoredFollowUpDoc>()
        .exec();
      if (!existingFollowUp) {
        throw new NotFoundException({
          code: 'FOLLOW_UP_NOT_FOUND',
          message: 'Follow-up not found.',
          details: {},
        });
      }
      return {
        body: await this.toFollowUpDto(existingFollowUp, actor),
        etag: formatFollowUpEtag(
          existingFollowUp._id.toHexString(),
          existingFollowUp.version,
        ),
        replayed: true,
      };
    }

    if (handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Optional gap exception requires an OPEN handover.',
        details: {},
      });
    }
    if (handover.version !== expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Handover aggregate version conflict.',
        details: {},
      });
    }
    if (
      !handover.publishedRevisionId ||
      handover.publishedRevisionId.toHexString() !== dto.revisionId
    ) {
      throw new ConflictException({
        code: 'STALE_REVISION_REFERENCE',
        message: 'revisionId does not match the current published revision.',
        details: {},
      });
    }

    const scope = {
      organizationId: handover.organizationId,
      projectId: handover.projectId,
    };
    const revision = await this.repository.revisions
      .findOne({
        _id: handover.publishedRevisionId,
        handoverId: handover._id,
        ...scope,
      })
      .lean<StoredRevisionDoc>()
      .exec();
    const targetItem = revision?.items.find(
      (it) => it.itemId.toHexString() === cleanItemId,
    );
    if (!revision || !targetItem) {
      throw new NotFoundException({
        code: 'ITEM_NOT_FOUND',
        message: 'Handover item not found in published revision.',
        details: {},
      });
    }
    if (targetItem.contentVersion !== dto.contentVersion) {
      throw new ConflictException({
        code: 'ITEM_CONTENT_VERSION_CONFLICT',
        message: 'contentVersion does not match published item version.',
        details: {},
      });
    }

    // Scenario A08: Required items can NEVER be waived via OptionalException!
    if (targetItem.isRequired) {
      throw new UnprocessableEntityException({
        code: 'REQUIRED_ITEM_CANNOT_BE_WAIVED',
        message:
          'Required handover items cannot be waived with an optional-gap exception.',
        details: { itemId: cleanItemId },
      });
    }

    await this.assertFollowUpReadable(actor, {
      handoverId: handover._id,
      revisionId: revision._id,
      itemId: targetItem.itemId,
    });

    await this.iamScope.assertEligibleActiveProjectMember(
      actor.organizationId,
      actor.projectId,
      dto.ownerUserId,
      'FOLLOW_UP_OWNER_NOT_ELIGIBLE',
    );

    const savedFollowUp = await this.repository.withTransaction(
      async (session) => {
        const nextVer = expectedVersion + 1;
        const upd = await this.repository.handovers.updateOne(
          {
            _id: handover._id,
            ...scope,
            status: 'OPEN',
            version: expectedVersion,
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

        const existingFollow = await this.repository.followUps
          .findOne({
            schemaVersion: 2,
            ...scope,
            handoverId: handover._id,
            revisionId: revision._id,
            itemId: targetItem.itemId,
          })
          .session(session)
          .lean<StoredFollowUpDoc>()
          .exec();

        let followDoc: StoredFollowUpDoc;
        if (existingFollow) {
          const updated = await this.repository.followUps
            .findOneAndUpdate(
              { _id: existingFollow._id, ...scope },
              {
                $set: {
                  ownerUserId: dto.ownerUserId,
                  reason: dto.reason.trim(),
                  dueAt: new Date(dto.dueAt),
                  status: 'OPEN',
                  resolvedAt: null,
                },
                $unset: {
                  resolvedBy: 1,
                  resolutionNote: 1,
                  resolutionEvidenceId: 1,
                },
                $inc: { version: 1 },
              },
              { new: true, session },
            )
            .lean<StoredFollowUpDoc>()
            .exec();
          followDoc = updated!;
        } else {
          const [created] = await this.repository.followUps.create(
            [
              {
                _id: new Types.ObjectId(),
                schemaVersion: 2,
                organizationId: handover.organizationId,
                projectId: handover.projectId,
                handoverId: handover._id,
                revisionId: revision._id,
                itemId: targetItem.itemId,
                kind: 'KNOWLEDGE_GAP',
                isRequired: false,
                ownerUserId: dto.ownerUserId,
                reason: dto.reason.trim(),
                dueAt: new Date(dto.dueAt),
                status: 'OPEN',
                version: 1,
                createdBy: actor.userId,
                resolvedAt: null,
              },
            ],
            { session },
          );
          followDoc = created.toObject();
        }

        await this.repository.createOrClaimCommandOperation(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            handoverId: handover._id,
            actorUserId: actor.userId,
            namespace,
            key: idempotencyKey,
            fingerprint,
            expectedVersion,
            receipt: {
              resourceId: handover._id,
              resourceVersion: nextVer,
              revisionId: revision._id,
              followUpId: followDoc._id,
              outcome: 'OPTIONAL_GAP_EXCEPTION_ACCEPTED',
            },
          },
          session,
        );

        await this.repository.appendAuditAndOutbox(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            actorUserId: actor.userId,
            action: 'handover.optional_gap.accepted',
            targetResource: 'handover_followup',
            targetResourceId: followDoc._id.toHexString(),
            metadata: {
              handoverId: handover._id.toHexString(),
              itemId: cleanItemId,
              ownerUserId: dto.ownerUserId,
            },
          },
          null,
          session,
        );

        return followDoc;
      },
    );

    return {
      body: await this.toFollowUpDto(savedFollowUp, actor),
      etag: formatFollowUpEtag(
        savedFollowUp._id.toHexString(),
        savedFollowUp.version,
      ),
    };
  }

  async listHandoverFollowUps(
    projectId: string,
    handoverId: string,
    query: Record<string, unknown>,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<FollowUpListDto>> {
    const actor = await this.resolveActor(projectId, headers, false);
    const handover = await this.loadHandoverOrNotFound(actor, handoverId);
    const { cursor, limit } = parseListPagination(query);

    const scope = {
      organizationId: handover.organizationId,
      projectId: handover.projectId,
    };
    const ownedCount = await this.repository.followUps.countDocuments({
      schemaVersion: 2,
      handoverId: handover._id,
      ...scope,
      ownerUserId: actor.userId,
    });
    const caps = resolveHandoverCapabilities({
      actorUserId: actor.userId,
      isProjectMember: actor.isProjectMember,
      isProjectLeader: actor.isProjectLeader,
      handover,
      packageAcceptedByCurrentSuccessor: false,
      isFollowUpOwner: ownedCount > 0,
    });
    if (!caps.includes('FOLLOW_UP')) {
      throw new ForbiddenException({
        code: 'HANDOVER_FORBIDDEN',
        message: 'Not authorized to read follow-ups for this handover.',
        details: {},
      });
    }

    const filter: Record<string, unknown> = {
      schemaVersion: 2,
      handoverId: handover._id,
      ...scope,
    };
    const isLeader = actor.isProjectLeader;
    const isCurrentSucc =
      handover.successorUserId?.toLowerCase() === actor.userId.toLowerCase();
    if (!isLeader && !isCurrentSucc) {
      filter.ownerUserId = actor.userId;
    }
    if (cursor) {
      filter._id = { $lt: this.decodeCursor(cursor) };
    }

    const rows = await this.repository.followUps
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean<StoredFollowUpDoc[]>()
      .exec();

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && pageRows.length > 0
        ? this.encodeCursor(pageRows[pageRows.length - 1]._id)
        : null;

    // Cursor follows scanned rows, including restricted rows, so a filtered
    // empty page can still lead to readable follow-ups on subsequent pages.
    const projected = await Promise.all(
      pageRows.map(async (row) => {
        try {
          return await this.toFollowUpDto(row, actor);
        } catch (error) {
          if (error instanceof ForbiddenException) return null;
          throw error;
        }
      }),
    );

    return {
      body: {
        data: projected.filter((row): row is FollowUpDto => row !== null),
        nextCursor,
      },
      etag: formatHandoverEtag(handover._id.toHexString(), handover.version),
    };
  }

  async resolveHandoverFollowUp(
    projectId: string,
    handoverId: string,
    followupId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<FollowUpDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const cleanFollowupId = assertHexId(followupId, 'followupId');
    // Independent follow-up ETag, NOT parent handover ETag!
    const expectedFollowUpVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover-followup',
      cleanFollowupId,
    );
    const dto = validateResolveFollowUp(rawBody);

    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);
    // SEC-BE-017: Allow historical follow-up resolution on OPEN and COMPLETED handovers,
    // but block mutations when the parent handover has been CANCELLED.
    if (handover.status === 'CANCELLED') {
      throw new ConflictException({
        code: 'HANDOVER_CANCELLED',
        message: 'Cannot resolve follow-up for a cancelled handover.',
        details: {},
      });
    }
    const scope = {
      organizationId: handover.organizationId,
      projectId: handover.projectId,
    };
    const followUp = await this.repository.followUps
      .findOne({
        _id: new Types.ObjectId(cleanFollowupId),
        handoverId: handover._id,
        ...scope,
        schemaVersion: 2,
      })
      .lean<StoredFollowUpDoc>()
      .exec();

    if (!followUp) {
      throw new NotFoundException({
        code: 'FOLLOW_UP_NOT_FOUND',
        message: 'Handover follow-up not found.',
        details: {},
      });
    }

    const canResolve =
      actor.isProjectMember &&
      (actor.isProjectLeader ||
        followUp.ownerUserId.toLowerCase() === actor.userId.toLowerCase());
    if (!canResolve) {
      throw new ForbiddenException({
        code: 'FOLLOW_UP_FORBIDDEN',
        message:
          'Only the assigned follow-up owner or an active Project Leader may resolve this follow-up.',
        details: {},
      });
    }

    const namespace = `followup:${followUp._id.toHexString()}`;
    await this.assertFollowUpReadable(actor, followUp);
    const fingerprint = computeCommandFingerprint({
      operation: 'resolveHandoverFollowUp',
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      resourceScope: namespace,
      expectedVersion: expectedFollowUpVersion,
      payload: dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      namespace,
      key: idempotencyKey,
    });
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED'
    ) {
      const freshFollowUp = await this.repository.followUps
        .findOne({ _id: followUp._id, ...scope, schemaVersion: 2 })
        .lean<StoredFollowUpDoc>()
        .exec();
      const target = freshFollowUp ?? followUp;
      const ver = existingOp?.receipt?.resourceVersion ?? target.version;
      return {
        body: await this.toFollowUpDto({ ...target, version: ver }, actor),
        etag: formatFollowUpEtag(target._id.toHexString(), ver),
        replayed: true,
      };
    }

    if (followUp.version !== expectedFollowUpVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Follow-up ETag version conflict.',
        details: {},
      });
    }
    if (followUp.status === 'RESOLVED') {
      throw new ConflictException({
        code: 'FOLLOW_UP_ALREADY_RESOLVED',
        message: 'Follow-up is already resolved.',
        details: {},
      });
    }

    if (dto.references.length > 0) {
      const evalMap = await this.sourcesService.evaluateSourceRefsMap(
        {
          organizationId: actor.organizationId,
          projectId: actor.projectId,
          userId: actor.userId,
          isProjectMember: actor.isProjectMember,
          isProjectLeader: actor.isProjectLeader,
        },
        dto.references,
      );
      for (const ref of dto.references) {
        const ev = evalMap.get(sourceRefKey(ref));
        if (!ev || !ev.eligible || !ev.readable) {
          throw new UnprocessableEntityException({
            code: 'INVALID_FOLLOW_UP_REFERENCE',
            message:
              'One or more follow-up source references are invalid or inaccessible.',
            details: { sourceKind: ref.kind, sourceId: ref.id },
          });
        }
      }
    }

    const updatedFollowUp = await this.repository.withTransaction(
      async (session) => {
        const nextVer = expectedFollowUpVersion + 1;
        const now = new Date();
        const upd = await this.repository.followUps
          .findOneAndUpdate(
            {
              _id: followUp._id,
              ...scope,
              status: 'OPEN',
              version: expectedFollowUpVersion,
            },
            {
              $set: {
                status: 'RESOLVED',
                resolvedAt: now,
                resolvedBy: actor.userId,
                resolutionNote: dto.resolutionNote.trim(),
                version: nextVer,
              },
            },
            { new: true, session },
          )
          .lean<StoredFollowUpDoc>()
          .exec();

        if (!upd) {
          throw new ConflictException({
            code: 'VERSION_CONFLICT',
            message: 'Concurrent follow-up update detected.',
            details: {},
          });
        }

        await this.repository.createOrClaimCommandOperation(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            handoverId: handover._id,
            actorUserId: actor.userId,
            namespace,
            key: idempotencyKey,
            fingerprint,
            expectedVersion: expectedFollowUpVersion,
            receipt: {
              resourceId: followUp._id,
              resourceVersion: nextVer,
              followUpId: followUp._id,
              outcome: 'FOLLOW_UP_RESOLVED',
            },
          },
          session,
        );

        await this.repository.appendAuditAndOutbox(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            actorUserId: actor.userId,
            action: 'handover.followup.resolved',
            targetResource: 'handover_followup',
            targetResourceId: followUp._id.toHexString(),
            metadata: {
              handoverId: handover._id.toHexString(),
              parentStatus: handover.status,
              version: nextVer,
            },
          },
          null,
          session,
        );

        return upd;
      },
    );

    return {
      body: await this.toFollowUpDto(updatedFollowUp, actor),
      etag: formatFollowUpEtag(
        updatedFollowUp._id.toHexString(),
        updatedFollowUp.version,
      ),
    };
  }

  async completeHandover(
    projectId: string,
    handoverId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<ReceiptDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );
    const dto = validateCompleteRequest(rawBody);
    this.assertLeaderAuthority(actor);

    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);
    const namespace = `handover:${handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'completeHandover',
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      resourceScope: namespace,
      expectedVersion,
      payload: dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      namespace,
      key: idempotencyKey,
    });
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED'
    ) {
      const ver = existingOp?.receipt?.resourceVersion ?? handover.version;
      return {
        body: this.toReceiptDto({
          operationId: idempotencyKey,
          handover: { ...handover, status: 'COMPLETED' },
          versionOverride: ver,
          revisionIdOverride: existingOp?.receipt?.revisionId ?? null,
          replayed: true,
        }),
        etag: formatHandoverEtag(handover._id.toHexString(), ver),
        replayed: true,
      };
    }

    if (handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Only an OPEN handover can be completed.',
        details: { status: handover.status },
      });
    }
    if (handover.version !== expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Handover aggregate version conflict.',
        details: {},
      });
    }
    if (
      !handover.publishedRevisionId ||
      handover.publishedRevisionId.toHexString() !== dto.revisionId
    ) {
      throw new ConflictException({
        code: 'STALE_REVISION_REFERENCE',
        message: 'revisionId does not match the current published revision.',
        details: {},
      });
    }
    if (handover.assignmentVersion !== dto.assignmentVersion) {
      throw new ConflictException({
        code: 'ASSIGNMENT_EPOCH_MISMATCH',
        message: 'assignmentVersion does not match current successor epoch.',
        details: {},
      });
    }
    if (!handover.successorUserId) {
      throw new ConflictException({
        code: 'COMPLETION_BLOCKED',
        message: 'Cannot complete handover without an assigned successor B.',
        details: { blockers: [{ code: 'SUCCESSOR_NOT_ASSIGNED' }] },
      });
    }

    // Verify successor B is currently an eligible active project member
    try {
      await this.iamScope.assertEligibleActiveProjectMember(
        actor.organizationId,
        actor.projectId,
        handover.successorUserId,
        'SUCCESSOR_NOT_ELIGIBLE',
      );
    } catch {
      throw new ConflictException({
        code: 'COMPLETION_BLOCKED',
        message: 'Assigned successor B is no longer an active project member.',
        details: { blockers: [{ code: 'SUCCESSOR_NOT_ELIGIBLE' }] },
      });
    }

    const scope = {
      organizationId: handover.organizationId,
      projectId: handover.projectId,
    };
    const revision = await this.repository.revisions
      .findOne({
        _id: handover.publishedRevisionId,
        handoverId: handover._id,
        ...scope,
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

    // Reconcile committed transfer receipts against current Task state before evaluating completion (A10).
    // If a transferred task was reassigned to C, persist CONFLICT on the transfer ledger without overwriting C.
    if (revision.selectedTasks.length > 0) {
      await this.transferService.reverifyCurrentRevisionTransfers({
        organizationId: actor.organizationId,
        projectId: actor.projectId,
        handover,
        revisionId: revision._id,
        successorUserId: handover.successorUserId,
      });
    }

    const [
      acceptances,
      evidences,
      evidenceReviews,
      followUps,
      transfers,
      children,
      successorScope,
      liveTaskStateMap,
    ] = await Promise.all([
      this.repository.acceptances
        .find({ handoverId: handover._id, revisionId: revision._id, ...scope })
        .lean<StoredAcceptanceDoc[]>()
        .exec(),
      this.repository.evidences
        .find({ handoverId: handover._id, revisionId: revision._id, ...scope })
        .lean<StoredEvidenceDoc[]>()
        .exec(),
      this.repository.evidenceReviews
        .find({ handoverId: handover._id, revisionId: revision._id, ...scope })
        .lean<StoredEvidenceReviewDoc[]>()
        .exec(),
      this.repository.followUps
        .find({
          schemaVersion: 2,
          handoverId: handover._id,
          revisionId: revision._id,
          ...scope,
        })
        .lean<StoredFollowUpDoc[]>()
        .exec(),
      this.repository.operations
        .find({ handoverId: handover._id, ...scope, kind: 'TASK_TRANSFER' })
        .lean<StoredOperationDoc[]>()
        .exec(),
      this.repository.operations
        .find({
          handoverId: handover._id,
          ...scope,
          kind: 'TASK_TRANSFER_CHILD',
        })
        .lean<StoredOperationDoc[]>()
        .exec(),
      this.iamScope.resolveActiveProjectMemberScope(
        actor.organizationId,
        actor.projectId,
        handover.successorUserId,
      ),
      revision.selectedTasks.length > 0
        ? this.taskAssignmentService.inspectTasksCurrentState(
            actor.organizationId,
            actor.projectId,
            revision.selectedTasks.map((t) => t.taskId.toHexString()),
          )
        : Promise.resolve(undefined),
    ]);

    const provenance = await this.bindLegacyBundleDependencies(
      handover._id,
      revision.items,
      scope,
    );
    const allDeps = provenance.items.flatMap(collectItemDependencyRefs);
    const completionViewers: HandoverSourceViewer[] = [
      {
        organizationId: actor.organizationId,
        projectId: actor.projectId,
        userId: actor.userId,
        isProjectMember: actor.isProjectMember,
        isProjectLeader: actor.isProjectLeader,
      },
    ];
    if (successorScope.isProjectMember) {
      completionViewers.push({
        organizationId: actor.organizationId,
        projectId: actor.projectId,
        userId: handover.successorUserId,
        isProjectMember: successorScope.isProjectMember,
        isProjectLeader: successorScope.isProjectLeader,
      });
    }
    const [leaderSourceMap, maybeSuccessorSourceMap] =
      await this.evaluateSourceRefsForViewers(completionViewers, allDeps);
    const successorSourceMap =
      maybeSuccessorSourceMap ?? new Map<string, EvaluatedHandoverSource>();

    const evaluation = evaluateCompletionReadiness({
      handover,
      currentRevision: { ...revision, items: provenance.items },
      acceptances,
      evidences,
      evidenceReviews,
      followUps,
      transferOperations: transfers,
      transferChildOperations: children,
      leaderSourceMap,
      successorSourceMap,
      liveTaskStateMap,
    });

    const blockers = [...evaluation.blockers];
    if (provenance.unverified.size) {
      blockers.push({ code: 'REQUIRED_ITEM_DEPENDENCY_UNAVAILABLE' });
    }
    if (!successorScope.isProjectMember) {
      blockers.push({ code: 'SUCCESSOR_INACTIVE_IN_PROJECT' });
    }

    if (blockers.length > 0 || !evaluation.canComplete) {
      throw new ConflictException({
        code: 'COMPLETION_BLOCKED',
        message: 'Handover completion conditions are not satisfied.',
        details: {
          requiredPendingCount: evaluation.requiredPendingCount,
          blockers,
        },
      });
    }

    const nextVersion = await this.repository.withTransaction(
      async (session) => {
        const nextVer = expectedVersion + 1;
        const now = new Date();
        const upd = await this.repository.handovers.updateOne(
          {
            _id: handover._id,
            ...scope,
            status: 'OPEN',
            version: expectedVersion,
            publishedRevisionId: revision._id,
            assignmentVersion: dto.assignmentVersion,
          },
          {
            $set: {
              status: 'COMPLETED',
              completedAt: now,
              completedBy: actor.userId,
              completionReviewNote: dto.reviewNote.trim(),
              version: nextVer,
            },
          },
          { session },
        );
        if (upd.matchedCount !== 1) {
          throw new ConflictException({
            code: 'VERSION_CONFLICT',
            message: 'Concurrent handover version or status update detected.',
            details: {},
          });
        }

        await this.repository.createOrClaimCommandOperation(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            handoverId: handover._id,
            actorUserId: actor.userId,
            namespace,
            key: idempotencyKey,
            fingerprint,
            expectedVersion,
            receipt: {
              resourceId: handover._id,
              resourceVersion: nextVer,
              revisionId: revision._id,
              outcome: 'COMPLETED',
            },
          },
          session,
        );

        await this.repository.appendAuditAndOutbox(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            actorUserId: actor.userId,
            action: 'handover.completed',
            targetResource: 'handover',
            targetResourceId: handover._id.toHexString(),
            metadata: {
              revisionId: revision._id.toHexString(),
              assignmentVersion: handover.assignmentVersion,
            },
          },
          {
            eventName: 'handover.completed',
            aggregateType: 'handover',
            aggregateId: handover._id.toHexString(),
            payload: {
              revisionId: revision._id.toHexString(),
              version: nextVer,
            },
          },
          session,
        );

        return nextVer;
      },
    );

    return {
      body: {
        operationId: idempotencyKey,
        handoverId: handover._id.toHexString(),
        version: nextVersion,
        status: 'COMPLETED',
        revisionId: revision._id.toHexString(),
        replayed: false,
      },
      etag: formatHandoverEtag(handover._id.toHexString(), nextVersion),
    };
  }

  async cancelHandover(
    projectId: string,
    handoverId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<ReceiptDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );
    const dto = validateCancelRequest(rawBody);
    this.assertLeaderAuthority(actor);

    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);
    const namespace = `handover:${handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'cancelHandover',
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      resourceScope: namespace,
      expectedVersion,
      payload: dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      namespace,
      key: idempotencyKey,
    });
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED'
    ) {
      const ver = existingOp?.receipt?.resourceVersion ?? handover.version;
      return {
        body: this.toReceiptDto({
          operationId: idempotencyKey,
          handover: { ...handover, status: 'CANCELLED' },
          versionOverride: ver,
          revisionIdOverride: existingOp?.receipt?.revisionId ?? null,
          replayed: true,
        }),
        etag: formatHandoverEtag(handover._id.toHexString(), ver),
        replayed: true,
      };
    }

    if (handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Only an OPEN handover can be cancelled.',
        details: { status: handover.status },
      });
    }
    if (handover.version !== expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Handover aggregate version conflict.',
        details: {},
      });
    }
    await this.assertNoTaskTransferFence(handover);
    const scope = {
      organizationId: handover.organizationId,
      projectId: handover.projectId,
    };

    const nextVersion = await this.repository.withTransaction(
      async (session) => {
        const nextVer = expectedVersion + 1;
        const now = new Date();
        // Cancel preserves all history, sources, revisions, and committed Task assignments (Scenario A14)
        const upd = await this.repository.handovers.updateOne(
          {
            _id: handover._id,
            ...scope,
            status: 'OPEN',
            version: expectedVersion,
          },
          {
            $set: {
              status: 'CANCELLED',
              cancelledAt: now,
              cancelledBy: actor.userId,
              cancellationReason: dto.reason.trim(),
              version: nextVer,
            },
          },
          { session },
        );
        if (upd.matchedCount !== 1) {
          throw new ConflictException({
            code: 'VERSION_CONFLICT',
            message: 'Concurrent handover version or status update detected.',
            details: {},
          });
        }

        await this.repository.jobs.updateMany(
          { handoverId: handover._id, ...scope, state: 'PENDING' },
          {
            $set: {
              state: 'CANCELLED',
              safeErrorCode: 'HANDOVER_CANCELLED',
              finishedAt: now,
            },
          },
          { session },
        );

        await this.repository.createOrClaimCommandOperation(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            handoverId: handover._id,
            actorUserId: actor.userId,
            namespace,
            key: idempotencyKey,
            fingerprint,
            expectedVersion,
            receipt: {
              resourceId: handover._id,
              resourceVersion: nextVer,
              ...(handover.publishedRevisionId
                ? { revisionId: handover.publishedRevisionId }
                : {}),
              outcome: 'CANCELLED',
            },
          },
          session,
        );

        await this.repository.appendAuditAndOutbox(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            actorUserId: actor.userId,
            action: 'handover.cancelled',
            targetResource: 'handover',
            targetResourceId: handover._id.toHexString(),
            metadata: { version: nextVer },
          },
          {
            eventName: 'handover.cancelled',
            aggregateType: 'handover',
            aggregateId: handover._id.toHexString(),
            payload: { version: nextVer },
          },
          session,
        );

        return nextVer;
      },
    );

    return {
      body: {
        operationId: idempotencyKey,
        handoverId: handover._id.toHexString(),
        version: nextVersion,
        status: 'CANCELLED',
        revisionId: handover.publishedRevisionId
          ? handover.publishedRevisionId.toHexString()
          : null,
        replayed: false,
      },
      etag: formatHandoverEtag(handover._id.toHexString(), nextVersion),
    };
  }

  // --- AI & Job Delegations ---

  async proposeHandoverSources(
    projectId: string,
    handoverId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<JobDto>> {
    const actor = await this.resolveActor(projectId, headers, true, 'ai');
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );
    const dto = validateSourceJobRequest(rawBody);
    this.assertLeaderAuthority(actor);
    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);

    const res = await this.aiService.proposeSources({
      actor,
      handover,
      expectedVersion,
      idempotencyKey,
      dto,
    });
    return {
      body: res.job,
      etag: formatHandoverEtag(handover._id.toHexString(), res.version),
      replayed: res.replayed,
    };
  }

  async generateHandoverDraft(
    projectId: string,
    handoverId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<JobDto>> {
    const actor = await this.resolveActor(projectId, headers, true, 'ai');
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );
    const dto = validateGenerateRequest(rawBody);
    this.assertLeaderAuthority(actor);
    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);

    const res = await this.aiService.generateDraft({
      actor,
      handover,
      expectedVersion,
      idempotencyKey,
      dto,
    });
    return {
      body: res.job,
      etag: formatHandoverEtag(handover._id.toHexString(), res.version),
      replayed: res.replayed,
    };
  }

  async getHandoverJob(
    projectId: string,
    handoverId: string,
    jobId: string,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<JobDto>> {
    const actor = await this.resolveActor(projectId, headers, false);
    const cleanJobId = assertHexId(jobId, 'jobId');
    const handover = await this.loadHandoverOrNotFound(actor, handoverId);
    this.assertLeaderAuthority(actor);

    const job = await this.aiService.getJob({
      actor,
      handover,
      jobId: cleanJobId,
    });
    return {
      body: job,
      etag: formatHandoverEtag(handover._id.toHexString(), handover.version),
    };
  }

  async getHandoverCandidates(
    projectId: string,
    handoverId: string,
    jobId: string,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<SourceCandidatesDto>> {
    const actor = await this.resolveActor(projectId, headers, false);
    const cleanJobId = assertHexId(jobId, 'jobId');
    const handover = await this.loadHandoverOrNotFound(actor, handoverId);
    this.assertLeaderAuthority(actor);

    const candidates = await this.aiService.getCandidates({
      actor,
      handover,
      jobId: cleanJobId,
    });
    return {
      body: candidates,
      etag: formatHandoverEtag(handover._id.toHexString(), handover.version),
    };
  }

  async retryHandoverJob(
    projectId: string,
    handoverId: string,
    jobId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<JobDto>> {
    const actor = await this.resolveActor(projectId, headers, true, 'ai');
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const cleanJobId = assertHexId(jobId, 'jobId');
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );
    const dto = validateRetryJob(rawBody);
    this.assertLeaderAuthority(actor);
    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);

    const res = await this.aiService.retryJob({
      actor,
      handover,
      jobId: cleanJobId,
      expectedVersion,
      idempotencyKey,
      dto,
    });
    return {
      body: res.job,
      etag: formatHandoverEtag(handover._id.toHexString(), res.version),
      replayed: res.replayed,
    };
  }

  async askHandoverQuestion(
    projectId: string,
    handoverId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<HandoverAnswerDto>> {
    // Read-only bounded AI query: requires CSRF + session + READ, NO If-Match or Idempotency-Key!
    const actor = await this.resolveActor(projectId, headers, true, 'ai');
    const dto = validateQuestionRequest(rawBody);
    const handover = await this.loadHandoverOrNotFound(actor, handoverId);

    const answer = await this.aiService.askQuestion({ actor, handover, dto });
    return {
      body: answer,
      etag: formatHandoverEtag(handover._id.toHexString(), handover.version),
    };
  }

  // --- Task Transfer Delegations ---

  async listHandoverTaskTransfers(
    projectId: string,
    handoverId: string,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<{ data: TransferDto[] }>> {
    const actor = await this.resolveActor(projectId, headers, false);
    const handover = await this.loadHandoverOrNotFound(actor, handoverId);
    this.assertLeaderAuthority(actor);

    const data = await this.transferService.listTransfersForHandover(handover);
    return {
      body: { data },
      etag: formatHandoverEtag(handover._id.toHexString(), handover.version),
    };
  }

  async startHandoverTaskTransfer(
    projectId: string,
    handoverId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<TransferDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );
    const dto = validateStartTransfer(rawBody);
    this.assertLeaderAuthority(actor);
    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);

    const res = await this.transferService.startTransfer({
      actor,
      handover,
      expectedVersion,
      idempotencyKey,
      dto,
    });
    return {
      body: res.transfer,
      etag: formatHandoverEtag(handover._id.toHexString(), res.version),
      replayed: res.replayed,
    };
  }

  async getHandoverTaskTransfer(
    projectId: string,
    handoverId: string,
    transferId: string,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<TransferDto>> {
    const actor = await this.resolveActor(projectId, headers, false);
    const cleanTransferId = assertHexId(transferId, 'transferId');
    const handover = await this.loadHandoverOrNotFound(actor, handoverId);
    this.assertLeaderAuthority(actor);

    const transfer = await this.transferService.getTransfer({
      handover,
      transferId: cleanTransferId,
    });
    return {
      body: transfer,
      etag: formatHandoverEtag(handover._id.toHexString(), handover.version),
    };
  }

  async reconcileHandoverTaskTransfer(
    projectId: string,
    handoverId: string,
    transferId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<TransferDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const cleanTransferId = assertHexId(transferId, 'transferId');
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );
    const dto = validateReconcileTransfer(rawBody);
    this.assertLeaderAuthority(actor);
    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);

    const res = await this.transferService.reconcileTransfer({
      actor,
      handover,
      transferId: cleanTransferId,
      expectedVersion,
      idempotencyKey,
      dto,
    });
    return {
      body: res.transfer,
      etag: formatHandoverEtag(handover._id.toHexString(), res.version),
      replayed: res.replayed,
    };
  }

  // --- Streamlined 5-Step Handover Workflow Endpoints ---

  async previewDepartingMember(
    projectId: string,
    query: Record<string, unknown>,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<DepartingMemberPreviewDto>> {
    const actor = await this.resolveActor(projectId, headers, false, 'preview');
    const departingUserId = assertHexId(
      query.departingUserId,
      'departingUserId',
    );
    if (
      !actor.isProjectMember ||
      (!actor.isProjectLeader &&
        actor.userId.toLowerCase() !== departingUserId.toLowerCase())
    ) {
      throw new ForbiddenException({
        code: 'HANDOVER_FORBIDDEN',
        message:
          'Only the departing member or an active Project Leader may preview scope.',
        details: {},
      });
    }

    // SEC-AUTH-009: Unconditionally verify departingUserId is/was a member of this project
    // before reading tasks or enumerating any cross-project memberships.
    await this.iamScope.assertHistoricalDepartingMember(
      actor.organizationId,
      actor.projectId,
      departingUserId,
    );

    let extraTaskIds: string[] = [];
    if (query.handoverId !== undefined) {
      const handoverId = assertHexId(query.handoverId, 'handoverId');
      const handover = await this.loadHandoverOrNotFound(actor, handoverId);
      if (
        handover.departingUserId.toLowerCase() !== departingUserId.toLowerCase()
      ) {
        throw new NotFoundException({
          code: 'HANDOVER_NOT_FOUND',
          message: 'Handover not found.',
          details: {},
        });
      }
      extraTaskIds = handover.selectedTasks.map((task) =>
        task.taskId.toHexString(),
      );
    }

    const viewer: HandoverSourceViewer = {
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      userId: actor.userId,
      isProjectMember: actor.isProjectMember,
      isProjectLeader: actor.isProjectLeader,
    };

    const [relatedProjectsRaw, tasks] = await Promise.all([
      typeof this.iamScope.listDepartingMemberProjects === 'function'
        ? this.iamScope.listDepartingMemberProjects(actor, departingUserId)
        : Promise.resolve([]),
      typeof this.taskAssignmentService.listDepartingMemberTasksForHandover ===
      'function'
        ? this.taskAssignmentService.listDepartingMemberTasksForHandover(
            actor.organizationId,
            actor.projectId,
            departingUserId,
            extraTaskIds,
          )
        : Promise.resolve([]),
    ]);

    // SEC-AUTH-009: Resolve actor membership per related project and omit ALL
    // projects where the actor is not an active member so private projects are never enumerated.
    const resolvedRelatedScopes = await Promise.all(
      relatedProjectsRaw.map(async (project) => {
        const pid = project.projectId;
        const scope =
          pid.toLowerCase() === actor.projectId.toLowerCase()
            ? viewer
            : {
                ...viewer,
                projectId: pid,
                ...(await this.iamScope.resolveActiveProjectMemberScope(
                  actor.organizationId,
                  pid,
                  actor.userId,
                )),
              };
        return { project, scope };
      }),
    );
    const accessibleRelated = resolvedRelatedScopes.filter(
      ({ scope }) => scope.isProjectMember === true,
    );
    const memberProjectIds = accessibleRelated.map(
      ({ project }) => project.projectId,
    );

    const [taskCountsMap, scopeResult] = await Promise.all([
      memberProjectIds.length > 0
        ? this.taskAssignmentService.countDepartingMemberActiveTasksByProjects(
            actor.organizationId,
            memberProjectIds,
            departingUserId,
          )
        : Promise.resolve(new Map<string, number>()),
      this.sourcesService.discoverDepartingMemberFullScope(
        viewer,
        departingUserId,
        tasks.map((task) => task.id),
        50,
      ),
    ]);

    const relatedProjects = await Promise.all(
      accessibleRelated.map(async ({ project, scope }) => {
        const pid = project.projectId;
        const sources =
          pid.toLowerCase() === actor.projectId.toLowerCase()
            ? scopeResult.sources
            : (
                await this.sourcesService.discoverDepartingMemberFullScope(
                  scope,
                  departingUserId,
                )
              ).sources;
        return {
          ...project,
          unfinishedTaskCount: taskCountsMap.get(pid) ?? 0,
          taskNoteCount: sources.filter((source) => source.kind === 'TASK_NOTE')
            .length,
          documentCount: sources.filter(
            (source) => source.kind === 'PROJECT_DOCUMENT',
          ).length,
          workReportCount: sources.filter(
            (source) => source.kind === 'WORK_REPORT',
          ).length,
        };
      }),
    );

    return {
      body: {
        departingUserId,
        projectId: actor.projectId,
        relatedProjects,
        tasks,
        sources: scopeResult.sources,
      },
    };
  }

  async autoBundleAndPublish(
    projectId: string,
    handoverId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<HandoverDetailDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const dto = validateAutoBundleRequest(rawBody);
    this.assertLeaderAuthority(actor);

    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );

    const namespace = `handover:${handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'autoBundleAndPublish',
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      resourceScope: namespace,
      expectedVersion,
      payload: dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      namespace,
      key: idempotencyKey,
    });
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED'
    ) {
      const detail = await this.getHandover(
        projectId,
        cleanHandoverId,
        headers,
      );
      return {
        ...detail,
        replayed: true,
      };
    }

    if (handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Cannot auto-bundle a closed handover.',
        details: {},
      });
    }
    if (handover.version !== expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Handover aggregate version conflict.',
        details: {},
      });
    }
    const scope = {
      organizationId: handover.organizationId,
      projectId: handover.projectId,
    };
    await this.assertNoTaskTransferFence(handover);

    // 1. Resolve tasks for handover
    const selectedTasks: StoredHandoverTaskRef[] = [];
    const taskDescriptions: string[] = [];
    if (dto.taskIds !== undefined) {
      for (const taskId of dto.taskIds) {
        const taskInfo =
          await this.taskAssignmentService.verifyProjectTaskExists(
            actor.organizationId,
            actor.projectId,
            taskId,
          );
        if (
          !taskInfo.exists ||
          taskInfo.version === null ||
          taskInfo.assigneeId?.toLowerCase() !==
            handover.departingUserId.toLowerCase() ||
          taskInfo.status === 'DONE' ||
          taskInfo.status === 'CANCELLED'
        ) {
          throw new UnprocessableEntityException({
            code: 'TASK_NOT_IN_HANDOVER_SELECTION',
            message:
              'Refresh the preview and select unfinished tasks of the departing member.',
            details: { taskId },
          });
        }
        selectedTasks.push({
          taskId: new Types.ObjectId(taskId),
          expectedVersion: taskInfo.version,
          expectedAssigneeId: taskInfo.assigneeId,
        });
        taskDescriptions.push(
          `- Task ${taskId.slice(-6).toUpperCase()} (${taskInfo.status})`,
        );
      }
    } else if (
      typeof this.taskAssignmentService.listDepartingMemberTasksForHandover ===
      'function'
    ) {
      const discoveredTasks =
        await this.taskAssignmentService.listDepartingMemberTasksForHandover(
          actor.organizationId,
          actor.projectId,
          handover.departingUserId,
        );
      for (const t of discoveredTasks) {
        if (t.status !== 'DONE' && t.status !== 'CANCELLED') {
          selectedTasks.push({
            taskId: new Types.ObjectId(t.id),
            expectedVersion: t.version,
            expectedAssigneeId: t.assigneeId,
          });
          taskDescriptions.push(
            `- **[${t.key}]** ${t.title} (\`${t.status}\` · ${t.priority})`,
          );
        }
      }
    }

    // 2. Resolve sources for handover
    const viewer: HandoverSourceViewer = {
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      userId: actor.userId,
      isProjectMember: actor.isProjectMember,
      isProjectLeader: actor.isProjectLeader,
    };

    const normalizedSelectedSources: SourceRefDto[] = [];

    if (dto.selectedSources !== undefined) {
      const map = await this.sourcesService.evaluateSourceRefsMap(
        viewer,
        dto.selectedSources,
      );
      for (const src of dto.selectedSources) {
        const verNum = parseSourceVersionNumber(src.version);
        const ev = map.get(sourceRefKey(src));
        if (verNum && ev && ev.eligible && ev.readable && ev.isCurrent) {
          const ref: SourceRefDto = {
            kind: src.kind,
            id: src.id.toLowerCase(),
            version: String(verNum),
          };
          normalizedSelectedSources.push(ref);
        }
      }
    } else if (
      typeof this.sourcesService.discoverDepartingMemberFullScope === 'function'
    ) {
      const discovered =
        await this.sourcesService.discoverDepartingMemberFullScope(
          viewer,
          handover.departingUserId,
          selectedTasks.map((t) => t.taskId.toHexString()),
          50,
        );
      for (const src of discovered.sources) {
        const ref: SourceRefDto = {
          kind: src.kind,
          id: src.id.toLowerCase(),
          version: src.version,
        };
        const ev = discovered.evaluatedMap.get(sourceRefKey(ref));
        if (ev && ev.eligible && ev.readable && ev.isCurrent) {
          normalizedSelectedSources.push(ref);
        }
      }
    }

    const successorScope = handover.successorUserId
      ? await this.iamScope.resolveActiveProjectMemberScope(
          actor.organizationId,
          actor.projectId,
          handover.successorUserId,
        )
      : { isProjectMember: false, isProjectLeader: false };

    const successorSourceMap =
      handover.successorUserId && successorScope.isProjectMember
        ? await this.sourcesService.evaluateSourceRefsMap(
            {
              ...viewer,
              ...successorScope,
              userId: handover.successorUserId,
            },
            normalizedSelectedSources,
          )
        : new Map<string, EvaluatedHandoverSource>();
    const itemSources: SourceRefDto[] = [];
    const itemCitations: CitationDto[] = [];
    const sourceLines: string[] = [];

    for (const ref of normalizedSelectedSources) {
      const source = successorSourceMap.get(sourceRefKey(ref));
      const excerpt = source?.excerpts[0];
      if (
        !source?.eligible ||
        !source.readable ||
        !source.isCurrent ||
        !excerpt ||
        itemSources.length === 50
      )
        continue;
      itemSources.push(ref);
      itemCitations.push({
        source: ref,
        locator: { kind: excerpt.locatorKind, value: excerpt.locatorValue },
      });
      const snippet = excerpt.content.replace(/\s+/g, ' ').trim().slice(0, 220);
      sourceLines.push(
        `- **[${ref.kind} v${ref.version}]** ${source.title}: ${snippet}`,
      );
    }

    const bodySections: string[] = [
      `### Tổng hợp gói bàn giao: ${handover.title}`,
      '\nGói bàn giao được tổng hợp từ các nguồn hiện người nhận có quyền đọc.',
    ];
    if (taskDescriptions.length > 0) {
      bodySections.push(
        `\n#### Công việc cần tiếp nhận (${taskDescriptions.length})\n${taskDescriptions.join('\n')}`,
      );
    }
    if (sourceLines.length > 0) {
      bodySections.push(
        `\n#### Nguồn tài liệu & Tri thức liên quan (${sourceLines.length})\n${sourceLines.join('\n')}`,
      );
    }

    const itemId = new Types.ObjectId();
    const itemSnapshot: StoredHandoverItemSnapshot = {
      itemId,
      contentVersion: 1,
      dependencyFingerprint: computeDependencyFingerprint({
        sources: itemSources,
        citations: itemCitations,
        isRequired: true,
        evidenceRequired: false,
      }),
      title: `Tổng hợp công việc & tri thức bàn giao — ${handover.title}`.slice(
        0,
        255,
      ),
      body: bodySections.join('\n').slice(0, 19500),
      requirement:
        'Người tiếp nối (Successor) xác nhận đã nắm bắt danh sách công việc chưa hoàn thành và các nguồn tài liệu bàn giao.',
      isRequired: true,
      evidenceRequired: false,
      sources: itemSources,
      citations: itemCitations,
    };

    const latestRev = await this.repository.revisions
      .findOne({ handoverId: handover._id, ...scope })
      .sort({ number: -1 })
      .select({ number: 1 })
      .lean<{ number: number }>()
      .exec();
    const nextRevisionNumber = (latestRev?.number ?? 0) + 1;
    const now = new Date();
    const revisionId = new Types.ObjectId();
    const nextDraftVer = handover.draftVersion + 1;
    const sourceFp = computeSourceSelectionFingerprint(
      normalizedSelectedSources,
    );

    const revisionDocToInsert = {
      _id: revisionId,
      schemaVersion: 2 as const,
      organizationId: handover.organizationId,
      projectId: handover.projectId,
      handoverId: handover._id,
      number: nextRevisionNumber,
      draftVersion: nextDraftVer,
      assignmentVersion: handover.assignmentVersion,
      successorUserId: handover.successorUserId,
      items: [itemSnapshot],
      selectedSources: normalizedSelectedSources,
      selectedTasks,
      reviews: [
        {
          itemId,
          contentVersion: 1,
          decision: 'CONTENT_APPROVED' as const,
          impact: 'CHANGED' as const,
          reason: 'Tự động tổng hợp và xuất bản theo luồng bàn giao 5 bước.',
        },
      ],
      gaps: [],
      publishedBy: actor.userId,
      publishedAt: now,
      sourceFingerprint: sourceFp,
      reviewNote: 'Tự động tổng hợp phạm vi công việc & tri thức bàn giao.',
      createdAt: now,
    };

    this.repository.assertRevisionSnapshotWithinLimit(revisionDocToInsert);

    await this.repository.withTransaction(async (session) => {
      const nextVer = expectedVersion + 1;
      const upd = await this.repository.handovers.updateOne(
        {
          _id: handover._id,
          ...scope,
          status: 'OPEN',
          version: expectedVersion,
        },
        {
          $set: {
            version: nextVer,
            draftVersion: nextDraftVer,
            publishedRevisionId: revisionId,
            selectedSources: normalizedSelectedSources,
            selectedTasks,
          },
        },
        { session },
      );
      if (upd.matchedCount !== 1) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          message: 'Concurrent handover version update detected.',
          details: {},
        });
      }

      await this.repository.draftItems.deleteMany(
        { handoverId: handover._id, ...scope, schemaVersion: 2 },
        { session },
      );
      await this.repository.draftItems.create(
        [
          {
            ...itemSnapshot,
            schemaVersion: 2 as const,
            organizationId: handover.organizationId,
            projectId: handover.projectId,
            handoverId: handover._id,
            updatedBy: actor.userId,
          },
        ],
        { session },
      );

      await this.repository.revisions.create([revisionDocToInsert], {
        session,
      });

      await this.repository.createOrClaimCommandOperation(
        {
          organizationId: actor.organizationId,
          projectId: actor.projectId,
          handoverId: handover._id,
          actorUserId: actor.userId,
          namespace,
          key: idempotencyKey,
          fingerprint,
          expectedVersion,
          receipt: {
            resourceId: handover._id,
            resourceVersion: nextVer,
            revisionId,
            outcome: SAFE_AUTO_BUNDLE,
          },
        },
        session,
      );

      await this.repository.appendAuditAndOutbox(
        {
          organizationId: actor.organizationId,
          projectId: actor.projectId,
          actorUserId: actor.userId,
          action: 'handover.revision.published',
          targetResource: 'handover_revision',
          targetResourceId: revisionId.toHexString(),
          metadata: {
            handoverId: handover._id.toHexString(),
            revisionNumber: nextRevisionNumber,
            taskCount: selectedTasks.length,
            sourceCount: normalizedSelectedSources.length,
            mode: 'auto_bundle',
          },
        },
        {
          eventName: 'handover.revision.published',
          aggregateType: 'handover',
          aggregateId: handover._id.toHexString(),
          payload: {
            revisionId: revisionId.toHexString(),
            revisionNumber: nextRevisionNumber,
          },
        },
        session,
      );
    });

    return this.getHandover(projectId, cleanHandoverId, headers);
  }

  async quickAcceptHandover(
    projectId: string,
    handoverId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<HandoverDetailDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const dto = validateQuickAcceptRequest(rawBody);

    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);
    if (
      !actor.isProjectMember ||
      !handover.successorUserId ||
      handover.successorUserId.toLowerCase() !== actor.userId
    ) {
      throw new ForbiddenException({
        code: 'RECIPIENT_ONLY_OPERATION',
        message:
          'Only the currently assigned successor B may accept this handover package.',
        details: {},
      });
    }

    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );

    const namespace = `handover:${handover._id.toHexString()}`;
    const fingerprint = computeCommandFingerprint({
      operation: 'quickAcceptHandover',
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      resourceScope: namespace,
      expectedVersion,
      payload: dto,
    });

    const existingOp = await this.repository.findExistingOperation({
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      namespace,
      key: idempotencyKey,
    });
    if (
      this.repository.assertIdempotencyMatchOrReplay(
        existingOp,
        fingerprint,
      ) === 'REPLAY_COMMITTED'
    ) {
      const detail = await this.getHandover(
        projectId,
        cleanHandoverId,
        headers,
      );
      return {
        ...detail,
        replayed: true,
      };
    }

    if (handover.status !== 'OPEN') {
      throw new ConflictException({
        code: 'HANDOVER_NOT_OPEN',
        message: 'Handover acceptance requires an OPEN handover.',
        details: {},
      });
    }
    if (handover.version !== expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Handover aggregate version conflict.',
        details: {},
      });
    }
    if (!handover.publishedRevisionId) {
      throw new ConflictException({
        code: 'NO_PUBLISHED_REVISION',
        message: 'Handover does not have a published package yet.',
        details: {},
      });
    }

    const scope = {
      organizationId: handover.organizationId,
      projectId: handover.projectId,
    };
    const revision = await this.repository.revisions
      .findOne({
        _id: handover.publishedRevisionId,
        handoverId: handover._id,
        ...scope,
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

    await this.assertNoTaskTransferFence(handover);
    const [bundleReceipt, priorAcceptances] = await Promise.all([
      this.repository.operations
        .findOne({
          handoverId: handover._id,
          ...scope,
          kind: 'COMMAND',
          'receipt.revisionId': revision._id,
          'receipt.outcome': SAFE_AUTO_BUNDLE,
        })
        .lean<StoredOperationDoc>()
        .exec(),
      this.repository.acceptances
        .find({
          handoverId: handover._id,
          ...scope,
          revisionId: revision._id,
          assignmentVersion: handover.assignmentVersion,
          successorUserId: actor.userId,
        })
        .lean<StoredAcceptanceDoc[]>()
        .exec(),
    ]);
    const summary =
      bundleReceipt && revision.items.length === 1 ? revision.items[0] : null;
    const dependencies = summary ? collectItemDependencyRefs(summary) : [];
    const sourceMap = await this.sourcesService.evaluateSourceRefsMap(
      actor,
      dependencies,
    );
    const canAcknowledgeSummary =
      summary &&
      !summary.evidenceRequired &&
      priorAcceptances.every(
        (acceptance) => acceptance.itemId?.equals(summary.itemId) !== true,
      ) &&
      dependencies.every((ref) => {
        const source = sourceMap.get(sourceRefKey(ref));
        return source?.eligible && source.readable && source.isCurrent;
      });
    const itemsToAcknowledge =
      summary && canAcknowledgeSummary ? [summary] : [];

    const noteText =
      dto.note?.trim() || 'Đã tiếp nhận và nắm rõ nội dung bàn giao.';

    await this.repository.withTransaction(async (session) => {
      const nextVer = expectedVersion + 1;
      const upd = await this.repository.handovers.updateOne(
        {
          _id: handover._id,
          ...scope,
          status: 'OPEN',
          version: expectedVersion,
          successorUserId: actor.userId,
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

      const seqPkg = await this.repository.nextSequence(
        'handover_acceptances',
        {
          ...scope,
          handoverId: handover._id,
          revisionId: revision._id,
          successorUserId: actor.userId,
          assignmentVersion: handover.assignmentVersion,
        },
        session,
      );

      const now = new Date();
      const acceptanceDocs: Array<Record<string, unknown>> = [
        {
          _id: new Types.ObjectId(),
          schemaVersion: 2,
          organizationId: handover.organizationId,
          projectId: handover.projectId,
          handoverId: handover._id,
          revisionId: revision._id,
          successorUserId: actor.userId,
          assignmentVersion: handover.assignmentVersion,
          kind: 'PACKAGE',
          decision: 'ACCEPTED',
          note: noteText,
          commandId: new Types.ObjectId(),
          sequence: seqPkg,
          occurredAt: now,
        },
      ];

      for (const item of itemsToAcknowledge) {
        const seqItem = await this.repository.nextSequence(
          'handover_acceptances',
          {
            ...scope,
            handoverId: handover._id,
            revisionId: revision._id,
            successorUserId: actor.userId,
            assignmentVersion: handover.assignmentVersion,
            itemId: item.itemId,
          },
          session,
        );
        acceptanceDocs.push({
          _id: new Types.ObjectId(),
          schemaVersion: 2,
          organizationId: handover.organizationId,
          projectId: handover.projectId,
          handoverId: handover._id,
          revisionId: revision._id,
          successorUserId: actor.userId,
          assignmentVersion: handover.assignmentVersion,
          kind: 'ITEM',
          itemId: item.itemId,
          contentVersion: item.contentVersion,
          dependencyFingerprint: item.dependencyFingerprint,
          decision: 'UNDERSTOOD',
          note: noteText,
          commandId: new Types.ObjectId(),
          sequence: seqItem,
          occurredAt: now,
        });
      }

      await this.repository.acceptances.create(acceptanceDocs, {
        session,
        ordered: true,
      });

      await this.repository.createOrClaimCommandOperation(
        {
          organizationId: actor.organizationId,
          projectId: actor.projectId,
          handoverId: handover._id,
          actorUserId: actor.userId,
          namespace,
          key: idempotencyKey,
          fingerprint,
          expectedVersion,
          receipt: {
            resourceId: handover._id,
            resourceVersion: nextVer,
            revisionId: revision._id,
            outcome: 'QUICK_ACCEPTED',
          },
        },
        session,
      );

      await this.repository.appendAuditAndOutbox(
        {
          organizationId: actor.organizationId,
          projectId: actor.projectId,
          actorUserId: actor.userId,
          action: 'handover.package.accepted',
          targetResource: 'handover',
          targetResourceId: handover._id.toHexString(),
          metadata: {
            revisionId: revision._id.toHexString(),
            assignmentVersion: handover.assignmentVersion,
            itemCount: itemsToAcknowledge.length,
            mode: 'quick_accept',
          },
        },
        {
          eventName: 'handover.package.accepted',
          aggregateType: 'handover',
          aggregateId: handover._id.toHexString(),
          payload: {
            revisionId: revision._id.toHexString(),
            successorUserId: actor.userId,
          },
        },
        session,
      );
    });

    return this.getHandover(projectId, cleanHandoverId, headers);
  }

  async quickTransferHandoverTasks(
    projectId: string,
    handoverId: string,
    rawBody: unknown,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<TransferDto>> {
    const actor = await this.resolveActor(projectId, headers, true);
    const idempotencyKey = validateIdempotencyKeyHeader(headers.idempotencyKey);
    const cleanHandoverId = assertHexId(handoverId, 'handoverId');
    const dto = validateQuickTransferRequest(rawBody);
    this.assertLeaderAuthority(actor);

    const handover = await this.loadHandoverOrNotFound(actor, cleanHandoverId);
    const expectedVersion = parseRequiredIfMatch(
      headers.ifMatch,
      'handover',
      cleanHandoverId,
    );

    const res = await this.transferService.quickTransferTasks({
      actor,
      handover,
      expectedVersion,
      idempotencyKey,
      taskIds: dto.taskIds,
    });
    return {
      body: res.transfer,
      etag: formatHandoverEtag(handover._id.toHexString(), res.version),
      replayed: res.replayed,
    };
  }
}
