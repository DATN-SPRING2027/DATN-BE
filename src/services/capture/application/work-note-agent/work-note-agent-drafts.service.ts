import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
  HttpStatus,
  GatewayTimeoutException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { staleAssessment } from './work-note-assessment.state';
import { assessmentHash } from './work-note-assessment.protocol';
import { ASSESSMENT_EDITOR_PROVIDER_POLICY } from './work-note-assessment-editor';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type Connection, type ClientSession } from 'mongoose';
import type { Document, Db } from 'mongodb';
import { createHash, randomUUID } from 'node:crypto';
import { WorkNotesAuthorizationService } from '../work-notes-authorization.service';
import { WorkNotesService } from '../work-notes.service';
import type {
  CaptureRequestHeaders,
  DocumentKnowledgeStatusRecord,
  DocumentVersionRecord,
  ProjectDocumentFileRecord,
  TaskNoteAiChatSource,
  TaskNoteAiChatSourceInput,
  TaskNoteReviewStatus,
  WorkNotesActor,
} from '../work-notes.types';
import { CAPTURE_PERSISTENCE } from '../../infrastructure/persistence';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { WorkNoteAgentModel } from '../../infrastructure/ai/work-note-agent.model';
import { XkiroError } from '../../infrastructure/ai/work-note-xkiro.client';
import { AuditService } from '../../infrastructure/audit/audit.service';
import {
  applySuggestion,
  prepareAgentRequest,
  AgentValidationError,
  type AgentInput,
  type AgentResult,
} from './work-note-agent';
import type {
  AgentDraftState,
  AgentDraftView,
  ApplyInput,
  CanonicalTaskNote,
  CreateDraftInput,
  MessageInput,
  PendingQuestion,
  RestoreInput,
  RevisionOperation,
  SaveInput,
  UpdateDraftInput,
} from './work-note-agent-drafts.types';
import {
  LEDGER_COLLECTION,
  buildHistoricalContext,
  historicalContextView,
  loadTaskHistory,
  rankNotes,
  type HistoryOptions,
} from './history/work-note-history.retriever';
import { truncateFactQuote } from './history/work-note-history.facts';
import {
  dedupeClarification,
  expandHistoryConfirmation,
  type HistoryRef,
} from './history/clarification-dedup';
import type {
  HistoricalContext,
  HistoricalContextView,
  HistoricalNote,
} from './history/history.types';
import type { SecurityReport } from './security/security.types';

const historyLogger = new Logger('WorkNoteHistory');

const DAY = 86400000;
const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const oid = (value: string) => new Types.ObjectId(value);
const missing = () =>
  new NotFoundException({
    code: 'WORKNOTE_DRAFT_NOT_FOUND',
    message: 'Draft is unavailable or expired.',
  });
const conflict = () =>
  new ConflictException({
    code: 'WORKNOTE_DRAFT_CONFLICT',
    message: 'The note, draft or selection changed. Reload or regenerate.',
  });
const hash = (value: unknown): string =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_k, v: unknown) =>
        v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        !(v instanceof Date) &&
        !(v instanceof Types.ObjectId)
          ? Object.fromEntries(
              Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
            )
          : v,
      ),
    )
    .digest('hex');
export type DraftRow = Document & {
  _id: string;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  taskId: Types.ObjectId | null;
  workflow?: AgentInput['workflow'];
  resourceId?: Types.ObjectId | null;
  context?: Record<string, unknown>;
  ownerUserId: Types.ObjectId;
  noteId: Types.ObjectId | null;
  baseNoteVersion: number;
  baseNoteUpdatedAt?: Date;
  revision: number;
  state: AgentDraftState;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  inferenceOperationId?: string;
  inferenceLeaseUntil?: Date;
};
type OperationRow = Document & {
  createdAt?: Date;
  _id: string;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  ownerUserId: Types.ObjectId;
  draftId: string;
  payloadHash: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  result?: unknown;
  failureCode?: string;
  expiresAt: Date;
};
type MessageResponse = AgentResult & {
  sourceRevision: number;
  history?: HistoricalContextView;
  security?: SecurityReport;
};
const legacyBody = (row: Document): string =>
  typeof row.contentMarkdown === 'string'
    ? row.contentMarkdown
    : [
        ['Accomplishments', row.whatDone],
        ['Approach', row.howSolved],
        ['Reason', row.whyThisWay],
      ]
        .map(
          ([label, value]) =>
            `## ${label}\n${typeof value === 'string' ? value : ''}`,
        )
        .join('\n\n');
const noteHash = (row: Document) =>
  hash([
    String(row.title),
    legacyBody(row),
    String(row.authorUserId),
    Number(row.currentVersionNumber ?? 0),
  ]);

