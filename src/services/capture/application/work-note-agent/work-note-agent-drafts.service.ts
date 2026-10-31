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
  RestoreInput,
  RevisionOperation,
  SaveInput,
  UpdateDraftInput,
} from './work-note-agent-drafts.types';

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
type MessageResponse = AgentResult & { sourceRevision: number };
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
        ? { id: q.id, text: q.text, reason: q.reason, options: q.options }
        : null,
      suggestion: d.state.suggestion,
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
      request = {
        ...q.request,
        ...input,
        operation: q.request.operation,
        scope: q.request.scope,
        instruction: q.request.instruction,
        selection: q.request.selection,
      };
      clarifications.push({
        id: q.id,
        question: q.text,
        state: input.questionDisposition!,
        ...(input.questionDisposition === 'answered'
          ? { answer: input.answer }
          : {}),
      });
    }
    const agentInput: AgentInput = {
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
    try {
      prepareAgentRequest(agentInput);
    } catch (error) {
      if (error instanceof AgentValidationError) {
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
      }
      throw error;
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
        const question = result.questions[0];
        const questionId = question ? randomUUID() : null;
        current.state.clarifications = clarifications;
        current.state.conversation.push(
          { role: 'user', content: input.answer ?? input.instruction },
          { role: 'assistant', content: result.message },
        );
        current.state.conversation = current.state.conversation.slice(-40);
        current.state.pendingQuestion = question
          ? { ...question, id: questionId!, request }
          : null;
        current.state.suggestion = result.suggestion;
        current.state.suggestionTaskHash = hash(actor.taskContext ?? null);
        current.state.suggestionProvenance = completion.provenance;
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
        };
        await this.operations().updateOne(
          { _id: this.opId(actor, input.operationId) },
          { $set: { status: 'COMPLETED', result: response } },
          { session },
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

  private canonical(row: Document, actor: WorkNotesActor): CanonicalTaskNote {
    const manage = String(row.authorUserId) === actor.userId || actor.canReview;
    return {
      id: String(row._id),
      projectId: String(row.projectId),
      taskId: String(row.taskId),
      authorId: String(row.authorUserId),
      authorName: String(row.authorName ?? ''),
      type: 'TASK_NOTE',
      status: 'CONFIRMED',
      title: String(row.title),
      contentMarkdown: legacyBody(row),
      contentSchemaVersion: 2,
      currentVersionNumber: Number(row.currentVersionNumber ?? 0),
      createdAt: new Date(row.createdAt as string).toISOString(),
      updatedAt: new Date(row.updatedAt as string).toISOString(),
      permissions: {
        canCreate: true,
        canEdit: manage,
        canDelete: manage,
        canSubmit: false,
        canReview: false,
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
      },
      actor,
    );
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
    return this.transaction(async (db, session) => {
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
          },
          { session },
        );
        version = baseline + 1;
      }
      const provenance = {
        kind: 'AUTHOR_SAVE',
        actorUserId: actor.userId,
        at: now.toISOString(),
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
      await this.audit?.append(
        {
          organizationId: actor.organizationId,
          projectId,
          actorUserId: actor.userId,
          action: previous ? 'TASK_NOTE_UPDATED' : 'TASK_NOTE_CREATED',
          targetResource: 'WORK_NOTE',
          targetResourceId: String(noteId),
          metadata: { version },
        },
        session,
      );
      return this.canonical(row, actor);
    });
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
    return this.transaction(async (db, session) => {
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
      const row: Document = {
        ...previous,
        title: String(historic.title),
        contentMarkdown: legacyBody(historic),
        contentSchemaVersion: 2,
        currentVersionNumber: version,
        updatedAt: now,
        provenance: {
          kind: 'RESTORE',
          restoredVersion: input.versionNumber,
          actorUserId: actor.userId,
          at: now.toISOString(),
        },
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
          provenance: {
            kind: 'RESTORE',
            restoredVersion: input.versionNumber,
          },
          createdAt: now,
        },
        { session },
      );
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
      return this.canonical(row, actor);
    });
  }
}
