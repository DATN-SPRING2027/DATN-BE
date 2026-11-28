import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { Connection, type ClientSession, type Model, Types } from 'mongoose';
import {
  AI_ENGINE_CLIENT,
  type AiEngineClient,
} from '../../../integrations/ai-engine/ai-engine.port';
import { CHAT_PERSISTENCE } from '../infrastructure/persistence';
import {
  CHAT_ASSISTANT_JOBS_COLLECTION,
  CONTINUUM_AI_DISPLAY_NAME,
  CONTINUUM_AI_HANDLE,
  CONTINUUM_AI_SENDER_ID,
} from '../infrastructure/mongodb/mongodb.schemas';
import {
  enrichSourceReferences,
  type AssistantJobDocument,
  type MessageDocument,
} from '../infrastructure/mongodb/mongo-chat.repository';
import { ChatHistoryCacheInvalidator } from './chat-history-cache';
import { ChatRealtimeService } from './chat-realtime.service';
import type { ChatMessage } from './chat.repository';
import {
  CHAT_ORG_MEMBERSHIP_CHECKER,
  computeSourceAggregateState,
  DM_ASSISTANT_SAG_ANSWER_PATH,
  isDmAssistantWorkerEnabled,
  readBoundedInt,
  type AssistantStatusEvent,
  type ChatAssistantFailureCode,
  type ChatAssistantPostedStatus,
  type ChatAssistantStatus,
  type ChatOrgMembershipChecker,
  type SagDmAssistantAnswerRequest,
  type SagDmAssistantAnswerResponse,
} from './chat-dm-assistant.types';
import {
  DmAssistantRetrievalService,
  type DmAssistantRetrievalResult,
  type RetrievedMessageSnapshot,
} from './chat-dm-assistant-retrieval.service';

const MODEL_PREFIX = `${CHAT_PERSISTENCE.databaseName}_`;
const MAX_COMMIT_TX_ATTEMPTS = 3;

interface ConversationRecord {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  type: 'DIRECT' | 'ROOM';
  status: 'ACTIVE' | 'ARCHIVED';
  contextRevision?: number;
  lastMessageAt?: Date | null;
}

interface MemberRecord {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  conversationId: Types.ObjectId;
  userId: string;
  status: 'ACTIVE' | 'LEFT';
  notificationMode?: 'ALL' | 'MENTIONS' | 'NONE';
}

export type DmAssistantWorkerTickOutcome =
  | 'IDLE'
  | 'COMPLETED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'CANCELLED'
  | 'RETRY_SCHEDULED'
  | 'FAILED'
  | 'LEASE_LOST';

export interface DmAssistantWorkerTickResult {
  outcome: DmAssistantWorkerTickOutcome;
  jobId?: string;
  failureCode?: ChatAssistantFailureCode | null;
  responseMessageId?: string | null;
}

class InvalidModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidModelOutputError';
  }
}

class RevisionFenceConflictError extends Error {
  constructor() {
    super('Conversation contextRevision changed concurrently.');
    this.name = 'RevisionFenceConflictError';
  }
}

class CommitConflictExhaustedError extends Error {
  constructor() {
    super('Exceeded maximum commit transaction revision retries.');
    this.name = 'CommitConflictExhaustedError';
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

function isMongoWriteConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as {
    code?: unknown;
    codeName?: unknown;
    errorLabels?: unknown;
  };
  if (err.code === 112 || err.codeName === 'WriteConflict') return true;
  if (
    Array.isArray(err.errorLabels) &&
    err.errorLabels.includes('TransientTransactionError')
  ) {
    return true;
  }
  return false;
}

function extractHttpErrorCode(error: unknown): string | undefined {
  if (!(error instanceof HttpException)) return undefined;
  const response = error.getResponse();
  if (typeof response === 'object' && response !== null && 'code' in response) {
    const code = (response as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function validateSagResponse(
  raw: unknown,
  validRefIds: ReadonlySet<string>,
): SagDmAssistantAnswerResponse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidModelOutputError(
      'SAG response body is not a JSON object.',
    );
  }
  const obj = raw as Record<string, unknown>;
  const status = obj.status;
  if (status !== 'ANSWERED' && status !== 'INSUFFICIENT_EVIDENCE') {
    throw new InvalidModelOutputError('SAG response has invalid status.');
  }
  if (typeof obj.answerText !== 'string') {
    throw new InvalidModelOutputError(
      'SAG response answerText must be a string.',
    );
  }
  const answerText = obj.answerText.trim();
  if (answerText.length < 1 || answerText.length > 4000) {
    throw new InvalidModelOutputError(
      'SAG response answerText length out of bounds.',
    );
  }
  if (!Array.isArray(obj.citedRefIds) || obj.citedRefIds.length > 20) {
    throw new InvalidModelOutputError('SAG response citedRefIds is invalid.');
  }
  const citedRefIds: string[] = [];
  const seen = new Set<string>();
  for (const item of obj.citedRefIds) {
    if (typeof item !== 'string' || !validRefIds.has(item)) {
      throw new InvalidModelOutputError('SAG response cited unknown refId.');
    }
    if (!seen.has(item)) {
      seen.add(item);
      citedRefIds.push(item);
    }
  }
  const coverageNote =
    obj.coverageNote === null || obj.coverageNote === undefined
      ? null
      : typeof obj.coverageNote === 'string'
        ? obj.coverageNote.trim().slice(0, 500) || null
        : null;
  const model =
    obj.model === null || obj.model === undefined
      ? null
      : typeof obj.model === 'string'
        ? obj.model.trim().slice(0, 120) || null
        : null;
  const rawUsage =
    obj.usage && typeof obj.usage === 'object'
      ? (obj.usage as Record<string, unknown>)
      : {};
  const toNonNegInt = (val: unknown) => {
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  };
  const usage = {
    inputTokens: toNonNegInt(rawUsage.inputTokens),
    cachedTokens: toNonNegInt(rawUsage.cachedTokens),
    outputTokens: toNonNegInt(rawUsage.outputTokens),
    totalTokens: toNonNegInt(rawUsage.totalTokens),
    calls: toNonNegInt(rawUsage.calls),
  };

  if (status === 'INSUFFICIENT_EVIDENCE') {
    return {
      status: 'INSUFFICIENT_EVIDENCE',
      answerText,
      citedRefIds: [],
      coverageNote,
      model,
      usage,
    };
  }

  if (citedRefIds.length === 0) {
    return {
      status: 'INSUFFICIENT_EVIDENCE',
      answerText,
      citedRefIds: [],
      coverageNote,
      model,
      usage,
    };
  }

  return {
    status: 'ANSWERED',
    answerText,
    citedRefIds,
    coverageNote,
    model,
    usage,
  };
}

@Injectable()
export class ChatDmAssistantWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ChatDmAssistantWorkerService.name);
  private readonly jobsModel?: Model<AssistantJobDocument>;
  private readonly messagesModel?: Model<MessageDocument>;
  private readonly conversationsModel?: Model<ConversationRecord>;
  private readonly membersModel?: Model<MemberRecord>;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxContextMessages: number;
  private readonly maxContextChars: number;
  private retryBaseDelayOverrideMs?: number;
  private pollTimer?: NodeJS.Timeout;
  private readonly leaseTimers = new Set<NodeJS.Timeout>();
  private destroyed = false;
  private pollingInFlight = false;