@Injectable()
export class WorkNoteAgentDraftsService {
  constructor(
    protected readonly config: ConfigService,
    protected readonly authorization: WorkNotesAuthorizationService,
    protected readonly notes: WorkNotesService,
    protected readonly model: WorkNoteAgentModel,
    protected readonly redis: RedisService,
    @Optional()
    @InjectConnection(CAPTURE_PERSISTENCE.databaseName)
    protected readonly connection?: Connection,
    @Optional() protected readonly audit?: AuditService,
  ) {}
  protected db(): Db {
    const enabled = this.config.get<string | boolean>(
      'WORKNOTE_EDITOR_ENABLED',
    );
    if ((enabled !== true && enabled !== 'true') || !this.connection?.db)
      throw new ServiceUnavailableException({
        code: 'WORKNOTE_EDITOR_UNAVAILABLE',
        message: 'The editor is unavailable.',
      });
    return this.connection.db;
  }
  protected drafts() {
    return this.db().collection<DraftRow>('work_note_agent_drafts');
  }
  protected operations() {
    return this.db().collection<OperationRow>('work_note_agent_operations');
  }
  protected async storageReady() {
    try {
      const db = this.db();
      for (const collection of [
        'work_note_agent_drafts',
        'work_note_agent_operations',
      ]) {
        const indexes = await db.collection(collection).listIndexes().toArray();
        if (
          !indexes.some(
            (index: { key?: unknown; expireAfterSeconds?: number }) =>
              JSON.stringify(index.key) === JSON.stringify({ expiresAt: 1 }) &&
              index.expireAfterSeconds === 0,
          )
        )
          throw Error('missing TTL');
      }
      const versions = await db
        .collection('work_note_versions')
        .listIndexes()
        .toArray();
      if (
        !versions.some(
          (index: { key?: unknown; unique?: boolean }) =>
            JSON.stringify(index.key) ===
              JSON.stringify({ workNoteId: 1, versionNumber: 1 }) &&
            index.unique === true,
        )
      )
        throw Error('missing version uniqueness');
    } catch {
      throw new ServiceUnavailableException({
        code: 'WORKNOTE_STORAGE_NOT_READY',
        message:
          'The editor storage migration is not ready. Existing notes are unchanged.',
      });
    }
  }
  protected scope(actor: WorkNotesActor) {
    return {
      organizationId: oid(actor.organizationId),
      projectId: oid(actor.projectId),
      ownerUserId: oid(actor.userId),
    };
  }
  protected async recordDurableTokenUsage(
    actor: WorkNotesActor,
    taskKind: 'note_assessment' | 'note_rewrite',
    provenance: Record<string, unknown> | undefined | null,
    dedupeKey: string,
  ): Promise<void> {
    if (!provenance || typeof provenance !== 'object') return;
    const rawPrompt = Number(
      provenance.promptTokens ?? provenance.inputTokens ?? 0,
    );
    const rawCompletion = Number(
      provenance.completionTokens ?? provenance.outputTokens ?? 0,
    );
    const promptTokens =
      Number.isFinite(rawPrompt) && rawPrompt > 0 ? Math.round(rawPrompt) : 0;
    const completionTokens =
      Number.isFinite(rawCompletion) && rawCompletion > 0
        ? Math.round(rawCompletion)
        : 0;
    if (promptTokens + completionTokens <= 0) return;
    const cacheReadTokens = Math.floor(promptTokens * 0.25);
    const inputTokens = Math.max(0, promptTokens - cacheReadTokens);
    try {
      await this.db()
        .collection('ai_token_usage_logs')
        .insertOne({
          organizationId: oid(actor.organizationId),
          projectId: oid(actor.projectId),
          userId: oid(actor.userId),
          taskKind,
          inputTokens,
          cacheReadTokens,
          cacheWriteTokens: 0,
          outputTokens: completionTokens,
          calls: 1,
          ...(dedupeKey ? { dedupeKey } : {}),
          occurredAt: new Date(),
        });
    } catch {
      // Best-effort durable token usage log; never block user operations.
    }
  }
  // ---------------------------------------------------------------------------
  // Historical Work Note context (Phase 1: same Task; Phase 2: parent + direct children)
  // ---------------------------------------------------------------------------
  protected historyOptions(): HistoryOptions | null {
    const flag = this.config.get<string | boolean>('WORKNOTE_HISTORY_ENABLED');
    if (flag === false || flag === 'false') return null;
    const num = (key: string, fallback: number, max: number, min = 1) => {
      const raw = this.config.get<string | number>(key);
      if (raw === undefined || raw === null || String(raw).trim() === '')
        return fallback;
      const v = Number(raw);
      return Number.isSafeInteger(v) && v >= min ? Math.min(v, max) : fallback;
    };
    const relatedFlag = this.config.get<string | boolean>(
      'WORKNOTE_HISTORY_RELATED_ENABLED',
    );
    return {
      maxNotes: num('WORKNOTE_HISTORY_MAX_NOTES', 5, 20),
      charBudget: num('WORKNOTE_HISTORY_CHAR_BUDGET', 6000, 20000),
      staleDays: num('WORKNOTE_HISTORY_STALE_DAYS', 14, 365),
      maxRelatedNotes:
        relatedFlag === false || relatedFlag === 'false'
          ? 0
          : num('WORKNOTE_HISTORY_MAX_RELATED_NOTES', 3, 10, 0),
    };
  }
  /** Masks each historical note independently; notes that hit a BLOCK rule are dropped. */
  private maskHistory(notes: readonly HistoricalNote[]): HistoricalNote[] {
    const gateway = this.model.securityGateway?.();
    if (!gateway) return [...notes];
    const out: HistoricalNote[] = [];
    for (const note of notes) {
      try {
        const [title, text] = gateway.maskTexts([note.title, note.text]);
        out.push({ ...note, title, text });
      } catch {
        historyLogger.warn(
          JSON.stringify({
            event: 'worknote.history.note_blocked',
            source: note.source,
          }),
        );
      }
    }
    return out;
  }
  /**
   * Best-effort: history never breaks the Agent. The caller has already
   * authorized the Task via `owned()` (same rule as listTaskNotes).
   */
  protected async loadHistoricalContext(
    headers: CaptureRequestHeaders,
    actor: WorkNotesActor,
    d: DraftRow,
  ): Promise<HistoricalContext | null> {
    const options = this.historyOptions();
    if (!options || !d.taskId || (d.workflow && d.workflow !== 'TASK_NOTE'))
      return null;
    try {
      // Phase 2: parent + direct children, resolved with the caller's own credentials.
      const relatedTasks =
        (options.maxRelatedNotes ?? 0) > 0
          ? ((await this.authorization.resolveRelatedTasks?.(
              headers,
              actor,
              String(d.taskId),
            )) ?? [])
          : [];
      const notes = await loadTaskHistory(
        this.db(),
        {
          organizationId: String(d.organizationId),
          projectId: String(d.projectId),
          taskId: String(d.taskId),
          excludeNoteId: d.noteId ? String(d.noteId) : null,
          related: relatedTasks.map(({ id, key, relation }) => ({
            id,
            relation,
            ...(key ? { key } : {}),
          })),
        },
        options,
      );
      if (!notes.length) return null;
      const ranked = rankNotes(
        notes,
        `${actor.taskContext?.title ?? ''} ${d.state.title} ${d.state.contentMarkdown}`,
        options.maxNotes,
        options.maxRelatedNotes ?? 0,
      );
      const context = buildHistoricalContext({
        notes: this.maskHistory(ranked),
        currentNoteText: d.state.contentMarkdown,
        taskStatus: actor.taskContext?.status ?? null,
        now: new Date(),
        options,
      });
      return context.facts.length ? context : null;
    } catch (error) {
      historyLogger.warn(
        JSON.stringify({
          event: 'worknote.history.unavailable',
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
      return null;
    }
  }
  /**
   * Intelligent Clarification layer 2: turns an open question that is already
   * answered by history into a one-click confirmation (never repeated in a draft).
   */
  protected dedupeQuestion(
    question: AgentResult['questions'][number] | undefined,
    historical: HistoricalContext | null,
    clarifications: AgentInput['clarifications'],
  ):
    | (AgentResult['questions'][number] & { historyRef?: HistoryRef })
    | undefined {
    if (!question || !historical) return question;
    const decision = dedupeClarification(question, historical);
    if (decision.action === 'keep') return question;
    const alreadyConfirmed = clarifications.some(
      (c) => c.question === decision.question.text,
    );
    return alreadyConfirmed
      ? question
      : { ...decision.question, historyRef: decision.historyRef };
  }
  /** Read model for the composer's "Ngữ cảnh công việc" tab. */
  async history(
    headers: CaptureRequestHeaders,
    projectId: string,
    id: string,
  ): Promise<HistoricalContextView | null> {
    const { actor, draft } = await this.owned(headers, projectId, id);
    const context = await this.loadHistoricalContext(headers, actor, draft);
    return context ? historicalContextView(context) : null;
  }
  /** Task-level clarification ledger so new drafts do not re-ask answered questions. */
  private async recordClarificationLedger(d: DraftRow, noteId: string) {
    if (!this.historyOptions() || !d.taskId) return;
    const answered = d.state.clarifications.filter(
      (c) => c.state === 'answered' && c.answer?.trim(),
    );
    if (!answered.length) return;
    const gateway = this.model.securityGateway?.();
    const now = new Date();
    const rows: Document[] = [];
    for (const c of answered) {
      try {
        const [question, answer] = gateway
          ? gateway.maskTexts([c.question, c.answer!])
          : [c.question, c.answer!];
        rows.push({
          organizationId: d.organizationId,
          projectId: d.projectId,
          taskId: d.taskId,
          question,
          answer,
          disposition: 'answered',
          answeredAt: now,
          sourceDraftId: d._id,
          noteId: oid(noteId),
        });
      } catch {
        // BLOCK-level content is never persisted into the ledger.
      }
    }
    if (!rows.length) return;
    try {
      await this.db().collection(LEDGER_COLLECTION).insertMany(rows);
    } catch (error) {
      historyLogger.warn(
        JSON.stringify({
          event: 'worknote.history.ledger_failed',
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
    }
  }
  protected opId(actor: WorkNotesActor, id: string) {
    if (!uuid(id))
      throw new UnprocessableEntityException({ code: 'INVALID_OPERATION_ID' });
    return hash([actor.organizationId, actor.userId, id]);
  }
  protected view(d: DraftRow): AgentDraftView {
    const q = d.state.pendingQuestion;
    if (
      d.state.assessment?.state === 'analyzing' &&
      (!d.inferenceLeaseUntil || d.inferenceLeaseUntil.getTime() <= Date.now())
    ) {
      d.state.assessment = {
        ...d.state.assessment,
        state: 'error',
        nextQuestion: null,
        allowedActions: ['reset', 'feedback', 'manual'],
      };
    }
    return {
      ...(d.state.assessment
        ? {
            assessment:
              d.state.assessment.sourceRevision !== d.revision
                ? staleAssessment(d.state.assessment)
                : d.state.assessment,
          }
        : {}),
      id: d._id,
      taskId: d.taskId ? String(d.taskId) : '',
      noteId: d.noteId ? String(d.noteId) : null,
      workflow: d.workflow ?? 'TASK_NOTE',
      ...(d.workflow && d.workflow !== 'TASK_NOTE'
        ? {
            resourceId: d.resourceId ? String(d.resourceId) : null,
            context: d.context,
            baseContentHash: d.state.baseNoteHash,
          }
        : {}),
      baseNoteVersion: d.baseNoteVersion,
      revision: d.revision,
      title: d.state.title,
      contentMarkdown: d.state.contentMarkdown,
      expiresAt: d.expiresAt.toISOString(),
      hasAppliedRewrite: d.state.hasAppliedRewrite,
      conversation: d.state.conversation,
      pendingQuestion: q
        ? {
            id: q.id,
            text: q.text,
            reason: q.reason,
            options: q.options,
            ...(q.historyRef ? { historyRef: q.historyRef } : {}),
          }
        : null,
      suggestion: d.state.suggestion,
      ...(d.state.suggestion && d.state.suggestionProvenance?.security
        ? {
            lastSecurity: d.state.suggestionProvenance
              .security as SecurityReport,
          }
        : {}),
    };
  }
  protected async transaction<T>(
    fn: (db: Db, session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const db = this.db();
    const session = await this.connection!.startSession();
    try {
      return await session.withTransaction(() => fn(db, session));
    } finally {
      await session.endSession();
    }
  }
  protected async owned(
    headers: CaptureRequestHeaders,
    projectId: string,
    id: string,
  ) {
    await this.storageReady();
    if (!uuid(id)) throw missing();
    const actor = await this.authorization.resolveProject(headers, projectId);
    const draft = await this.drafts().findOne({
      _id: id,
      ...this.scope(actor),
      expiresAt: { $gt: new Date() },
    });
    if (
      !draft ||
      draft.createdAt.getTime() + DAY <= Date.now() ||
      (draft.workflow && draft.workflow !== 'TASK_NOTE')
    )
      throw missing();
    const taskActor = await this.authorization.resolveTask(
      headers,
      projectId,
      String(draft.taskId),
    );
    if (draft.noteId) {
      const note = await this.notes.getTaskNote(
        headers,
        projectId,
        String(draft.taskId),
        String(draft.noteId),
      );
      if (!note.permissions.canEdit)
        throw new ForbiddenException({ code: 'NOTE_EDIT_DENIED' });
    }
    draft.expiresAt = new Date(
      Math.min(draft.expiresAt.getTime(), draft.createdAt.getTime() + DAY),
    );
    return { actor: taskActor, draft };
  }
  protected async prior(
    actor: WorkNotesActor,
    id: string,
    payload: unknown,
    session?: ClientSession,
  ) {
    const op = await this.operations().findOne(
      {
        _id: this.opId(actor, id),
        organizationId: oid(actor.organizationId),
        ownerUserId: oid(actor.userId),
      },
      { session },
    );
    if (!op) return null;
    if (op.expiresAt.getTime() <= Date.now())
      throw new ConflictException({
        code: 'OPERATION_EXPIRED',
        message: 'Use a new operation ID.',
      });
    if (op.createdAt && op.createdAt.getTime() + DAY <= Date.now())
      throw new ConflictException({ code: 'OPERATION_EXPIRED' });
    if (!op.createdAt) {
      // Old raw insertOne receipts predate explicit timestamps. Do not let a
      // sliding legacy expiry expose source-bearing results beyond draft age.
      const sourceDraft = await this.drafts().findOne(
        { _id: op.draftId, ...this.scope(actor) },
        { session },
      );
      if (
        !sourceDraft ||
        sourceDraft.createdAt.getTime() + DAY <= Date.now() ||
        sourceDraft.expiresAt.getTime() <= Date.now()
      )
        throw new ConflictException({ code: 'OPERATION_EXPIRED' });
    }
    if (op.payloadHash !== hash(payload))
      throw new ConflictException({
        code: 'OPERATION_ID_REUSED',
        message: 'Use a new operation ID for a different request.',
      });
    if (op.status === 'PENDING')
      throw new ConflictException({ code: 'OPERATION_IN_PROGRESS' });
    if (op.status === 'FAILED')
      throw new BadGatewayException({
        code: op.failureCode ?? 'AGENT_FAILED',
        message: 'Previous operation failed. Start a new request.',
      });
    return op;
  }
  protected replayDraft(op: OperationRow): AgentDraftView {
    if (
      op.result &&
      typeof op.result === 'object' &&
      'closed' in op.result &&
      op.result.closed === true
    )
      throw new ConflictException({
        code: 'DRAFT_CLOSED',
        message:
          'This draft was saved or discarded. Start a new draft explicitly.',
      });
    return op.result as AgentDraftView;
  }
  protected receipt(
    actor: WorkNotesActor,
    id: string,
    draftId: string,
    payload: unknown,
    result: unknown,
    expiresAt = new Date(Date.now() + DAY),
  ): OperationRow {
    return {
      _id: this.opId(actor, id),
      ...this.scope(actor),
      draftId,
      payloadHash: hash(payload),
      status: 'COMPLETED',
      createdAt: new Date(),
      result,
      expiresAt,
    };
  }
  protected async consumeAgentQuota(actor: WorkNotesActor): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.redis.consumeRateLimit(
          `worknote-agent:${actor.organizationId}:${actor.userId}`,
          10,
          60,
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Error('Quota deadline')), 1500);
        }),
      ]);
    } catch {
      throw new ServiceUnavailableException({
        code: 'AGENT_QUOTA_UNAVAILABLE',
        message: 'Agent is temporarily unavailable. You can still save.',
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async create(
    headers: CaptureRequestHeaders,
    projectId: string,
    input: CreateDraftInput,
  ): Promise<AgentDraftView> {
    await this.storageReady();
    const actor = await this.authorization.resolveTask(
      headers,
      projectId,
      input.taskId,
    );
    const payload = { kind: 'create', projectId, ...input };
    let row: Document | null = null;
    if (input.noteId) {
      const accessible = await this.notes.getTaskNote(
        headers,
        projectId,
        input.taskId,
        input.noteId,
      );
      if (!accessible.permissions.canEdit)
        throw new ForbiddenException({ code: 'NOTE_EDIT_DENIED' });
      row = await this.db()
        .collection('work_notes')
        .findOne({
          _id: oid(input.noteId),
          organizationId: oid(actor.organizationId),
          projectId: oid(projectId),
          taskId: oid(input.taskId),
          status: 'CONFIRMED',
        });
      if (!row) throw missing();
    }
    const replay = await this.prior(actor, input.operationId, payload);
    if (replay) return this.replayDraft(replay);
    const now = new Date();
    const d: DraftRow = {
      _id: randomUUID(),
      ...this.scope(actor),
      taskId: oid(input.taskId),
      noteId: input.noteId ? oid(input.noteId) : null,
      baseNoteVersion:
        typeof row?.currentVersionNumber === 'number'
          ? row.currentVersionNumber
          : 0,
      ...(row?.updatedAt instanceof Date
        ? { baseNoteUpdatedAt: row.updatedAt }
        : {}),
      revision: 1,
      state: {
        ...(row ? { baseNoteHash: noteHash(row) } : {}),
        title: typeof row?.title === 'string' ? row.title : '',
        contentMarkdown: row ? legacyBody(row) : '',
        hasAppliedRewrite: false,
        conversation: [],
        clarifications: [],
        pendingQuestion: null,
        suggestion: null,
        messageTurns: 0,
      },
      expiresAt: new Date(now.getTime() + DAY),
      createdAt: now,
      updatedAt: now,
    };
    if (d.state.contentMarkdown.length > 30000)
      throw new UnprocessableEntityException({
        code: 'NOTE_EDITOR_LIMIT_EXCEEDED',
      });
    return this.transaction(async (_db, session) => {
      const existing = await this.prior(
        actor,
        input.operationId,
        payload,
        session,
      );
      if (existing) return this.replayDraft(existing);
      await this.drafts().insertOne(d, { session });
      const result = this.view(d);
      await this.operations().insertOne(
        this.receipt(
          actor,
          input.operationId,
          d._id,
          payload,
          result,
          d.expiresAt,
        ),
        { session },
      );
      return result;
    });
  }
  async get(headers: CaptureRequestHeaders, projectId: string, id: string) {
    const { actor, draft } = await this.owned(headers, projectId, id);
    if (
      draft.state.assessment &&
      draft.state.assessment.taskContextHash !==
        assessmentHash([
          actor.taskContext,
          actor.taskContextVersion,
          Boolean(actor.taskContextInvalid),
        ])
    )
      draft.state.assessment = staleAssessment(
        draft.state.assessment,
        'TASK_CHANGED',
      );
    return this.view(draft);
  }
  async resume(
    headers: CaptureRequestHeaders,
    projectId: string,
    taskId: string,
    noteId?: string,
  ) {
    await this.storageReady();
    const actor = await this.authorization.resolveTask(
      headers,
      projectId,
      taskId,
    );
    const d = await this.drafts().findOne(
      {
        ...this.scope(actor),
        taskId: oid(taskId),
        noteId: noteId ? oid(noteId) : null,
        createdAt: { $gt: new Date(Date.now() - DAY) },
        expiresAt: { $gt: new Date() },
      },
      { sort: { updatedAt: -1 } },
    );
    if (!d) return null;
    if (noteId) {
      const live = await this.db()
        .collection('work_notes')
        .findOne({
          _id: oid(noteId),
          organizationId: oid(actor.organizationId),
          projectId: oid(projectId),
          taskId: oid(taskId),
          status: 'CONFIRMED',
        });
      if (
        !live ||
        d.baseNoteVersion !== Number(live.currentVersionNumber ?? 0) ||
        d.state.baseNoteHash !== noteHash(live) ||
        (d.baseNoteUpdatedAt &&
          live.updatedAt instanceof Date &&
          live.updatedAt.getTime() !== d.baseNoteUpdatedAt.getTime())
      ) {
        await this.drafts().deleteOne({ _id: d._id, revision: d.revision });
        return null;
      }
    }
    return this.get(headers, projectId, d._id);
  }
  protected async mutate<T>(
    headers: CaptureRequestHeaders,
    projectId: string,
    id: string,
    input: RevisionOperation,
    kind: string,
    fn: (
      d: DraftRow,
      actor: WorkNotesActor,
      db: Db,
      session: ClientSession,
    ) => Promise<T>,
  ): Promise<T> {
    const { actor } = await this.owned(headers, projectId, id);
    const payload = { kind, projectId, id, ...input };
    return this.transaction(async (db, session) => {
      const replay = await this.prior(
        actor,
        input.operationId,
        payload,
        session,
      );
      if (replay) return replay.result as T;
      const d = await this.drafts().findOne(
        {
          _id: id,
          ...this.scope(actor),
          expiresAt: { $gt: new Date() },
          revision: input.expectedRevision,
        },
        { session },
      );
      if (!d) throw conflict();
      const result = await fn(d, actor, db, session);
      await this.operations().insertOne(
        this.receipt(
          actor,
          input.operationId,
          id,
          payload,
          result,
          d.expiresAt,
        ),
        { session },
      );
      return result;
    });
  }
  private async write(d: DraftRow, session: ClientSession) {
    d.updatedAt = new Date();
    d.expiresAt = new Date(
      Math.min(d.createdAt.getTime() + DAY, Date.now() + DAY),
    );
    const changed = await this.drafts().replaceOne(
      {
        _id: d._id,
        revision: d.revision,
        ...{ ownerUserId: d.ownerUserId },
        expiresAt: { $gt: new Date() },
      },
      { ...d, revision: d.revision + 1 },
      { session },
    );
    if (changed.modifiedCount !== 1) throw conflict();
    d.revision++;
    return this.view(d);
  }
  async update(
    headers: CaptureRequestHeaders,
    projectId: string,
    id: string,
    input: UpdateDraftInput,
  ) {
    return this.mutate(
      headers,
      projectId,
      id,
      input,
      'update',
      async (d, _actor, _db, session) => {
        if (
          d.state.title === input.title &&
          d.state.contentMarkdown === input.contentMarkdown
        )
          return this.view(d);
        d.state.title = input.title;
        d.state.contentMarkdown = input.contentMarkdown;
        d.state.suggestion = null;
        d.state.pendingQuestion = null;
        if (d.state.assessment)
          d.state.assessment = staleAssessment(d.state.assessment);
        return this.write(d, session);
      },
    );
  }
  async reset(
    headers: CaptureRequestHeaders,
    projectId: string,
    id: string,
    input: RevisionOperation,
  ) {
    return this.mutate(
      headers,
      projectId,
      id,
      input,
      'reset',
      async (d, _actor, _db, session) => {
        d.state.conversation = [];
        d.state.clarifications = [];
        d.state.pendingQuestion = null;
        d.state.suggestion = null;
        if (d.state.assessment)
          d.state.assessment = staleAssessment(
            d.state.assessment,
            'CHAT_RESET',
          );
        return this.write(d, session);
      },
    );
  }
  async discard(
    headers: CaptureRequestHeaders,
    projectId: string,
    id: string,
    expectedRevision: number,
  ) {
    const { actor } = await this.owned(headers, projectId, id);
    await this.transaction(async (_db, session) => {
      const deleted = await this.drafts().deleteOne(
        {
          _id: id,
          ...this.scope(actor),
          revision: expectedRevision,
          expiresAt: { $gt: new Date() },
        },
        { session },
      );
      if (deleted.deletedCount !== 1) throw conflict();
      await this.operations().updateMany(
        { draftId: id, ...this.scope(actor) },
        {
          $set: {
            status: 'COMPLETED',
            result: { closed: true, discarded: true },
          },
          $unset: { failureCode: '' },
        },
        { session },
      );
    });
  }

  async message(
    headers: CaptureRequestHeaders,
    projectId: string,
    id: string,
    input: MessageInput,
  ): Promise<MessageResponse> {
    const { actor, draft: d } = await this.owned(headers, projectId, id);
    const payload = { kind: 'message', projectId, id, ...input };
    const replay = await this.prior(actor, input.operationId, payload);
    if (replay) return replay.result as MessageResponse;
    if (d.revision !== input.expectedRevision) throw conflict();
    if (d.state.messageTurns >= 20)
      throw new HttpException(
        {
          code: 'DRAFT_MESSAGE_LIMIT',
          message: 'Start a new draft or save this note.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    let request = input;
    const clarifications = [...d.state.clarifications];
    if (input.replyToQuestionId) {
      const q = d.state.pendingQuestion;
      if (!q || q.id !== input.replyToQuestionId) throw conflict();
      let resolvedSelection = q.request.selection;
      if (resolvedSelection) {
        const { start, end, quote } = resolvedSelection;
        if (start < 0 || end <= start || end > d.state.contentMarkdown.length)
          throw conflict();
        const liveQuote = d.state.contentMarkdown.slice(start, end);
        if (liveQuote !== quote) {
          const gw = this.model.securityGateway?.();
          const maskedLive = gw ? gw.maskTexts([liveQuote])[0] : liveQuote;
          if (maskedLive !== quote) throw conflict();
        }
        resolvedSelection = { start, end, quote: liveQuote };
      }
      request = {
        ...input,
        operation: q.request.operation,
        scope: q.request.scope,
        instruction: q.request.instruction,
        includeWholeNoteContext:
          input.includeWholeNoteContext ?? q.request.includeWholeNoteContext,
        ...(resolvedSelection
          ? { selection: resolvedSelection }
          : { selection: undefined }),
      };
      const expandedAnswer =
        input.questionDisposition === 'answered'
          ? expandHistoryConfirmation(input.answer, q.historyRef)
          : input.answer;
      clarifications.push({
        id: q.id,
        question: q.text,
        state: input.questionDisposition!,
        ...(input.questionDisposition === 'answered'
          ? { answer: expandedAnswer }
          : {}),
      });
    }
    let historical = await this.loadHistoricalContext(headers, actor, d);
    let historyView = historical ? historicalContextView(historical) : null;
    let agentInput: AgentInput = {
      operation: request.operation,
      scope: request.scope,
      instruction: request.instruction,
      workflow: d.workflow ?? 'TASK_NOTE',
      draft: {
        revision: d.revision,
        title: d.state.title,
        body: d.state.contentMarkdown,
      },
      task:
        !d.workflow || d.workflow === 'TASK_NOTE'
          ? (actor.taskContext ?? null)
          : null,
      clarifications,
      history: d.state.conversation.slice(-8),
      includeWholeNoteContext: request.includeWholeNoteContext,
      ...(request.selection ? { selection: request.selection } : {}),
      ...(historyView ? { historicalContext: historyView } : {}),
    };
    // Validate before consuming quota or claiming an inference operation.
    if (
      agentInput.scope === 'selection' &&
      (!agentInput.selection ||
        agentInput.draft.body.slice(
          agentInput.selection.start,
          agentInput.selection.end,
        ) !== agentInput.selection.quote)
    )
      throw conflict();
    const validateAndPrecheck = (candidate: AgentInput) => {
      prepareAgentRequest(candidate);
      // Pre-LLM Security Gateway pre-flight: BLOCK before quota/lease are consumed.
      this.model.precheck?.(candidate);
    };
    const throwInvalidAgentInput = (error: AgentValidationError): never => {
      const emptyBody =
        !['title', 'custom'].includes(agentInput.operation) &&
        !agentInput.draft.body.trim();
      throw new UnprocessableEntityException({
        code: error.code,
        message: emptyBody
          ? 'Vui lòng nhập nội dung ghi chú trước khi sử dụng công cụ chỉnh sửa văn bản này.'
          : error.message.includes('vượt quá giới hạn')
            ? error.message
            : 'Ngữ cảnh gửi đến Trợ lý AI không hợp lệ hoặc quá dài. Vui lòng chọn đoạn văn ngắn hơn hoặc điều chỉnh lại yêu cầu.',
      });
    };
    try {
      validateAndPrecheck(agentInput);
    } catch (error) {
      if (!(error instanceof AgentValidationError)) throw error;
      if (!agentInput.historicalContext) throwInvalidAgentInput(error);
      // Supplementary history must never reject an otherwise valid user request.
      const withoutHistory: AgentInput = {
        ...agentInput,
        historicalContext: undefined,
      };
      let degraded = false;
      if (historical && historical.facts.length > 8) {
        const topFacts = historical.facts.slice(0, 8);
        const topNoteIds = new Set(topFacts.map((f) => f.noteId));
        const topFactIds = new Set(topFacts.map((f) => f.id));
        const compactView = historicalContextView({
          notes: historical.notes.filter((n) => topNoteIds.has(n.id)),
          facts: topFacts,
          findings: historical.findings.filter((f) => topFactIds.has(f.factId)),
          truncated: true,
        });
        const compactCandidate: AgentInput = {
          ...withoutHistory,
          historicalContext: compactView,
        };
        try {
          validateAndPrecheck(compactCandidate);
          agentInput = compactCandidate;
          historyView = compactView;
          degraded = true;
        } catch (compactErr) {
          if (!(compactErr instanceof AgentValidationError)) throw compactErr;
        }
      }
      if (!degraded) {
        try {
          validateAndPrecheck(withoutHistory);
          agentInput = withoutHistory;
          historical = null;
          historyView = null;
          degraded = true;
        } catch (fallbackErr) {
          if (!(fallbackErr instanceof AgentValidationError)) throw fallbackErr;
        }
      }
      if (!degraded) throwInvalidAgentInput(error);
      historyLogger.warn(
        JSON.stringify({
          event: 'worknote.history.degraded_for_budget',
          keptHistory: Boolean(historyView),
        }),
      );
    }
    if (!(await this.consumeAgentQuota(actor)))
      throw new HttpException(
        {
          code: 'AGENT_RATE_LIMIT',
          message: 'Wait before another Agent request. You can still save.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    await this.transaction(async (_db, session) => {
      if (await this.prior(actor, input.operationId, payload, session))
        throw new ConflictException({ code: 'OPERATION_COMPLETED_RELOAD' });
      const claimed = await this.drafts().updateOne(
        {
          _id: id,
          ...this.scope(actor),
          revision: d.revision,
          expiresAt: { $gt: new Date() },
          $or: [
            { inferenceLeaseUntil: { $exists: false } },
            { inferenceLeaseUntil: { $lte: new Date() } },
          ],
        },
        {
          $set: {
            inferenceOperationId: input.operationId,
            inferenceLeaseUntil: new Date(
              Date.now() + ASSESSMENT_EDITOR_PROVIDER_POLICY.timeoutMs + 15000,
            ),
          },
        },
        { session },
      );
      if (claimed.modifiedCount !== 1) throw conflict();
      await this.operations().insertOne(
        {
          ...this.receipt(
            actor,
            input.operationId,
            id,
            payload,
            null,
            d.expiresAt,
          ),
          status: 'PENDING',
        },
        { session },
      );
    });
    try {
      const completion = await this.model.rewrite(agentInput);
      await this.owned(headers, projectId, id);
      return await this.transaction(async (_db, session) => {
        const current = await this.drafts().findOne(
          {
            _id: id,
            ...this.scope(actor),
            revision: d.revision,
            expiresAt: { $gt: new Date() },
            inferenceOperationId: input.operationId,
            inferenceLeaseUntil: { $gt: new Date() },
          },
          { session },
        );
        if (!current) throw conflict();
        const result = completion.result;
        if (current.state.assessment)
          current.state.assessment = staleAssessment(
            current.state.assessment,
            'LEGACY_AGENT_REQUEST',
          );
        const question = this.dedupeQuestion(
          result.questions[0],
          historical,
          clarifications,
        );
        const questionId = question ? randomUUID() : null;
        const rawUserTurn = input.answer ?? input.instruction;
        const gw = this.model.securityGateway?.();
        // Fail closed: never swallow masking errors or persist unmasked user input/state.
        const [safeUserTurn] = gw ? gw.maskTexts([rawUserTurn]) : [rawUserTurn];
        const safeClarifications = gw
          ? clarifications.map((c) => {
              const [cQuestion, cAnswer] = gw.maskTexts([
                c.question,
                c.answer ?? '',
              ]);
              return {
                ...c,
                question: cQuestion,
                ...(c.answer !== undefined ? { answer: cAnswer } : {}),
              };
            })
          : clarifications;
        let safePendingRequest: PendingQuestion['request'] | null = null;
        if (question) {
          const [safeInstruction, safeQuote] = gw
            ? gw.maskTexts([
                request.instruction,
                request.selection?.quote ?? '',
              ])
            : [request.instruction, request.selection?.quote ?? ''];
          safePendingRequest = {
            operation: request.operation,
            scope: request.scope,
            instruction: truncateFactQuote(safeInstruction, 2_000),
            includeWholeNoteContext: request.includeWholeNoteContext,
            ...(request.selection
              ? {
                  selection: {
                    start: request.selection.start,
                    end: request.selection.end,
                    quote: safeQuote,
                  },
                }
              : {}),
          };
        }
        current.state.clarifications = safeClarifications;
        current.state.conversation.push(
          { role: 'user', content: safeUserTurn },
          {
            role: 'assistant',
            content: result.message,
            ...(completion.provenance.security
              ? { security: completion.provenance.security }
              : {}),
          },
        );
        current.state.conversation = current.state.conversation.slice(-40);
        current.state.pendingQuestion =
          question && safePendingRequest
            ? { ...question, id: questionId!, request: safePendingRequest }
            : null;
        const opKey = this.opId(actor, input.operationId);
        current.state.suggestion = result.suggestion;
        current.state.suggestionTaskHash = hash(actor.taskContext ?? null);
        current.state.suggestionProvenance = {
          ...completion.provenance,
          operationKey: opKey,
        };
        current.state.messageTurns++;
        current.expiresAt = new Date(
          Math.min(current.createdAt.getTime() + DAY, Date.now() + DAY),
        );
        current.updatedAt = new Date();
        delete current.inferenceOperationId;
        delete current.inferenceLeaseUntil;
        const replaced = await this.drafts().replaceOne(
          {
            _id: id,
            revision: d.revision,
            inferenceOperationId: input.operationId,
            inferenceLeaseUntil: { $gt: new Date() },
          },
          current,
          { session },
        );
        if (replaced.matchedCount !== 1) throw conflict();
        const response: MessageResponse = {
          ...result,
          questions: question ? [{ ...question, ...{ id: questionId } }] : [],
          sourceRevision: d.revision,
          ...(historyView ? { history: historyView } : {}),
          ...(completion.provenance.security
            ? { security: completion.provenance.security }
            : {}),
        };
        await this.operations().updateOne(
          { _id: opKey },
          { $set: { status: 'COMPLETED', result: response } },
          { session },
        );
        void this.recordDurableTokenUsage(
          actor,
          'note_rewrite',
          completion.provenance,
          opKey,
        );
        return response;
      });
    } catch (error) {
      await this.operations().updateOne(
        { _id: this.opId(actor, input.operationId), status: 'PENDING' },
        { $set: { status: 'FAILED', failureCode: 'AGENT_FAILED' } },
      );
      if (error instanceof HttpException) throw error;
      if (error instanceof XkiroError && error.code === 'TIMEOUT')
        throw new GatewayTimeoutException({
          code: 'AGENT_DEADLINE',
          message:
            'Agent timed out. Your draft is safe; retry or save without AI.',
        });
      throw new BadGatewayException({
        code: 'AGENT_OUTPUT_REJECTED',
        message:
          'Agent could not produce a valid proposal. Your draft is safe; retry or save without AI.',
      });
    } finally {
      await this.drafts().updateOne(
        {
          _id: id,
          ...this.scope(actor),
          inferenceOperationId: input.operationId,
        },
        { $unset: { inferenceOperationId: '', inferenceLeaseUntil: '' } },
      );
    }
  }

  async apply(
    headers: CaptureRequestHeaders,
    projectId: string,
    id: string,
    suggestionId: string,
    input: ApplyInput,
  ) {
    return this.mutate(
      headers,
      projectId,
      id,
      input,
      `apply:${suggestionId}`,
      async (d, actor, _db, session) => {
        const suggestion = d.state.suggestion;
        if (
          !suggestion ||
          suggestion.id !== suggestionId ||
          hash(actor.taskContext ?? null) !== d.state.suggestionTaskHash
        )
          throw conflict();
        if (
          (input.action === 'replace_title') !==
            (suggestion.operation === 'title') ||
          (input.action === 'replace_title' && !input.applyTitle) ||
          (['replace_selection', 'insert_after'].includes(input.action) &&
            suggestion.scope !== 'selection') ||
          (input.action === 'replace_body' &&
            suggestion.scope !== 'whole_note') ||
          (suggestion.scope === 'selection' && input.applyTitle)
        )
          throw new UnprocessableEntityException({
            code: 'INVALID_APPLY_ACTION',
          });
        const original = {
          title: d.state.title,
          body: d.state.contentMarkdown,
        };
        const applied = applySuggestion(
          { revision: d.revision, ...original },
          suggestion,
          input.applyTitle,
        );
        if (input.action === 'insert_after') {
          const s = suggestion.selection!;
          d.state.contentMarkdown =
            original.body.slice(0, s.end) +
            suggestion.replacementText +
            original.body.slice(s.end);
        } else d.state.contentMarkdown = applied.body;
        d.state.title = applied.title;
        if (d.state.contentMarkdown.length > 30000)
          throw new UnprocessableEntityException({
            code: 'NOTE_EDITOR_LIMIT_EXCEEDED',
          });
        if (
          d.state.title !== original.title ||
          d.state.contentMarkdown !== original.body
        ) {
          d.state.rewriteOriginal ??= original;
          d.state.hasAppliedRewrite = true;
          d.state.provenance = {
            ...d.state.suggestionProvenance,
            sourceRevision: suggestion.baseRevision,
            sourceHash: suggestion.snapshotHash,
            taskContextHash: d.state.suggestionTaskHash,
            appliedBy: actor.userId,
            appliedAt: new Date().toISOString(),
            scope: suggestion.scope,
          };
        }
        if (d.state.assessment) {
          d.state.assessment = staleAssessment(d.state.assessment);
          d.state.assessment.signals.proposalApplied = true;
        }
        d.state.suggestion = null;
        return this.write(d, session);
      },
    );
  }

  private buildReviewGovernanceOnSave(params: {
    actor: WorkNotesActor;
    noteId: string;
    version: number;
    now: Date;
    previous?: Document | null;
    autoApprove?: boolean;
  }): {
    review: Record<string, unknown>;
    knowledgeSync?: DocumentKnowledgeStatusRecord;
    previousApprovedVersion?: number;
  } {
    const { actor, noteId, version, now, previous, autoApprove } = params;
    const prevProv =
      previous?.provenance &&
      typeof previous.provenance === 'object' &&
      !Array.isArray(previous.provenance)
        ? (previous.provenance as Record<string, unknown>)
        : undefined;
    const prevReview =
      prevProv?.review && typeof prevProv.review === 'object'
        ? (prevProv.review as {
            status?: string;
            history?: DocumentVersionRecord['reviewHistory'];
          })
        : undefined;
    const prevHistory = Array.isArray(prevReview?.history)
      ? prevReview.history
      : [];
    const nowIso = now.toISOString();
    const shouldAutoApprove = Boolean(actor.canReview) && autoApprove !== false;

    if (shouldAutoApprove) {
      const reviewerRole: 'MANAGER' | 'LEADER' = actor.isManager
        ? 'MANAGER'
        : 'LEADER';
      const previousApprovedVersion =
        prevReview?.status === 'APPROVED'
          ? Math.max(1, Number(previous?.currentVersionNumber ?? 1))
          : undefined;
      return {
        review: {
          status: 'APPROVED',
          submittedAt: nowIso,
          reviewedBy: actor.userId,
          reviewedAt: nowIso,
          history: [
            ...prevHistory,
            {
              action: 'APPROVED',
              reviewerId: actor.userId,
              reviewerRole,
              at: nowIso,
            },
          ],
        },
        knowledgeSync: {
          documentId: noteId,
          version,
          status: 'QUEUED_OUTBOX',
          searchStatus: 'PENDING',
          knowledgeStatus: 'NOT_STARTED',
          searchReady: false,
          knowledgeReady: false,
          currentStage: 'OUTBOX_QUEUE',
          progress: 5,
          syncedAt: nowIso,
        },
        ...(previousApprovedVersion && previousApprovedVersion < version
          ? { previousApprovedVersion }
          : {}),
      };
    }

    return {
      review: {
        status: 'PENDING_REVIEW',
        submittedAt: nowIso,
        history: [...prevHistory],
      },
    };
  }

  private async appendTaskNoteKnowledgeOutbox(
    db: Db,
    session: ClientSession,
    params: {
      organizationId: string;
      projectId: string;
      noteId: string;
      version: number;
      previousApprovedVersion?: number;
      now: Date;
    },
  ): Promise<void> {
    const outboxCol = db.collection('outbox_events');
    if (
      params.previousApprovedVersion &&
      params.previousApprovedVersion < params.version
    ) {
      await outboxCol.insertOne(
        {
          eventName: 'KNOWLEDGE_SOURCE_REPLACED',
          aggregateType: 'WORK_NOTE',
          aggregateId: params.noteId,
          payload: {
            sourceType: 'WORK_NOTE',
            sourceId: params.noteId,
            organizationId: params.organizationId,
            projectId: params.projectId,
            previousVersion: params.previousApprovedVersion,
            version: params.version,
          },
          status: 'PENDING',
          occurredAt: params.now,
          createdAt: params.now,
          updatedAt: params.now,
        },
        { session },
      );
    }
    await outboxCol.insertOne(
      {
        eventName: 'KNOWLEDGE_SOURCE_APPROVED',
        aggregateType: 'WORK_NOTE',
        aggregateId: params.noteId,
        payload: {
          sourceType: 'WORK_NOTE',
          sourceId: params.noteId,
          organizationId: params.organizationId,
          projectId: params.projectId,
          version: params.version,
          approvedAt: params.now.toISOString(),
        },
        status: 'PENDING',
        occurredAt: params.now,
        createdAt: params.now,
        updatedAt: params.now,
      },
      { session },
    );
  }

  private canonical(row: Document, actor: WorkNotesActor): CanonicalTaskNote {
    const authorId = String(row.authorUserId);
    const manage = authorId === actor.userId || actor.canReview;
    const currentVersionNumber = Number(row.currentVersionNumber ?? 0);
    const provenance =
      row.provenance &&
      typeof row.provenance === 'object' &&
      !Array.isArray(row.provenance)
        ? (row.provenance as {
            aiChatSource?: TaskNoteAiChatSource;
            review?: {
              status?: TaskNoteReviewStatus;
              submittedAt?: string;
              reviewedBy?: string;
              reviewedAt?: string;
              comment?: string;
              history?: DocumentVersionRecord['reviewHistory'];
            };
            mdFile?: ProjectDocumentFileRecord & { version?: number };
            knowledgeSync?: DocumentKnowledgeStatusRecord;
          })
        : undefined;
    const rawReviewStatus = provenance?.review?.status;
    const reviewStatus: TaskNoteReviewStatus =
      rawReviewStatus === 'APPROVED' ||
      rawReviewStatus === 'CHANGES_REQUESTED' ||
      rawReviewStatus === 'REJECTED' ||
      rawReviewStatus === 'PENDING_REVIEW'
        ? rawReviewStatus
        : 'PENDING_REVIEW';
    const createdAtIso = new Date(row.createdAt as string).toISOString();
    const mdFile =
      reviewStatus === 'APPROVED' &&
      provenance?.mdFile &&
      typeof provenance.mdFile.name === 'string' &&
      (provenance.mdFile.version === undefined ||
        Number(provenance.mdFile.version) === Math.max(1, currentVersionNumber))
        ? {
            name: provenance.mdFile.name,
            contentType: provenance.mdFile.contentType,
            size: Number(provenance.mdFile.size ?? 0),
            ...(provenance.mdFile.sha256
              ? { sha256: provenance.mdFile.sha256 }
              : {}),
          }
        : undefined;
    const knowledgeSync =
      reviewStatus === 'APPROVED' &&
      provenance?.knowledgeSync &&
      (provenance.knowledgeSync.version === undefined ||
        Number(provenance.knowledgeSync.version) ===
          Math.max(1, currentVersionNumber))
        ? provenance.knowledgeSync
        : undefined;
    return {
      id: String(row._id),
      projectId: String(row.projectId),
      taskId: String(row.taskId),
      authorId,
      authorName: String(row.authorName ?? ''),
      type: 'TASK_NOTE',
      status: 'CONFIRMED',
      reviewStatus,
      submittedAt: provenance?.review?.submittedAt ?? createdAtIso,
      ...(provenance?.review?.reviewedBy
        ? { reviewedBy: provenance.review.reviewedBy }
        : {}),
      ...(provenance?.review?.reviewedAt
        ? { reviewedAt: provenance.review.reviewedAt }
        : {}),
      ...(typeof provenance?.review?.comment === 'string'
        ? { reviewComment: provenance.review.comment }
        : {}),
      reviewHistory: Array.isArray(provenance?.review?.history)
        ? provenance.review.history
        : [],
      ...(mdFile ? { file: mdFile } : {}),
      ...(knowledgeSync ? { knowledgeSync } : {}),
      title: String(row.title),
      contentMarkdown: legacyBody(row),
      contentSchemaVersion: 2,
      currentVersionNumber,
      ...(provenance?.aiChatSource
        ? { aiChatSource: provenance.aiChatSource }
        : {}),
      createdAt: createdAtIso,
      updatedAt: new Date(row.updatedAt as string).toISOString(),
      permissions: {
        canCreate: true,
        canEdit: manage,
        canDelete: manage,
        canSubmit: false,
        canReview: Boolean(
          actor.canReview && reviewStatus === 'PENDING_REVIEW',
        ),
        canConfigure: false,
      },
    };
  }
  private async saveReplay(
    headers: CaptureRequestHeaders,
    projectId: string,
    actor: WorkNotesActor,
    replay: OperationRow,
  ): Promise<CanonicalTaskNote> {
    const receipt = replay.result as {
      noteId: string;
      taskId: string;
      version: number;
    };
    await this.notes.getTaskNote(
      headers,
      projectId,
      receipt.taskId,
      receipt.noteId,
    );
    const row = await this.db()
      .collection('work_notes')
      .findOne({
        _id: oid(receipt.noteId),
        organizationId: oid(actor.organizationId),
        projectId: oid(projectId),
        status: 'CONFIRMED',
      });
    if (!row) throw missing();
    const version = await this.db()
      .collection('work_note_versions')
      .findOne({
        workNoteId: oid(receipt.noteId),
        versionNumber: receipt.version,
      });
    if (!version) throw missing();
    return this.canonical(
      {
        ...row,
        title: version.title as string,
        contentMarkdown: legacyBody(version),
        currentVersionNumber: receipt.version,
        updatedAt: version.createdAt as Date,
        provenance: version.provenance as unknown,
      },
      actor,
    );
  }
  private async resolveAiChatSource(
    db: Db,
    session: ClientSession,
    actor: WorkNotesActor,
    projectId: string,
    input: TaskNoteAiChatSourceInput,
  ): Promise<TaskNoteAiChatSource> {
    const documentIds = [
      ...new Set(
        input.citations
          .map((citation) => citation.documentId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const documents = documentIds.length
      ? await db
          .collection('project_documents')
          .find(
            {
              _id: { $in: documentIds.map(oid) },
              organizationId: oid(actor.organizationId),
              projectId: oid(projectId),
            },
            { session, projection: { _id: 1, title: 1 } },
          )
          .toArray()
      : [];
    const names = new Map(
      documents.map((document) => [
        String(document._id),
        String(document.title ?? '').slice(0, 240),
      ]),
    );
    if (documentIds.some((id) => !names.has(id)))
      throw new NotFoundException({
        code: 'AI_CHAT_SOURCE_NOT_FOUND',
        message: 'One or more AI Chat sources are unavailable.',
      });
    return {
      threadId: input.threadId,
      messageId: input.messageId,
      citations: input.citations.map((citation) => ({
        ...citation,
        ...(citation.documentId
          ? { documentName: names.get(citation.documentId) }
          : {}),
      })),
      sessionCitations: input.sessionCitations.map((citation) => ({
        ...citation,
        turnIds: [...citation.turnIds],
      })),
    };
  }
  async save(
    headers: CaptureRequestHeaders,
    projectId: string,
    id: string,
    input: SaveInput,
  ): Promise<CanonicalTaskNote> {
    await this.storageReady();
    const initialActor = await this.authorization.resolveProject(
      headers,
      projectId,
    );
    const payload = { kind: 'save', projectId, id, ...input };
    const replay = await this.prior(initialActor, input.operationId, payload);
    if (replay)
      return this.saveReplay(headers, projectId, initialActor, replay);
    const { actor } = await this.owned(headers, projectId, id);
    let ledger: { draft: DraftRow; noteId: string } | null = null;
    let committedMeta: {
      noteId: string;
      taskId: string;
      title: string;
      version: number;
      reviewStatus: TaskNoteReviewStatus;
    } | null = null;
    const savedNote = await this.transaction(async (db, session) => {
      const op = await this.prior(actor, input.operationId, payload, session);
      if (op) return this.saveReplay(headers, projectId, actor, op);
      const d = await this.drafts().findOne(
        {
          _id: id,
          ...this.scope(actor),
          revision: input.expectedRevision,
          expiresAt: { $gt: new Date() },
        },
        { session },
      );
      if (!d) throw conflict();
      if (!d.state.title.trim() || !d.state.contentMarkdown.trim())
        throw new UnprocessableEntityException({
          code: 'NOTE_TITLE_AND_BODY_REQUIRED',
        });
      const raw = d.state.rewriteOriginal;
      if (
        raw &&
        (raw.body !== d.state.contentMarkdown || raw.title !== d.state.title) &&
        !input.discardOriginalConfirmed
      )
        throw new UnprocessableEntityException({
          code: 'ORIGINAL_DELETION_CONFIRMATION_REQUIRED',
          message:
            'Confirm discarding the before-rewrite original for this revision.',
        });
      let previous: Document | null = null;
      if (d.noteId) {
        previous = await db.collection('work_notes').findOne(
          {
            _id: d.noteId,
            organizationId: d.organizationId,
            projectId: d.projectId,
            taskId: d.taskId,
            type: 'TASK_NOTE',
            status: 'CONFIRMED',
            ...(actor.canReview ? {} : { authorUserId: oid(actor.userId) }),
          },
          { session },
        );
        if (!previous) throw missing();
        if (
          Number(previous.currentVersionNumber ?? 0) !== d.baseNoteVersion ||
          d.state.baseNoteHash !== noteHash(previous) ||
          (d.baseNoteUpdatedAt &&
            new Date(previous.updatedAt as string).getTime() !==
              d.baseNoteUpdatedAt.getTime())
        )
          throw conflict();
      }
      const noteId = d.noteId ?? new Types.ObjectId();
      let version = d.baseNoteVersion + 1;
      const now = new Date();
      if (previous && d.baseNoteVersion === 0) {
        const latest = await db
          .collection('work_note_versions')
          .find({ workNoteId: noteId }, { session })
          .sort({ versionNumber: -1 })
          .limit(1)
          .next();
        const baseline = Number(latest?.versionNumber ?? 0) + 1;
        await db.collection('work_note_versions').insertOne(
          {
            workNoteId: noteId,
            versionNumber: baseline,
            title: previous.title,
            contentMarkdown: legacyBody(previous),
            contentSchemaVersion: 2,
            editedByUserId: previous.authorUserId,
            createdAt: previous.updatedAt ?? now,
            ...(previous.provenance ? { provenance: previous.provenance } : {}),
          },
          { session },
        );
        version = baseline + 1;
      }
      const aiChatSource = input.aiChatSource
        ? await this.resolveAiChatSource(
            db,
            session,
            actor,
            projectId,
            input.aiChatSource,
          )
        : (
            previous?.provenance as
              { aiChatSource?: TaskNoteAiChatSource } | undefined
          )?.aiChatSource;
      const bodyCharCount = d.state.contentMarkdown.trim().length;
      const effectiveAutoApprove =
        bodyCharCount >= 30 ? input.autoApprove : false;
      const shouldAutoApprove =
        Boolean(actor.canReview) && effectiveAutoApprove !== false;
      const reviewStatus: TaskNoteReviewStatus = shouldAutoApprove
        ? 'APPROVED'
        : 'PENDING_REVIEW';
      const governance = this.buildReviewGovernanceOnSave({
        actor,
        noteId: String(noteId),
        version,
        now,
        previous,
        autoApprove: effectiveAutoApprove,
      });
      const provenance = {
        kind: 'AUTHOR_SAVE',
        actorUserId: actor.userId,
        at: now.toISOString(),
        review: governance.review,
        ...(governance.knowledgeSync
          ? { knowledgeSync: governance.knowledgeSync }
          : {}),
        ...(aiChatSource ? { aiChatSource } : {}),
        ...(d.state.hasAppliedRewrite ? { agent: d.state.provenance } : {}),
      };
      const originalAuthor = previous
        ? String(previous.authorUserId)
        : actor.userId;
      if (!/^[a-f\d]{24}$/i.test(originalAuthor))
        throw new UnprocessableEntityException({ code: 'NOTE_AUTHOR_INVALID' });
      const row: Document = {
        ...(previous ?? {}),
        _id: noteId,
        organizationId: d.organizationId,
        projectId: d.projectId,
        taskId: d.taskId,
        type: 'TASK_NOTE',
        authorUserId: oid(originalAuthor),
        authorName:
          typeof previous?.authorName === 'string'
            ? previous.authorName
            : originalAuthor === actor.userId
              ? actor.userName
              : originalAuthor,
        title: d.state.title,
        contentMarkdown: d.state.contentMarkdown,
        contentSchemaVersion: 2,
        currentVersionNumber: version,
        status: 'CONFIRMED',
        authorConfirmedAt:
          previous?.authorConfirmedAt instanceof Date
            ? previous.authorConfirmedAt
            : now,
        createdAt:
          previous?.createdAt instanceof Date ? previous.createdAt : now,
        updatedAt: now,
        provenance,
      };
      delete row.whatDone;
      delete row.howSolved;
      delete row.whyThisWay;
      if (previous) {
        const replaced = await db.collection('work_notes').replaceOne(
          {
            _id: noteId,
            status: 'CONFIRMED',
            currentVersionNumber: previous.currentVersionNumber ?? {
              $exists: false,
            },
          },
          row,
          { session },
        );
        if (replaced.matchedCount !== 1) throw conflict();
      } else await db.collection('work_notes').insertOne(row, { session });
      await db.collection('work_note_versions').insertOne(
        {
          workNoteId: noteId,
          versionNumber: version,
          title: row.title,
          contentMarkdown: row.contentMarkdown,
          contentSchemaVersion: 2,
          editedByUserId: oid(actor.userId),
          createdAt: now,
          provenance,
        },
        { session },
      );
      await this.drafts().deleteOne(
        { _id: id, revision: d.revision },
        { session },
      );
      await this.operations().updateMany(
        { draftId: id, ...this.scope(actor) },
        {
          $set: {
            status: 'COMPLETED',
            result: {
              closed: true,
              assessmentSignals: d.state.assessment
                ? {
                    saved: true,
                    proposalApplied: d.state.assessment.signals.proposalApplied,
                    authorValidated: d.state.assessment.signals.authorValidated,
                    reviewerSemanticAssessment: 'NOT_ESTABLISHED',
                  }
                : undefined,
              noteId: String(noteId),
              taskId: String(d.taskId),
              version,
            },
          },
          $unset: { failureCode: '' },
        },
        { session },
      );
      await this.operations().insertOne(
        this.receipt(actor, input.operationId, id, payload, {
          noteId: String(noteId),
          taskId: String(d.taskId),
          version,
        }),
        { session },
      );
      if (shouldAutoApprove) {
        await this.appendTaskNoteKnowledgeOutbox(db, session, {
          organizationId: actor.organizationId,
          projectId,
          noteId: String(noteId),
          version,
          previousApprovedVersion: governance.previousApprovedVersion,
          now,
        });
      }
      await this.audit?.append(
        {
          organizationId: actor.organizationId,
          projectId,
          actorUserId: actor.userId,
          action: previous ? 'TASK_NOTE_UPDATED' : 'TASK_NOTE_CREATED',
          targetResource: 'WORK_NOTE',
          targetResourceId: String(noteId),
          metadata: {
            version,
            reviewStatus,
          },
        },
        session,
      );
      ledger = { draft: d, noteId: String(noteId) };
      committedMeta = {
        noteId: String(noteId),
        taskId: String(d.taskId),
        title: String(row.title),
        version,
        reviewStatus,
      };
      return this.canonical(row, actor);
    });
    // After commit, best-effort: remember answered clarifications at Task level.
    if (ledger) {
      const { draft, noteId } = ledger;
      await this.recordClarificationLedger(draft, noteId);
    }
    if (committedMeta) {
      const meta: {
        noteId: string;
        taskId: string;
        title: string;
        version: number;
        reviewStatus: TaskNoteReviewStatus;
      } = committedMeta;
      await this.notes.afterTaskNoteSaved?.({
        headers,
        actor,
        projectId,
        taskId: meta.taskId,
        noteId: meta.noteId,
        title: meta.title,
        version: meta.version,
        reviewStatus: meta.reviewStatus,
      });
    }
    return savedNote;
  }
  async versions(
    headers: CaptureRequestHeaders,
    projectId: string,
    taskId: string,
    noteId: string,
    page: number,
    pageSize: number,
  ) {
    await this.storageReady();
    await this.notes.getTaskNote(headers, projectId, taskId, noteId);
    const filter = { workNoteId: oid(noteId) };
    const collection = this.db().collection('work_note_versions');
    const [rows, totalItems] = await Promise.all([
      collection
        .find(filter)
        .sort({ versionNumber: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      collection.countDocuments(filter),
    ]);
    return {
      data: rows.map((r) => ({
        versionNumber: Number(r.versionNumber),
        title: String(r.title),
        contentMarkdown: legacyBody(r),
        createdAt: new Date(r.createdAt as string).toISOString(),
      })),
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }
  async restore(
    headers: CaptureRequestHeaders,
    projectId: string,
    taskId: string,
    noteId: string,
    input: RestoreInput,
  ) {
    await this.storageReady();
    const actor = await this.authorization.resolveTask(
      headers,
      projectId,
      taskId,
    );
    const note = await this.notes.getTaskNote(
      headers,
      projectId,
      taskId,
      noteId,
    );
    if (!note.permissions.canEdit)
      throw new ForbiddenException({ code: 'NOTE_EDIT_DENIED' });
    const payload = { kind: 'restore', projectId, taskId, noteId, ...input };
    const replay = await this.prior(actor, input.operationId, payload);
    if (replay) return this.saveReplay(headers, projectId, actor, replay);
    let committedRestore: {
      title: string;
      version: number;
      reviewStatus: TaskNoteReviewStatus;
    } | null = null;
    const restoredNote = await this.transaction(async (db, session) => {
      const prior = await this.prior(
        actor,
        input.operationId,
        payload,
        session,
      );
      if (prior) return this.saveReplay(headers, projectId, actor, prior);
      const previous = await db.collection('work_notes').findOne(
        {
          _id: oid(noteId),
          organizationId: oid(actor.organizationId),
          projectId: oid(projectId),
          taskId: oid(taskId),
          status: 'CONFIRMED',
          currentVersionNumber: input.expectedVersion,
        },
        { session },
      );
      if (!previous) throw conflict();
      const historic = await db
        .collection('work_note_versions')
        .findOne(
          { workNoteId: oid(noteId), versionNumber: input.versionNumber },
          { session },
        );
      if (!historic) throw missing();
      const now = new Date(),
        version = input.expectedVersion + 1;
      const historicProvenance = historic.provenance as
        { aiChatSource?: TaskNoteAiChatSource } | undefined;
      const governance = this.buildReviewGovernanceOnSave({
        actor,
        noteId,
        version,
        now,
        previous,
      });
      const provenance = {
        kind: 'RESTORE',
        restoredVersion: input.versionNumber,
        actorUserId: actor.userId,
        at: now.toISOString(),
        review: governance.review,
        ...(governance.knowledgeSync
          ? { knowledgeSync: governance.knowledgeSync }
          : {}),
        ...(historicProvenance?.aiChatSource
          ? { aiChatSource: historicProvenance.aiChatSource }
          : {}),
      };
      const row: Document = {
        ...previous,
        title: String(historic.title),
        contentMarkdown: legacyBody(historic),
        contentSchemaVersion: 2,
        currentVersionNumber: version,
        updatedAt: now,
        provenance,
      };
      delete row.whatDone;
      delete row.howSolved;
      delete row.whyThisWay;
      const replaced = await db.collection('work_notes').replaceOne(
        {
          _id: previous._id,
          status: 'CONFIRMED',
          currentVersionNumber: input.expectedVersion,
        },
        row,
        { session },
      );
      if (replaced.matchedCount !== 1) throw conflict();
      await db.collection('work_note_versions').insertOne(
        {
          workNoteId: previous._id,
          versionNumber: version,
          title: row.title,
          contentMarkdown: row.contentMarkdown,
          contentSchemaVersion: 2,
          editedByUserId: oid(actor.userId),
          provenance,
          createdAt: now,
        },
        { session },
      );
      if (actor.canReview) {
        await this.appendTaskNoteKnowledgeOutbox(db, session, {
          organizationId: actor.organizationId,
          projectId,
          noteId,
          version,
          previousApprovedVersion: governance.previousApprovedVersion,
          now,
        });
      }
      await this.operations().insertOne(
        this.receipt(actor, input.operationId, `restore:${noteId}`, payload, {
          noteId,
          taskId,
          version,
        }),
        { session },
      );
      await this.audit?.append(
        {
          organizationId: actor.organizationId,
          projectId,
          actorUserId: actor.userId,
          action: 'TASK_NOTE_RESTORED',
          targetResource: 'WORK_NOTE',
          targetResourceId: noteId,
          metadata: { version, restoredVersion: input.versionNumber },
        },
        session,
      );
      committedRestore = {
        title: String(row.title),
        version,
        reviewStatus: actor.canReview ? 'APPROVED' : 'PENDING_REVIEW',
      };
      return this.canonical(row, actor);
    });
    if (committedRestore) {
      const meta: {
        title: string;
        version: number;
        reviewStatus: TaskNoteReviewStatus;
      } = committedRestore;
      await this.notes.afterTaskNoteSaved?.({
        headers,
        actor,
        projectId,
        taskId,
        noteId,
        title: meta.title,
        version: meta.version,
        reviewStatus: meta.reviewStatus,
      });
    }
    return restoredNote;
  }
}
