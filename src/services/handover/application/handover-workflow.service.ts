import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
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
  DraftItemDto,
  DraftProjectionDto,
  EvidenceReceiptDto,
  FollowUpDto,
  FollowUpListDto,
  HandoverAnswerDto,
  HandoverDetailDto,
  HandoverListDto,
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
  validateCancelRequest,
  validateCompleteRequest,
  validateCreateHandover,
  validateDraftRequest,
  validateGenerateRequest,
  validateIdempotencyKeyHeader,
  validateOptionalException,
  validatePublishRequest,
  validateQuestionRequest,
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
  ) {}

  private async resolveActor(
    projectId: string,
    headers: HandoverRequestHeaders,
    requireCsrf: boolean,
  ): Promise<HandoverProjectActorContext> {
    if (requireCsrf) {
      this.iamScope.assertValidCsrf(headers.cookie, headers.csrfToken);
    }
    const identity = await this.iamScope.authenticateActor(
      headers.authorization,
      headers.cookie,
    );
    return this.iamScope.resolveProjectActorContext({
      actor: identity,
      projectId,
      organizationHeader: headers.organizationId,
    });
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

  private toFollowUpDto(doc: StoredFollowUpDoc): FollowUpDto {
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
    handoverId: Types.ObjectId,
  ): Promise<void> {
    const pendingTransfers = await this.repository.operations
      .find({
        handoverId,
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
    if (!actor.isProjectMember) {
      throw new ForbiddenException({
        code: 'HANDOVER_FORBIDDEN',
        message: 'Active project membership is required to read handovers.',
        details: {},
      });
    }

    const { cursor, limit } = parseListPagination(query);
    const orgObj = new Types.ObjectId(actor.organizationId);
    const projObj = new Types.ObjectId(actor.projectId);

    const mongoFilter: Record<string, unknown> = {
      schemaVersion: 2,
      organizationId: orgObj,
      projectId: projObj,
    };

    if (!actor.isProjectLeader) {
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
        .findOne({ _id: existingOp.receipt.resourceId })
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
      dto.successorUserId === dto.departingUserId
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

    const created = await this.repository.withTransaction(async (session) => {
      const handoverId = new Types.ObjectId();
      try {
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
      } catch (err: unknown) {
        if ((err as { code?: number })?.code === 11000) {
          throw new ConflictException({
            code: 'OPEN_HANDOVER_ALREADY_EXISTS',
            message:
              'An OPEN handover already exists for this departing member in this project.',
            details: {},
          });
        }
        throw err;
      }
    });

    return {
      body: this.toReceiptDto({
        operationId: idempotencyKey,
        handover: created,
        replayed: false,
      }),
      etag: formatHandoverEtag(created._id.toHexString(), created.version),
    };
  }

  private async buildRevisionProjectionAndReadiness(input: {
    viewer: HandoverProjectActorContext;
    handover: StoredHandoverDoc;
    revision: StoredRevisionDoc;
    isCurrent: boolean;
  }): Promise<{
    projection: RevisionProjectionDto;
    requiredPendingCount: number;
    canComplete: boolean;
    packageAccepted: boolean;
  }> {
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
        })
        .lean<StoredAcceptanceDoc[]>()
        .exec(),
      this.repository.evidences
        .find({
          handoverId: input.handover._id,
          revisionId: input.revision._id,
        })
        .lean<StoredEvidenceDoc[]>()
        .exec(),
      this.repository.evidenceReviews
        .find({
          handoverId: input.handover._id,
          revisionId: input.revision._id,
        })
        .lean<StoredEvidenceReviewDoc[]>()
        .exec(),
      this.repository.followUps
        .find({
          schemaVersion: 2,
          handoverId: input.handover._id,
          revisionId: input.revision._id,
        })
        .lean<StoredFollowUpDoc[]>()
        .exec(),
      this.repository.operations
        .find({
          handoverId: input.handover._id,
          kind: 'TASK_TRANSFER',
        })
        .lean<StoredOperationDoc[]>()
        .exec(),
      this.repository.operations
        .find({
          handoverId: input.handover._id,
          kind: 'TASK_TRANSFER_CHILD',
        })
        .lean<StoredOperationDoc[]>()
        .exec(),
    ]);

    const allItemDeps: SourceRefDto[] = [];
    for (const item of input.revision.items) {
      allItemDeps.push(...collectItemDependencyRefs(item));
    }

    const viewerCtx: HandoverSourceViewer = {
      organizationId: input.viewer.organizationId,
      projectId: input.viewer.projectId,
      userId: input.viewer.userId,
      isProjectMember: input.viewer.isProjectMember,
      isProjectLeader: input.viewer.isProjectLeader,
    };

    const leaderCtx: HandoverSourceViewer = {
      organizationId: input.viewer.organizationId,
      projectId: input.viewer.projectId,
      userId: input.handover.assignedLeaderId,
      isProjectMember: true,
      isProjectLeader: true,
    };

    let successorMemberActive = false;
    if (input.handover.successorUserId) {
      try {
        await this.iamScope.assertEligibleActiveProjectMember(
          input.viewer.organizationId,
          input.viewer.projectId,
          input.handover.successorUserId,
        );
        successorMemberActive = true;
      } catch {
        successorMemberActive = false;
      }
    }

    const [viewerSourceMap, leaderSourceMap, successorSourceMap] =
      await Promise.all([
        this.sourcesService.evaluateSourceRefsMap(viewerCtx, allItemDeps),
        this.sourcesService.evaluateSourceRefsMap(leaderCtx, allItemDeps),
        input.handover.successorUserId && successorMemberActive
          ? this.sourcesService.evaluateSourceRefsMap(
              {
                organizationId: input.viewer.organizationId,
                projectId: input.viewer.projectId,
                userId: input.handover.successorUserId,
                isProjectMember: true,
                isProjectLeader: false,
              },
              allItemDeps,
            )
          : Promise.resolve(new Map<string, EvaluatedHandoverSource>()),
      ]);

    const reviewByItem = new Map(
      input.revision.reviews.map((r) => [r.itemId.toHexString(), r]),
    );

    const projectedItems = input.revision.items.map((item) => {
      const itemHex = item.itemId.toHexString();
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
      currentRevision: input.isCurrent ? input.revision : null,
      acceptances,
      evidences,
      evidenceReviews,
      followUps,
      transferOperations: transfers,
      transferChildOperations: children,
      leaderSourceMap,
      successorSourceMap,
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
      canComplete: successorMemberActive && readiness.canComplete,
      packageAccepted: readiness.packageAccepted,
    };
  }

  async getHandover(
    projectId: string,
    handoverId: string,
    headers: HandoverRequestHeaders,
  ): Promise<HttpPayloadWithHeaders<HandoverDetailDto>> {
    const actor = await this.resolveActor(projectId, headers, false);
    const handover = await this.loadHandoverOrNotFound(actor, handoverId);

    const ownedFollowUpCount = await this.repository.followUps.countDocuments({
      schemaVersion: 2,
      handoverId: handover._id,
      ownerUserId: actor.userId,
    });

    let publishedRevision: RevisionProjectionDto | null = null;
    let requiredPendingCount = 0;
    let canComplete = false;
    let packageAccepted = false;

    if (handover.publishedRevisionId) {
      const revDoc = await this.repository.revisions
        .findOne({
          _id: handover.publishedRevisionId,
          handoverId: handover._id,
        })
        .lean<StoredRevisionDoc>()
        .exec();

      if (revDoc) {
        const built = await this.buildRevisionProjectionAndReadiness({
          viewer: actor,
          handover,
          revision: revDoc,
          isCurrent: true,
        });
        publishedRevision = built.projection;
        requiredPendingCount = built.requiredPendingCount;
        canComplete = built.canComplete;
        packageAccepted = built.packageAccepted;
      }
    }

    const capabilities = resolveHandoverCapabilities({
      actorUserId: actor.userId,
      isProjectMember: actor.isProjectMember,
      isProjectLeader: actor.isProjectLeader,
      handover,
      packageAcceptedByCurrentSuccessor: packageAccepted,
      isFollowUpOwner: ownedFollowUpCount > 0,
    });

    if (!capabilities.includes('READ')) {
      throw new NotFoundException({
        code: 'HANDOVER_NOT_FOUND',
        message: 'Handover not found.',
        details: {},
      });
    }

    return {
      body: {
        handover: this.toSummaryDto(handover),
        publishedRevision,
        capabilities,
        requiredPendingCount,
        canComplete,
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
      ownerUserId: actor.userId,
    });
    const caps = resolveHandoverCapabilities({
      actorUserId: actor.userId,
      isProjectMember: actor.isProjectMember,
      isProjectLeader: actor.isProjectLeader,
      handover,
      packageAcceptedByCurrentSuccessor: false,
      isFollowUpOwner: ownedFollowUpCount > 0,
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
          { _id: handover._id, status: 'OPEN', version: expectedVersion },
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
    await this.assertNoTaskTransferFence(handover._id);

    if (
      dto.successorUserId !== null &&
      dto.successorUserId === handover.departingUserId
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
          { _id: handover._id, status: 'OPEN', version: expectedVersion },
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
          { _id: handover._id, status: 'OPEN', version: expectedVersion },
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

    const draftDocs = await this.repository.draftItems
      .find({ handoverId: handover._id, schemaVersion: 2 })
      .sort({ _id: 1 })
      .lean<StoredDraftItemDoc[]>()
      .exec();

    const allSources = [
      ...handover.selectedSources,
      ...draftDocs.flatMap((d) => collectItemDependencyRefs(d)),
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
    const visibleItems: DraftItemDto[] = draftDocs
      .filter((d) =>
        collectItemDependencyRefs(d).every((dep) => {
          const ev = evalMap.get(sourceRefKey(dep));
          return Boolean(ev && ev.eligible && ev.readable);
        }),
      )
      .map((d) => ({
        itemId: d.itemId.toHexString(),
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

    const existingDraftDocs = await this.repository.draftItems
      .find({ handoverId: handover._id, schemaVersion: 2 })
      .lean<StoredDraftItemDoc[]>()
      .exec();
    const existingById = new Map<string, StoredHandoverItemSnapshot>(
      existingDraftDocs.map((d) => [d.itemId.toHexString(), d]),
    );
    if (handover.publishedRevisionId) {
      const pubRev = await this.repository.revisions
        .findOne({ _id: handover.publishedRevisionId })
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
          contentVersion = hasMeaningfulDraftItemChange(prev, inputItem)
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
          { handoverId: handover._id, schemaVersion: 2 },
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
    await this.assertNoTaskTransferFence(handover._id);

    const draftDocs = await this.repository.draftItems
      .find({ handoverId: handover._id, schemaVersion: 2 })
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

    // Reverify current source eligibility & readability for the publishing Leader
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
    const leaderSourceMap = await this.sourcesService.evaluateSourceRefsMap(
      leaderViewer,
      allPublishRefs,
    );
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
        .findOne({ _id: handover.publishedRevisionId })
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
          })
          .lean<StoredAcceptanceDoc[]>()
          .exec();
      }
    }

    const successorSourceMap = handover.successorUserId
      ? await this.sourcesService.evaluateSourceRefsMap(
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            userId: handover.successorUserId,
            isProjectMember: true,
            isProjectLeader: false,
          },
          allPublishRefs,
        )
      : new Map<string, EvaluatedHandoverSource>();

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
      .findOne({ handoverId: handover._id })
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

    const revision = await this.repository.revisions
      .findOne({ _id: handover.publishedRevisionId, handoverId: handover._id })
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

    const deps = collectItemDependencyRefs(targetItem);
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
      .findOne({ evidenceId: evidence._id })
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

    const revision = await this.repository.revisions
      .findOne({ _id: handover.publishedRevisionId, handoverId: handover._id })
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

    const deps = collectItemDependencyRefs(targetItem);
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
        .findOne({ _id: existingOp.receipt.resourceId })
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

    const revision = await this.repository.revisions
      .findOne({ _id: handover.publishedRevisionId, handoverId: handover._id })
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

    const deps = collectItemDependencyRefs(targetItem);
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

    const [revision, evidenceDoc] = await Promise.all([
      this.repository.revisions
        .findOne({
          _id: handover.publishedRevisionId,
          handoverId: handover._id,
        })
        .lean<StoredRevisionDoc>()
        .exec(),
      this.repository.evidences
        .findOne({
          _id: new Types.ObjectId(cleanEvidenceId),
          handoverId: handover._id,
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

    const deps = collectItemDependencyRefs(targetItem);
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
          { _id: handover._id, status: 'OPEN', version: expectedVersion },
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
        .findOne({ _id: existingOp.receipt.followUpId, schemaVersion: 2 })
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
        body: this.toFollowUpDto(existingFollowUp),
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

    const revision = await this.repository.revisions
      .findOne({ _id: handover.publishedRevisionId, handoverId: handover._id })
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
          { _id: handover._id, status: 'OPEN', version: expectedVersion },
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
              { _id: existingFollow._id },
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
      body: this.toFollowUpDto(savedFollowUp),
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

    const ownedCount = await this.repository.followUps.countDocuments({
      schemaVersion: 2,
      handoverId: handover._id,
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
    };
    const isLeader = actor.isProjectLeader;
    const isCurrentSucc =
      handover.successorUserId?.toLowerCase() === actor.userId;
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

    return {
      body: {
        data: pageRows.map((r) => this.toFollowUpDto(r)),
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
    const followUp = await this.repository.followUps
      .findOne({
        _id: new Types.ObjectId(cleanFollowupId),
        handoverId: handover._id,
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
        followUp.ownerUserId.toLowerCase() === actor.userId);
    if (!canResolve) {
      throw new ForbiddenException({
        code: 'FOLLOW_UP_FORBIDDEN',
        message:
          'Only the assigned follow-up owner or an active Project Leader may resolve this follow-up.',
        details: {},
      });
    }

    const namespace = `followup:${followUp._id.toHexString()}`;
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
        .findOne({ _id: followUp._id, schemaVersion: 2 })
        .lean<StoredFollowUpDoc>()
        .exec();
      const target = freshFollowUp ?? followUp;
      const ver = existingOp?.receipt?.resourceVersion ?? target.version;
      return {
        body: this.toFollowUpDto({ ...target, version: ver }),
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
      body: this.toFollowUpDto(updatedFollowUp),
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

    const revision = await this.repository.revisions
      .findOne({ _id: handover.publishedRevisionId, handoverId: handover._id })
      .lean<StoredRevisionDoc>()
      .exec();
    if (!revision) {
      throw new NotFoundException({
        code: 'REVISION_NOT_FOUND',
        message: 'Published revision not found.',
        details: {},
      });
    }

    const [
      acceptances,
      evidences,
      evidenceReviews,
      followUps,
      transfers,
      children,
    ] = await Promise.all([
      this.repository.acceptances
        .find({ handoverId: handover._id, revisionId: revision._id })
        .lean<StoredAcceptanceDoc[]>()
        .exec(),
      this.repository.evidences
        .find({ handoverId: handover._id, revisionId: revision._id })
        .lean<StoredEvidenceDoc[]>()
        .exec(),
      this.repository.evidenceReviews
        .find({ handoverId: handover._id, revisionId: revision._id })
        .lean<StoredEvidenceReviewDoc[]>()
        .exec(),
      this.repository.followUps
        .find({
          schemaVersion: 2,
          handoverId: handover._id,
          revisionId: revision._id,
        })
        .lean<StoredFollowUpDoc[]>()
        .exec(),
      this.repository.operations
        .find({ handoverId: handover._id, kind: 'TASK_TRANSFER' })
        .lean<StoredOperationDoc[]>()
        .exec(),
      this.repository.operations
        .find({ handoverId: handover._id, kind: 'TASK_TRANSFER_CHILD' })
        .lean<StoredOperationDoc[]>()
        .exec(),
    ]);

    const allDeps = revision.items.flatMap((it) =>
      collectItemDependencyRefs(it),
    );
    const [leaderSourceMap, successorSourceMap] = await Promise.all([
      this.sourcesService.evaluateSourceRefsMap(
        {
          organizationId: actor.organizationId,
          projectId: actor.projectId,
          userId: actor.userId,
          isProjectMember: actor.isProjectMember,
          isProjectLeader: actor.isProjectLeader,
        },
        allDeps,
      ),
      this.sourcesService.evaluateSourceRefsMap(
        {
          organizationId: actor.organizationId,
          projectId: actor.projectId,
          userId: handover.successorUserId,
          isProjectMember: true,
          isProjectLeader: false,
        },
        allDeps,
      ),
    ]);

    const evaluation = evaluateCompletionReadiness({
      handover,
      currentRevision: revision,
      acceptances,
      evidences,
      evidenceReviews,
      followUps,
      transferOperations: transfers,
      transferChildOperations: children,
      leaderSourceMap,
      successorSourceMap,
    });

    if (!evaluation.canComplete) {
      throw new ConflictException({
        code: 'COMPLETION_BLOCKED',
        message: 'Handover completion conditions are not satisfied.',
        details: {
          requiredPendingCount: evaluation.requiredPendingCount,
          blockers: evaluation.blockers,
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
    await this.assertNoTaskTransferFence(handover._id);

    const nextVersion = await this.repository.withTransaction(
      async (session) => {
        const nextVer = expectedVersion + 1;
        const now = new Date();
        // Cancel preserves all history, sources, revisions, and committed Task assignments (Scenario A14)
        const upd = await this.repository.handovers.updateOne(
          { _id: handover._id, status: 'OPEN', version: expectedVersion },
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
          { handoverId: handover._id, state: 'PENDING' },
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
    const actor = await this.resolveActor(projectId, headers, true);
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
    const actor = await this.resolveActor(projectId, headers, true);
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

    const job = await this.aiService.getJob({ handover, jobId: cleanJobId });
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
    const actor = await this.resolveActor(projectId, headers, true);
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
    const actor = await this.resolveActor(projectId, headers, true);
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
}