  constructor(
    private readonly config: ConfigService,
    private readonly retrieval: DmAssistantRetrievalService,
    @Inject(AI_ENGINE_CLIENT)
    private readonly aiEngine: AiEngineClient,
    @Inject(CHAT_ORG_MEMBERSHIP_CHECKER)
    private readonly orgMembershipChecker: ChatOrgMembershipChecker,
    private readonly historyCache: ChatHistoryCacheInvalidator,
    private readonly realtime: ChatRealtimeService,
    @Optional()
    @InjectConnection(CHAT_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
  ) {
    this.leaseMs = readBoundedInt(
      config.get<unknown>('CHAT_DM_ASSISTANT_LEASE_MS'),
      60_000,
      10_000,
      300_000,
    );
    this.pollIntervalMs = readBoundedInt(
      config.get<unknown>('CHAT_DM_ASSISTANT_POLL_INTERVAL_MS'),
      1_000,
      200,
      60_000,
    );
    this.maxContextMessages = readBoundedInt(
      config.get<unknown>('CHAT_DM_ASSISTANT_MAX_CONTEXT_MESSAGES'),
      80,
      1,
      80,
    );
    this.maxContextChars = readBoundedInt(
      config.get<unknown>('CHAT_DM_ASSISTANT_MAX_CONTEXT_CHARS'),
      24_000,
      1_000,
      24_000,
    );

    if (connection && typeof connection.model === 'function') {
      try {
        this.jobsModel = connection.model<AssistantJobDocument>(
          `${MODEL_PREFIX}${CHAT_ASSISTANT_JOBS_COLLECTION}`,
        );
        this.messagesModel = connection.model<MessageDocument>(
          `${MODEL_PREFIX}chat_conversation_messages`,
        );
        this.conversationsModel = connection.model<ConversationRecord>(
          `${MODEL_PREFIX}chat_conversations`,
        );
        this.membersModel = connection.model<MemberRecord>(
          `${MODEL_PREFIX}chat_members`,
        );
      } catch {
        // Models unavailable when INFRA_ENABLED=false
      }
    }
  }

  setRetryDelayOverrideMs(delayMs: number | undefined): void {
    this.retryBaseDelayOverrideMs = delayMs;
  }

  onModuleInit(): void {
    this.destroyed = false;
    if (!this.connection || !this.jobsModel) return;
    if (!isDmAssistantWorkerEnabled(this.config)) return;
    this.scheduleNextPoll(this.pollIntervalMs);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const timer of this.leaseTimers) {
      clearInterval(timer);
    }
    this.leaseTimers.clear();
  }

  async processNextJobOnce(
    workerIdOverride?: string,
  ): Promise<DmAssistantWorkerTickResult> {
    return this.claimAndProcess(undefined, workerIdOverride);
  }

  async processJobById(
    jobId: string,
    workerIdOverride?: string,
  ): Promise<DmAssistantWorkerTickResult> {
    if (!Types.ObjectId.isValid(jobId)) {
      return { outcome: 'IDLE' };
    }
    return this.claimAndProcess(new Types.ObjectId(jobId), workerIdOverride);
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.destroyed) return;
    this.pollTimer = setTimeout(() => {
      void this.runPollTick();
    }, delayMs);
    this.pollTimer.unref();
  }

  private async runPollTick(): Promise<void> {
    if (this.destroyed || this.pollingInFlight) return;
    this.pollingInFlight = true;
    let processedAny = false;
    try {
      const result = await this.processNextJobOnce();
      processedAny = result.outcome !== 'IDLE';
    } catch (error) {
      this.logger.warn(
        `Chat DM assistant worker poll failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.pollingInFlight = false;
      this.scheduleNextPoll(processedAny ? 50 : this.pollIntervalMs);
    }
  }

  private async reapExhaustedExpiredJobs(): Promise<void> {
    if (!this.jobsModel) return;
    const now = new Date();
    const expired = await this.jobsModel
      .findOneAndUpdate(
        {
          status: 'PROCESSING',
          lockedUntil: { $lte: now },
          $expr: { $gte: ['$attempts', '$maxAttempts'] },
        },
        {
          $set: {
            status: 'FAILED',
            failureCode: 'SERVICE_UNAVAILABLE',
            failureReason: 'Worker lease expired after maximum attempts.',
            completedAt: now,
            lockedBy: null,
            lockedUntil: null,
          },
        },
        { new: true },
      )
      .lean()
      .exec();
    if (!expired) return;
    const orgId = String(expired.organizationId);
    const convId = String(expired.conversationId);
    await this.historyCache.invalidate(orgId, convId);
    const recipients = await this.getActiveMemberIds(
      expired.organizationId,
      expired.conversationId,
    );
    await this.emitAssistantStatus(
      orgId,
      convId,
      recipients,
      expired,
      'FAILED',
      'SERVICE_UNAVAILABLE',
      null,
      now,
    );
  }

  private async claimAndProcess(
    specificJobId?: Types.ObjectId,
    workerIdOverride?: string,
  ): Promise<DmAssistantWorkerTickResult> {
    if (
      !this.connection ||
      !this.jobsModel ||
      !this.messagesModel ||
      !this.conversationsModel ||
      !this.membersModel
    ) {
      return { outcome: 'IDLE' };
    }

    await this.reapExhaustedExpiredJobs();

    const now = new Date();
    const workerLeaseId = (
      workerIdOverride ?? `${os.hostname()}:${process.pid}:${randomUUID()}`
    ).slice(0, 160);
    const lockedUntil = new Date(now.getTime() + this.leaseMs);

    const job = await this.jobsModel
      .findOneAndUpdate(
        {
          ...(specificJobId ? { _id: specificJobId } : {}),
          status: { $in: ['PENDING', 'PROCESSING'] },
          nextAttemptAt: { $lte: now },
          $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
          $expr: { $lt: ['$attempts', '$maxAttempts'] },
        },
        {
          $set: {
            status: 'PROCESSING',
            lockedBy: workerLeaseId,
            lockedUntil,
          },
          $inc: { attempts: 1 },
        },
        {
          sort: { createdAt: 1, _id: 1 },
          new: true,
        },
      )
      .lean()
      .exec();

    if (!job) {
      return { outcome: 'IDLE' };
    }

    const heartbeatIntervalMs = Math.max(1_000, Math.floor(this.leaseMs / 4));
    const leaseTimer = setInterval(() => {
      if (this.destroyed || !this.jobsModel) return;
      void this.jobsModel
        .updateOne(
          {
            _id: job._id,
            status: 'PROCESSING',
            lockedBy: workerLeaseId,
          },
          { $set: { lockedUntil: new Date(Date.now() + this.leaseMs) } },
        )
        .exec()
        .catch(() => undefined);
    }, heartbeatIntervalMs);
    leaseTimer.unref();
    this.leaseTimers.add(leaseTimer);

    try {
      return await this.processClaimedJob(job, workerLeaseId);
    } finally {
      clearInterval(leaseTimer);
      this.leaseTimers.delete(leaseTimer);
    }
  }

  private async processClaimedJob(
    job: AssistantJobDocument,
    workerLeaseId: string,
  ): Promise<DmAssistantWorkerTickResult> {
    const startedAt = Date.now();
    const orgObjId = job.organizationId;
    const convObjId = job.conversationId;
    const triggerObjId = job.triggerMessageId;
    const orgIdStr = String(orgObjId);
    const convIdStr = String(convObjId);

    try {
      // 1. Pre-SAG Guard #1: Fail-closed IAM active organization + user check
      const orgMemberActive =
        await this.orgMembershipChecker.isActiveOrganizationMember(
          orgIdStr,
          job.requesterUserId,
        );
      if (!orgMemberActive) {
        return await this.finalizeCancelledJob(
          job,
          workerLeaseId,
          'ACCESS_REVOKED',
          'Organization membership or account is no longer active.',
        );
      }

      // 2. Pre-SAG Guard #2: Active DIRECT conversation, active requester member, unblocked
      const accessCheck = await this.verifyChatAccess(
        orgObjId,
        convObjId,
        job.requesterUserId,
      );
      if (!accessCheck.allowed || !accessCheck.conversation) {
        return await this.finalizeCancelledJob(
          job,
          workerLeaseId,
          'ACCESS_REVOKED',
          'Conversation access revoked or direct chat blocked.',
          accessCheck.activeMemberIds,
        );
      }

      // Emit PROCESSING status to active DM members
      await this.emitAssistantStatus(
        orgIdStr,
        convIdStr,
        accessCheck.activeMemberIds,
        job,
        'PROCESSING',
        null,
        null,
        new Date(),
      );

      // 3. Pre-SAG Guard #3: Trigger message must exist, not deleted, and not edited
      const triggerDoc = await this.messagesModel!.findOne({
        _id: triggerObjId,
        organizationId: orgObjId,
        conversationId: convObjId,
      })
        .lean()
        .exec();

      if (!triggerDoc || triggerDoc.deletedAt != null) {
        return await this.finalizeCancelledJob(
          job,
          workerLeaseId,
          'TRIGGER_DELETED',
          'Trigger message was deleted before processing.',
          accessCheck.activeMemberIds,
        );
      }
      const triggerVersion = triggerDoc.contentVersion ?? 0;
      const triggerEditedAtMs = triggerDoc.editedAt
        ? triggerDoc.editedAt.getTime()
        : null;
      if (triggerVersion > 0 || triggerEditedAtMs !== null) {
        return await this.finalizeCancelledJob(
          job,
          workerLeaseId,
          'SOURCE_CHANGED',
          'Trigger message was edited before processing.',
          accessCheck.activeMemberIds,
        );
      }

      // 4. Snapshot contextRevision BEFORE retrieval so concurrent edits/deletes are caught
      const observedContextRevision =
        accessCheck.conversation.contextRevision ?? 0;

      const retrievalStartedAt = Date.now();
      const retrievalResult = await this.retrieval.retrieveContext(
        {
          organizationId: orgObjId,
          conversationId: convObjId,
          triggerMessageId: triggerObjId,
          triggerCreatedAt: triggerDoc.createdAt,
          question: job.query,
          timezone: job.timezone,
          maxMessages: this.maxContextMessages,
          maxChars: this.maxContextChars,
        },
        this.messagesModel,
      );
      const retrievalLatencyMs = Math.max(
        0,
        Math.round(Date.now() - retrievalStartedAt),
      );

      const snapshotByRefId = new Map<string, RetrievedMessageSnapshot>(
        retrievalResult.messages.map((snap) => [snap.refId, snap]),
      );
      const validRefIds = new Set<string>(snapshotByRefId.keys());

      // 5. Call SAG stateless grounded synthesizer endpoint
      const sagPayload: SagDmAssistantAnswerRequest = {
        question: job.query,
        timezone: job.timezone,
        referenceNowIso: triggerDoc.createdAt.toISOString(),
        queryMode: retrievalResult.queryMode,
        partialCoverage: retrievalResult.partialCoverage,
        coverageHint: retrievalResult.coverageHint,
        messages: retrievalResult.messages.map((snap) => ({
          refId: snap.refId,
          senderLabel: snap.senderName,
          sentAtIso: snap.createdAt.toISOString(),
          text: snap.textForSag,
        })),
      };

      const sagStartedAt = Date.now();
      const sagHttpResponse =
        await this.aiEngine.request<SagDmAssistantAnswerResponse>({
          path: DM_ASSISTANT_SAG_ANSWER_PATH,
          method: 'POST',
          headers: {
            'X-Continuum-Organization-Id': orgIdStr,
            'X-Continuum-User-Id': job.requesterUserId,
            'X-Continuum-Conversation-Id': convIdStr,
            'X-Request-Id': `dm-assistant-${String(job._id)}-a${job.attempts}`,
          },
          body: sagPayload,
        });
      const sagLatencyMs = Math.max(0, Math.round(Date.now() - sagStartedAt));

      const validatedSag = validateSagResponse(
        sagHttpResponse.body,
        validRefIds,
      );

      // 6. Anti-Race Split Commit Transaction Loop (Step 5a fence + Step 5b monotonic lastMessage*)
      return await this.commitAssistantResult({
        job,
        workerLeaseId,
        triggerVersion,
        triggerEditedAtMs,
        observedContextRevision,
        retrievalResult,
        snapshotByRefId,
        sagResponse: validatedSag,
        retrievalLatencyMs,
        sagLatencyMs,
        startedAt,
      });
    } catch (error) {
      return await this.handleProcessingError(job, workerLeaseId, error);
    }
  }

  private async commitAssistantResult(params: {
    job: AssistantJobDocument;
    workerLeaseId: string;
    triggerVersion: number;
    triggerEditedAtMs: number | null;
    observedContextRevision: number;
    retrievalResult: DmAssistantRetrievalResult;
    snapshotByRefId: ReadonlyMap<string, RetrievedMessageSnapshot>;
    sagResponse: SagDmAssistantAnswerResponse;
    retrievalLatencyMs: number;
    sagLatencyMs: number;
    startedAt: number;
  }): Promise<DmAssistantWorkerTickResult> {
    const {
      job,
      workerLeaseId,
      triggerVersion,
      triggerEditedAtMs,
      retrievalResult,
      snapshotByRefId,
      sagResponse,
      retrievalLatencyMs,
      sagLatencyMs,
      startedAt,
    } = params;
    const orgObjId = job.organizationId;
    const convObjId = job.conversationId;
    const triggerObjId = job.triggerMessageId;
    const orgIdStr = String(orgObjId);
    const convIdStr = String(convObjId);

    let currentObservedRevision = params.observedContextRevision;

    type TxOutcome =
      | { kind: 'LEASE_LOST' }
      | {
          kind: 'CANCELLED';
          failureCode: ChatAssistantFailureCode;
          recipientIds: string[];
          updatedAt: Date;
        }
      | {
          kind: 'PUBLISHED';
          status: ChatAssistantPostedStatus;
          aiMessageDoc: MessageDocument;
          recipientIds: string[];
          updatedAt: Date;
        };

    let outcome: TxOutcome | null = null;

    for (
      let txAttempt = 1;
      txAttempt <= MAX_COMMIT_TX_ATTEMPTS;
      txAttempt += 1
    ) {
      // Pre-commit fail-closed IAM check outside continuum_chat transaction
      const orgMemberActive =
        await this.orgMembershipChecker.isActiveOrganizationMember(
          orgIdStr,
          job.requesterUserId,
        );
      if (!orgMemberActive) {
        return await this.finalizeCancelledJob(
          job,
          workerLeaseId,
          'ACCESS_REVOKED',
          'Organization membership or account revoked before publish.',
        );
      }

      const session = await this.connection!.startSession();
      let revisionConflict = false;
      try {
        await session.withTransaction(
          async () => {
            outcome = null;

            // 1. Verify lease ownership
            const liveJob = await this.jobsModel!.findOne({
              _id: job._id,
              status: 'PROCESSING',
              lockedBy: workerLeaseId,
            })
              .session(session)
              .lean()
              .exec();
            if (!liveJob) {
              outcome = { kind: 'LEASE_LOST' };
              return;
            }

            // 2. Re-verify conversation ACTIVE/DIRECT, active requester membership, unblocked
            const access = await this.verifyChatAccess(
              orgObjId,
              convObjId,
              job.requesterUserId,
              session,
            );
            if (!access.allowed || !access.conversation) {
              const now = new Date();
              await this.markJobTerminalInTx(
                job._id,
                workerLeaseId,
                'CANCELLED',
                'ACCESS_REVOKED',
                'Conversation access revoked or blocked before publish.',
                now,
                session,
              );
              outcome = {
                kind: 'CANCELLED',
                failureCode: 'ACCESS_REVOKED',
                recipientIds: access.activeMemberIds,
                updatedAt: now,
              };
              return;
            }

            // 3. Re-verify trigger message (not deleted AND not edited)
            const liveTrigger = await this.messagesModel!.findOne({
              _id: triggerObjId,
              organizationId: orgObjId,
              conversationId: convObjId,
            })
              .session(session)
              .lean()
              .exec();

            if (!liveTrigger || liveTrigger.deletedAt != null) {
              const now = new Date();
              await this.markJobTerminalInTx(
                job._id,
                workerLeaseId,
                'CANCELLED',
                'TRIGGER_DELETED',
                'Trigger message was deleted before publish.',
                now,
                session,
              );
              outcome = {
                kind: 'CANCELLED',
                failureCode: 'TRIGGER_DELETED',
                recipientIds: access.activeMemberIds,
                updatedAt: now,
              };
              return;
            }

            const liveTriggerVersion = liveTrigger.contentVersion ?? 0;
            const liveTriggerEditedMs = liveTrigger.editedAt
              ? liveTrigger.editedAt.getTime()
              : null;
            if (
              liveTriggerVersion !== triggerVersion ||
              liveTriggerEditedMs !== triggerEditedAtMs
            ) {
              const now = new Date();
              await this.markJobTerminalInTx(
                job._id,
                workerLeaseId,
                'CANCELLED',
                'SOURCE_CHANGED',
                'Trigger message was edited before publish.',
                now,
                session,
              );
              outcome = {
                kind: 'CANCELLED',
                failureCode: 'SOURCE_CHANGED',
                recipientIds: access.activeMemberIds,
                updatedAt: now,
              };
              return;
            }

            // 4. Re-verify ALL sentMessages snapshots (not deleted AND not edited)
            if (retrievalResult.messages.length > 0) {
              const sentIds = retrievalResult.messages.map((m) => m.messageId);
              const liveSources = await this.messagesModel!.find(
                {
                  _id: { $in: sentIds },
                  organizationId: orgObjId,
                  conversationId: convObjId,
                },
                { _id: 1, deletedAt: 1, editedAt: 1, contentVersion: 1 },
              )
                .session(session)
                .lean()
                .exec();
              const liveById = new Map(
                liveSources.map((doc) => [String(doc._id), doc]),
              );
              const anySourceChanged = retrievalResult.messages.some((snap) => {
                const live = liveById.get(String(snap.messageId));
                if (!live || live.deletedAt != null) return true;
                if ((live.contentVersion ?? 0) !== snap.sourceVersion) {
                  return true;
                }
                const liveEditedMs = live.editedAt
                  ? live.editedAt.getTime()
                  : null;
                if (liveEditedMs !== snap.sourceEditedAtMs) return true;
                return false;
              });

              if (anySourceChanged) {
                const now = new Date();
                await this.markJobTerminalInTx(
                  job._id,
                  workerLeaseId,
                  'CANCELLED',
                  'SOURCE_CHANGED',
                  'One or more context messages changed during processing.',
                  now,
                  session,
                );
                outcome = {
                  kind: 'CANCELLED',
                  failureCode: 'SOURCE_CHANGED',
                  recipientIds: access.activeMemberIds,
                  updatedAt: now,
                };
                return;
              }
            }

            // 5a. Revision Fence on chat_conversations (write lock eliminates snapshot write-skew)
            const aiCreatedAt = new Date();
            const revisionFilter =
              currentObservedRevision === 0
                ? {
                    $or: [
                      { contextRevision: 0 },
                      { contextRevision: { $exists: false } },
                    ],
                  }
                : { contextRevision: currentObservedRevision };

            const fenceUpdate = await this.conversationsModel!.updateOne(
              {
                _id: convObjId,
                organizationId: orgObjId,
                status: 'ACTIVE',
                ...revisionFilter,
              },
              {
                $inc: { contextRevision: 1 },
                $set: { updatedAt: aiCreatedAt },
              },
              { session },
            ).exec();

            if (fenceUpdate.matchedCount === 0) {
              revisionConflict = true;
              throw new RevisionFenceConflictError();
            }

            // 6. Insert at most 1 AI reply (protected by unique partial index on triggerMessageId)
            const aiStatus: ChatAssistantPostedStatus =
              sagResponse.status === 'ANSWERED'
                ? 'COMPLETED'
                : 'INSUFFICIENT_EVIDENCE';
            const sourceReferences =
              aiStatus === 'COMPLETED'
                ? sagResponse.citedRefIds.map((refId) => {
                    const snap = snapshotByRefId.get(refId)!;
                    return {
                      refId,
                      messageId: snap.messageId,
                      senderName: snap.senderName,
                      createdAt: snap.createdAt,
                      sourceEditedAt:
                        snap.sourceEditedAtMs !== null
                          ? new Date(snap.sourceEditedAtMs)
                          : null,
                      sourceVersion: snap.sourceVersion,
                      quoteSnippet: snap.quoteSnippet,
                    };
                  })
                : [];

            let aiMessageDoc = await this.messagesModel!.findOne({
              organizationId: orgObjId,
              conversationId: convObjId,
              authorType: 'ASSISTANT',
              triggerMessageId: triggerObjId,
            })
              .session(session)
              .lean()
              .exec();

            let insertedFresh = false;
            if (!aiMessageDoc) {
              const [createdAi] = await this.messagesModel!.create(
                [
                  {
                    organizationId: orgObjId,
                    conversationId: convObjId,
                    senderId: CONTINUUM_AI_SENDER_ID,
                    senderName: CONTINUUM_AI_DISPLAY_NAME,
                    senderAvatarUrl: null,
                    clientMessageId: `assistant:${triggerObjId.toHexString()}`,
                    content: sagResponse.answerText,
                    mentionUserIds: [],
                    links: [],
                    isPinned: false,
                    editedAt: null,
                    deletedAt: null,
                    reactions: [],
                    replyToMessageId: triggerObjId,
                    attachments: [],
                    contentVersion: 0,
                    authorType: 'ASSISTANT',
                    triggerMessageId: triggerObjId,
                    assistantStatus: aiStatus,
                    assistantFailureCode: null,
                    assistantMeta: {
                      handle: CONTINUUM_AI_HANDLE,
                      queryMode: retrievalResult.queryMode,
                      partialCoverage: retrievalResult.partialCoverage,
                      coverageNote:
                        sagResponse.coverageNote ??
                        retrievalResult.coverageHint,
                      model: sagResponse.model,
                      promptTokens: Math.max(
                        0,
                        Math.round(sagResponse.usage.inputTokens),
                      ),
                      completionTokens: Math.max(
                        0,
                        Math.round(sagResponse.usage.outputTokens),
                      ),
                    },
                    sourceReferences,
                  },
                ],
                { session },
              );
              aiMessageDoc = createdAi.toObject();
              insertedFresh = true;
            }

            // 5b. Separate monotonic lastMessage* update
            const aiMsgCreatedAt = aiMessageDoc.createdAt ?? aiCreatedAt;
            const lastMessagePreview =
              `${CONTINUUM_AI_DISPLAY_NAME}: ${aiMessageDoc.content}`.slice(
                0,
                180,
              );
            await this.conversationsModel!.updateOne(
              {
                _id: convObjId,
                organizationId: orgObjId,
                $or: [
                  { lastMessageAt: null },
                  { lastMessageAt: { $lte: aiMsgCreatedAt } },
                ],
              },
              {
                $set: {
                  lastMessageId: aiMessageDoc._id,
                  lastMessageAt: aiMsgCreatedAt,
                  lastMessagePreview,
                  lastMessageSenderId: CONTINUUM_AI_SENDER_ID,
                  updatedAt: aiMsgCreatedAt,
                },
              },
              { session },
            ).exec();

            // 7. Mark job COMPLETED / INSUFFICIENT_EVIDENCE + create notifications
            const completedAt = new Date();
            const totalLatencyMs = Math.max(
              0,
              Math.round(Date.now() - startedAt),
            );
            await this.jobsModel!.updateOne(
              {
                _id: job._id,
                status: 'PROCESSING',
                lockedBy: workerLeaseId,
              },
              {
                $set: {
                  status: aiStatus,
                  failureCode: null,
                  failureReason: null,
                  responseMessageId: aiMessageDoc._id,
                  completedAt,
                  lockedBy: null,
                  lockedUntil: null,
                  metrics: {
                    queryMode: retrievalResult.queryMode,
                    retrievalPath: retrievalResult.retrievalPath.slice(0, 64),
                    candidateCount: Math.max(
                      0,
                      Math.round(retrievalResult.candidateCount),
                    ),
                    sentSnippetCount: Math.max(
                      0,
                      Math.round(retrievalResult.messages.length),
                    ),
                    citedCount: Math.max(
                      0,
                      Math.round(sourceReferences.length),
                    ),
                    partialCoverage: retrievalResult.partialCoverage,
                    retrievalLatencyMs,
                    sagLatencyMs,
                    totalLatencyMs,
                  },
                },
              },
              { session },
            ).exec();

            if (insertedFresh) {
              await this.createAssistantNotificationsInTx(
                orgObjId,
                convObjId,
                aiMessageDoc,
                access.activeMembers,
                session,
              );
            }

            outcome = {
              kind: 'PUBLISHED',
              status: aiStatus,
              aiMessageDoc,
              recipientIds: access.activeMemberIds,
              updatedAt: completedAt,
            };
          },
          { writeConcern: { w: 'majority', wtimeoutMS: 5_000 } },
        );
        break;
      } catch (error) {
        if (revisionConflict || isMongoWriteConflict(error)) {
          const refreshed = await this.conversationsModel!.findOne({
            _id: convObjId,
            organizationId: orgObjId,
          })
            .select({ contextRevision: 1 })
            .lean()
            .exec();
          currentObservedRevision = refreshed?.contextRevision ?? 0;
          if (txAttempt === MAX_COMMIT_TX_ATTEMPTS) {
            throw new CommitConflictExhaustedError();
          }
          continue;
        }
        if (isDuplicateKeyError(error)) {
          return await this.reconcileDuplicateAssistantMessage(
            job,
            workerLeaseId,
          );
        }
        throw error;
      } finally {
        await session.endSession();
      }
    }

    if (!outcome) {
      throw new CommitConflictExhaustedError();
    }

    const finalOutcome = outcome as TxOutcome;
    if (finalOutcome.kind === 'LEASE_LOST') {
      return { outcome: 'LEASE_LOST', jobId: String(job._id) };
    }

    await this.historyCache.invalidate(orgIdStr, convIdStr);

    if (finalOutcome.kind === 'CANCELLED') {
      await this.emitAssistantStatus(
        orgIdStr,
        convIdStr,
        finalOutcome.recipientIds,
        job,
        'CANCELLED',
        finalOutcome.failureCode,
        null,
        finalOutcome.updatedAt,
      );
      return {
        outcome: 'CANCELLED',
        jobId: String(job._id),
        failureCode: finalOutcome.failureCode,
        responseMessageId: null,
      };
    }

    const aiMessageDto = await this.buildPublishedAssistantMessageDto(
      orgObjId,
      convObjId,
      finalOutcome.aiMessageDoc,
    );
    await this.realtime.publishConversationEvent(
      'message.created',
      orgIdStr,
      convIdStr,
      finalOutcome.recipientIds,
      aiMessageDto,
    );
    await this.emitAssistantStatus(
      orgIdStr,
      convIdStr,
      finalOutcome.recipientIds,
      job,
      finalOutcome.status,
      null,
      aiMessageDto.id,
      finalOutcome.updatedAt,
    );

    return {
      outcome: finalOutcome.status,
      jobId: String(job._id),
      failureCode: null,
      responseMessageId: aiMessageDto.id,
    };
  }

  private async reconcileDuplicateAssistantMessage(
    job: AssistantJobDocument,
    workerLeaseId: string,
  ): Promise<DmAssistantWorkerTickResult> {
    const existing = await this.messagesModel!.findOne({
      organizationId: job.organizationId,
      conversationId: job.conversationId,
      authorType: 'ASSISTANT',
      triggerMessageId: job.triggerMessageId,
    })
      .lean()
      .exec();
    if (!existing) {
      throw new Error('Duplicate key error without existing assistant reply.');
    }
    const status: ChatAssistantPostedStatus =
      existing.assistantStatus === 'INSUFFICIENT_EVIDENCE'
        ? 'INSUFFICIENT_EVIDENCE'
        : 'COMPLETED';
    const completedAt = new Date();
    const updated = await this.jobsModel!.updateOne(
      {
        _id: job._id,
        status: 'PROCESSING',
        lockedBy: workerLeaseId,
      },
      {
        $set: {
          status,
          failureCode: null,
          failureReason: null,
          responseMessageId: existing._id,
          completedAt,
          lockedBy: null,
          lockedUntil: null,
        },
      },
    ).exec();

    if (updated.matchedCount === 0) {
      return {
        outcome: 'LEASE_LOST',
        jobId: String(job._id),
        responseMessageId: String(existing._id),
      };
    }

    const orgIdStr = String(job.organizationId);
    const convIdStr = String(job.conversationId);
    await this.historyCache.invalidate(orgIdStr, convIdStr);
    const recipients = await this.getActiveMemberIds(
      job.organizationId,
      job.conversationId,
    );
    await this.emitAssistantStatus(
      orgIdStr,
      convIdStr,
      recipients,
      job,
      status,
      null,
      String(existing._id),
      completedAt,
    );

    return {
      outcome: status,
      jobId: String(job._id),
      failureCode: null,
      responseMessageId: String(existing._id),
    };
  }

  private async handleProcessingError(
    job: AssistantJobDocument,
    workerLeaseId: string,
    error: unknown,
  ): Promise<DmAssistantWorkerTickResult> {
    const httpCode = extractHttpErrorCode(error);
    let retryable = true;
    let failureCode: ChatAssistantFailureCode = 'SERVICE_UNAVAILABLE';
    let safeReason = 'Assistant service temporarily unavailable.';

    if (httpCode === 'AI_ENGINE_AUTH_FAILED') {
      retryable = false;
      failureCode = 'SERVICE_UNAVAILABLE';
      safeReason = 'AI engine service authentication failed.';
    } else if (httpCode === 'AI_ENGINE_NOT_CONFIGURED') {
      retryable = false;
      failureCode = 'SERVICE_UNAVAILABLE';
      safeReason = 'AI engine is not configured.';
    } else if (httpCode === 'AI_ENGINE_REQUEST_FAILED') {
      retryable = false;
      failureCode = 'INVALID_MODEL_OUTPUT';
      safeReason = 'AI engine rejected the request payload.';
    } else if (httpCode === 'AI_ENGINE_TIMEOUT') {
      retryable = true;
      failureCode = 'TIMEOUT';
      safeReason = 'AI engine request timed out.';
    } else if (
      httpCode === 'AI_ENGINE_UPSTREAM_ERROR' ||
      error instanceof InvalidModelOutputError
    ) {
      retryable = true;
      failureCode = 'INVALID_MODEL_OUTPUT';
      safeReason = 'AI engine returned invalid output or unknown citations.';
    } else if (
      httpCode === 'AI_ENGINE_UNAVAILABLE' ||
      httpCode === 'AI_ENGINE_RATE_LIMITED' ||
      error instanceof CommitConflictExhaustedError
    ) {
      retryable = true;
      failureCode = 'SERVICE_UNAVAILABLE';
      safeReason =
        error instanceof CommitConflictExhaustedError
          ? 'Concurrent conversation update conflict exceeded retry limit.'
          : 'AI engine temporarily unavailable.';
    }

    if (retryable && job.attempts < job.maxAttempts) {
      const baseDelayMs =
        this.retryBaseDelayOverrideMs !== undefined
          ? this.retryBaseDelayOverrideMs
          : job.attempts <= 1
            ? 3_000
            : 10_000;
      const jitterMs =
        this.retryBaseDelayOverrideMs !== undefined
          ? 0
          : Math.floor(Math.random() * 1_000);
      const nextAttemptAt = new Date(Date.now() + baseDelayMs + jitterMs);
      await this.jobsModel!.updateOne(
        { _id: job._id, status: 'PROCESSING', lockedBy: workerLeaseId },
        {
          $set: {
            status: 'PENDING',
            failureCode: null,
            failureReason: safeReason.slice(0, 300),
            nextAttemptAt,
            lockedBy: null,
            lockedUntil: null,
          },
        },
      ).exec();

      this.logger.warn(
        `DM assistant job ${String(job._id)} retry scheduled (attempt ${job.attempts}/${job.maxAttempts}, code=${failureCode})`,
      );

      return {
        outcome: 'RETRY_SCHEDULED',
        jobId: String(job._id),
        failureCode,
        responseMessageId: null,
      };
    }

    const completedAt = new Date();
    const updated = await this.jobsModel!.updateOne(
      { _id: job._id, status: 'PROCESSING', lockedBy: workerLeaseId },
      {
        $set: {
          status: 'FAILED',
          failureCode,
          failureReason: safeReason.slice(0, 300),
          completedAt,
          lockedBy: null,
          lockedUntil: null,
        },
      },
    ).exec();

    if (updated.matchedCount === 0) {
      return { outcome: 'LEASE_LOST', jobId: String(job._id) };
    }

    const orgIdStr = String(job.organizationId);
    const convIdStr = String(job.conversationId);
    await this.historyCache.invalidate(orgIdStr, convIdStr);
    const recipients = await this.getActiveMemberIds(
      job.organizationId,
      job.conversationId,
    );
    await this.emitAssistantStatus(
      orgIdStr,
      convIdStr,
      recipients,
      job,
      'FAILED',
      failureCode,
      null,
      completedAt,
    );

    this.logger.warn(
      `DM assistant job ${String(job._id)} failed terminally (attempts=${job.attempts}/${job.maxAttempts}, code=${failureCode})`,
    );

    return {
      outcome: 'FAILED',
      jobId: String(job._id),
      failureCode,
      responseMessageId: null,
    };
  }

  private async finalizeCancelledJob(
    job: AssistantJobDocument,
    workerLeaseId: string,
    failureCode: ChatAssistantFailureCode,
    failureReason: string,
    knownRecipients?: string[],
  ): Promise<DmAssistantWorkerTickResult> {
    const now = new Date();
    const updated = await this.jobsModel!.updateOne(
      { _id: job._id, status: 'PROCESSING', lockedBy: workerLeaseId },
      {
        $set: {
          status: 'CANCELLED',
          failureCode,
          failureReason: failureReason.slice(0, 300),
          completedAt: now,
          lockedBy: null,
          lockedUntil: null,
        },
      },
    ).exec();

    if (updated.matchedCount === 0) {
      return { outcome: 'LEASE_LOST', jobId: String(job._id) };
    }

    const orgIdStr = String(job.organizationId);
    const convIdStr = String(job.conversationId);
    await this.historyCache.invalidate(orgIdStr, convIdStr);
    const recipients =
      knownRecipients ??
      (await this.getActiveMemberIds(job.organizationId, job.conversationId));
    await this.emitAssistantStatus(
      orgIdStr,
      convIdStr,
      recipients,
      job,
      'CANCELLED',
      failureCode,
      null,
      now,
    );

    return {
      outcome: 'CANCELLED',
      jobId: String(job._id),
      failureCode,
      responseMessageId: null,
    };
  }

  private async markJobTerminalInTx(
    jobId: Types.ObjectId,
    workerLeaseId: string,
    status: 'CANCELLED' | 'FAILED',
    failureCode: ChatAssistantFailureCode,
    failureReason: string,
    completedAt: Date,
    session: ClientSession,
  ): Promise<void> {
    await this.jobsModel!.updateOne(
      { _id: jobId, status: 'PROCESSING', lockedBy: workerLeaseId },
      {
        $set: {
          status,
          failureCode,
          failureReason: failureReason.slice(0, 300),
          completedAt,
          lockedBy: null,
          lockedUntil: null,
        },
      },
      { session },
    ).exec();
  }

  private async verifyChatAccess(
    orgObjId: Types.ObjectId,
    convObjId: Types.ObjectId,
    requesterUserId: string,
    session?: ClientSession,
  ): Promise<{
    allowed: boolean;
    conversation: ConversationRecord | null;
    activeMembers: MemberRecord[];
    activeMemberIds: string[];
  }> {
    const convQuery = this.conversationsModel!.findOne({
      _id: convObjId,
      organizationId: orgObjId,
      status: 'ACTIVE',
      type: 'DIRECT',
    });
    const membersQuery = this.membersModel!.find({
      organizationId: orgObjId,
      conversationId: convObjId,
      status: 'ACTIVE',
    });
    const [conversation, activeMembers] = await Promise.all([
      (session ? convQuery.session(session) : convQuery).lean().exec(),
      (session ? membersQuery.session(session) : membersQuery).lean().exec(),
    ]);
    const activeMemberIds = activeMembers.map((m) => m.userId);
    if (!conversation) {
      return {
        allowed: false,
        conversation: null,
        activeMembers,
        activeMemberIds,
      };
    }
    const requesterActive = activeMemberIds.includes(requesterUserId);
    if (!requesterActive) {
      return { allowed: false, conversation, activeMembers, activeMemberIds };
    }
    const peerIds = activeMemberIds.filter((id) => id !== requesterUserId);
    if (peerIds.length > 0 && this.connection?.db) {
      const blocked = await this.connection.db
        .collection('chat_blocks')
        .findOne(
          {
            organizationId: orgObjId,
            $or: [
              { userId: requesterUserId, targetId: { $in: peerIds } },
              { targetId: requesterUserId, userId: { $in: peerIds } },
            ],
          },
          session ? { session } : undefined,
        );
      if (blocked) {
        return { allowed: false, conversation, activeMembers, activeMemberIds };
      }
    }
    return { allowed: true, conversation, activeMembers, activeMemberIds };
  }

  private async getActiveMemberIds(
    orgObjId: Types.ObjectId,
    convObjId: Types.ObjectId,
  ): Promise<string[]> {
    if (!this.membersModel) return [];
    const rows = await this.membersModel
      .find(
        {
          organizationId: orgObjId,
          conversationId: convObjId,
          status: 'ACTIVE',
        },
        { userId: 1, _id: 0 },
      )
      .lean()
      .exec();
    return rows.map((row) => row.userId);
  }

  private async createAssistantNotificationsInTx(
    orgObjId: Types.ObjectId,
    convObjId: Types.ObjectId,
    aiMessageDoc: MessageDocument,
    activeMembers: readonly MemberRecord[],
    session: ClientSession,
  ): Promise<void> {
    if (!this.connection?.db) return;
    const recipients = activeMembers.filter(
      (member) => (member.notificationMode ?? 'ALL') === 'ALL',
    );
    if (recipients.length === 0) return;
    await this.connection.db.collection('chat_notifications').bulkWrite(
      recipients.map((member) => ({
        updateOne: {
          filter: {
            organizationId: orgObjId,
            userId: member.userId,
            messageId: aiMessageDoc._id,
          },
          update: {
            $setOnInsert: {
              conversationId: convObjId,
              senderName: CONTINUUM_AI_DISPLAY_NAME,
              preview: aiMessageDoc.content.slice(0, 160),
              createdAt: aiMessageDoc.createdAt,
              readAt: null,
            },
          },
          upsert: true,
        },
      })),
      { session },
    );
  }

  private async buildPublishedAssistantMessageDto(
    orgObjId: Types.ObjectId,
    convObjId: Types.ObjectId,
    aiMessageDoc: MessageDocument,
  ): Promise<ChatMessage> {
    const replyTarget = aiMessageDoc.replyToMessageId
      ? await this.messagesModel!.findOne({
          _id: aiMessageDoc.replyToMessageId,
          organizationId: orgObjId,
          conversationId: convObjId,
        })
          .lean()
          .exec()
      : null;

    const storedRefs = aiMessageDoc.sourceReferences ?? [];
    const liveSources = storedRefs.length
      ? await this.messagesModel!.find(
          {
            _id: { $in: storedRefs.map((ref) => ref.messageId) },
            organizationId: orgObjId,
            conversationId: convObjId,
          },
          { _id: 1, deletedAt: 1, editedAt: 1, contentVersion: 1 },
        )
          .lean()
          .exec()
      : [];
    const liveById = new Map(liveSources.map((s) => [String(s._id), s]));
    const sourceReferences = enrichSourceReferences(storedRefs, liveById);
    const postedStatus: ChatAssistantPostedStatus =
      aiMessageDoc.assistantStatus === 'INSUFFICIENT_EVIDENCE'
        ? 'INSUFFICIENT_EVIDENCE'
        : 'COMPLETED';

    return {
      id: String(aiMessageDoc._id),
      conversationId: String(aiMessageDoc.conversationId),
      senderId: aiMessageDoc.senderId,
      senderName: aiMessageDoc.senderName,
      senderAvatarUrl: aiMessageDoc.senderAvatarUrl ?? null,
      content: aiMessageDoc.content,
      createdAt: aiMessageDoc.createdAt.toISOString(),
      editedAt: null,
      deletedAt: null,
      reactions: [],
      replyToMessageId: aiMessageDoc.replyToMessageId
        ? String(aiMessageDoc.replyToMessageId)
        : null,
      replyTo: replyTarget
        ? {
            id: String(replyTarget._id),
            senderName: replyTarget.senderName,
            preview: replyTarget.deletedAt
              ? ''
              : (
                  replyTarget.content ||
                  replyTarget.attachments?.[0]?.name ||
                  ''
                ).slice(0, 160),
            deleted: Boolean(replyTarget.deletedAt),
          }
        : null,
      mentionUserIds: [],
      isPinned: false,
      forwardedFrom: null,
      attachments: [],
      authorType: 'ASSISTANT',
      triggerMessageId: aiMessageDoc.triggerMessageId
        ? String(aiMessageDoc.triggerMessageId)
        : null,
      assistantStatus: postedStatus,
      assistantFailureCode: null,
      assistantMeta: {
        handle: aiMessageDoc.assistantMeta?.handle ?? CONTINUUM_AI_HANDLE,
        queryMode: aiMessageDoc.assistantMeta?.queryMode ?? 'KEYWORD',
        partialCoverage: Boolean(aiMessageDoc.assistantMeta?.partialCoverage),
        coverageNote: aiMessageDoc.assistantMeta?.coverageNote ?? null,
        sourceState: computeSourceAggregateState(sourceReferences),
      },
      sourceReferences,
    };
  }

  private async emitAssistantStatus(
    organizationId: string,
    conversationId: string,
    recipientIds: string[],
    job: AssistantJobDocument,
    status: ChatAssistantStatus,
    failureCode: ChatAssistantFailureCode | null,
    responseMessageId: string | null,
    updatedAt: Date,
  ): Promise<void> {
    if (recipientIds.length === 0) return;
    const payload: AssistantStatusEvent = {
      conversationId,
      triggerMessageId: String(job.triggerMessageId),
      jobId: String(job._id),
      status,
      failureCode,
      responseMessageId,
      updatedAt: updatedAt.toISOString(),
    };
    await this.realtime.publishConversationEvent(
      'assistant.status',
      organizationId,
      conversationId,
      recipientIds,
      payload,
    );
  }
}
