import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type Connection, type ClientSession } from 'mongoose';
import type { Document } from 'mongodb';
import { createHash, randomUUID } from 'node:crypto';
import {
  WorkNoteAgentDraftsService,
  type DraftRow,
} from './work-note-agent-drafts.service';
import { WorkNotesAuthorizationService } from '../work-notes-authorization.service';
import { WorkNotesService } from '../work-notes.service';
import { WorkNoteAgentModel } from '../../infrastructure/ai/work-note-agent.model';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { CAPTURE_PERSISTENCE } from '../../infrastructure/persistence';
import type {
  CaptureRequestHeaders,
  WorkNotesActor,
  ProjectDocumentRecord,
  WorkReportRecord,
  DocumentType,
} from '../work-notes.types';
import type {
  SaveInput,
  RestoreInput,
  AgentDraftView,
} from './work-note-agent-drafts.types';

export type EditorWorkflow = 'PROJECT_DOCUMENT' | 'WORK_REPORT';
export type CreateEditorInput =
  | {
      operationId: string;
      workflow: 'PROJECT_DOCUMENT';
      documentId?: string;
      documentType?: DocumentType;
    }
  | { operationId: string; workflow: 'WORK_REPORT'; reportId: string };
type Identity = {
  workflow: EditorWorkflow;
  resourceId: Types.ObjectId | null;
  context: Record<string, unknown>;
};
type Source = {
  identity: Identity;
  raw: Document | null;
  rawVersion: Document | null;
  record: ProjectDocumentRecord | WorkReportRecord | null;
  title: string;
  body: string;
  version: number;
  hash: string;
};
const oid = (v: string) => new Types.ObjectId(v);
const fingerprint = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
const unavailable = () =>
  new NotFoundException({ code: 'EDITOR_SOURCE_UNAVAILABLE' });
const stale = () =>
  new ConflictException({
    code: 'EDITOR_SOURCE_CONFLICT',
    message: 'The source changed. Reload before saving or restoring.',
  });
const invalid = () =>
  new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
const reportBody = (r: Document) =>
  r.contentSchemaVersion === 2
    ? String(r.contentMarkdown ?? '')
    : [
          ['Accomplishments', r.accomplishments],
          ['Approach', r.approach],
          ['Reason', r.reason],
          ['Blockers', r.blockers],
          ['Next steps', r.nextSteps],
        ].some(([, v]) => typeof v === 'string' && v.trim())
      ? [
          ['Accomplishments', r.accomplishments],
          ['Approach', r.approach],
          ['Reason', r.reason],
          ['Blockers', r.blockers],
          ['Next steps', r.nextSteps],
        ]
          .filter(([, v]) => typeof v === 'string' && v.length)
          .map(([k, v]) => `## ${k}\n${v}`)
          .join('\n\n')
      : '';
const documentTypes = [
  'MVP',
  'DATABASE_DESIGN',
  'RSR',
  'ARCHITECTURE',
  'API_SPECIFICATION',
  'RESEARCH',
  'REQUIREMENT',
  'DESIGN',
  'TECHNICAL_SPECIFICATION',
  'OTHER',
];

/** Reuses the Task editor's transient engine; source persistence stays workflow-specific. */
@Injectable()
export class WorkNoteEditorService extends WorkNoteAgentDraftsService {
  constructor(
    config: ConfigService,
    auth: WorkNotesAuthorizationService,
    notes: WorkNotesService,
    model: WorkNoteAgentModel,
    redis: RedisService,
    @Optional()
    @InjectConnection(CAPTURE_PERSISTENCE.databaseName)
    connection?: Connection,
    @Optional() audit?: AuditService,
  ) {
    super(config, auth, notes, model, redis, connection, audit);
  }
  protected override async storageReady() {
    const flag = this.config.get<boolean | string>(
      'WORKNOTE_SHARED_EDITOR_ENABLED',
    );
    if (flag !== true && flag !== 'true')
      throw new ServiceUnavailableException({
        code: 'WORKNOTE_EDITOR_UNAVAILABLE',
      });
    await super.storageReady();
    for (const [name, key] of [
      ['work_report_versions', 'reportId'],
      ['project_document_editor_versions', 'documentId'],
    ]) {
      try {
        const indexes = (await this.db()
          .collection(name)
          .listIndexes()
          .toArray()) as { unique?: boolean; key: unknown }[];
        if (
          !indexes.some(
            (i) =>
              i.unique === true &&
              JSON.stringify(i.key) ===
                JSON.stringify({ [key]: 1, versionNumber: 1 }),
          )
        )
          throw Error('index');
      } catch {
        throw new ServiceUnavailableException({
          code: 'WORKNOTE_EDITOR_STORAGE_NOT_READY',
        });
      }
    }
  }
  protected override async owned(
    headers: CaptureRequestHeaders,
    projectId: string,
    id: string,
  ) {
    await this.storageReady();
    const actor = await this.authorization.resolveProject(headers, projectId);
    const draft = await this.drafts().findOne({
      _id: id,
      ...this.scope(actor),
      workflow: { $in: ['PROJECT_DOCUMENT', 'WORK_REPORT'] },
      expiresAt: { $gt: new Date() },
    });
    if (!draft) throw unavailable();
    await this.source(actor, this.identity(draft), true);
    return { actor, draft };
  }
  private identity(d: DraftRow): Identity {
    if (d.workflow !== 'PROJECT_DOCUMENT' && d.workflow !== 'WORK_REPORT')
      throw unavailable();
    return {
      workflow: d.workflow,
      resourceId: d.resourceId ?? null,
      context: d.context ?? {},
    };
  }
  private async source(
    actor: WorkNotesActor,
    identity: Identity,
    write: boolean,
    session?: ClientSession,
  ): Promise<Source> {
    const { workflow, resourceId } = identity;
    if (!resourceId) {
      if (
        workflow !== 'PROJECT_DOCUMENT' ||
        !documentTypes.includes(String(identity.context.documentType))
      )
        throw invalid();
      return {
        identity,
        raw: null,
        rawVersion: null,
        record: null,
        title: '',
        body: '',
        version: 0,
        hash: fingerprint(identity.context),
      };
    }
    const record = await this.notes.editorSourceRecord(
      actor,
      workflow,
      String(resourceId),
      session,
    );
    if (write && !record.permissions.canEdit)
      throw new ForbiddenException({ code: 'EDITOR_EDIT_DENIED' });
    const filter = {
      _id: resourceId,
      organizationId: oid(actor.organizationId),
      projectId: oid(actor.projectId),
    };
    const raw = await this.db()
      .collection(
        workflow === 'PROJECT_DOCUMENT' ? 'project_documents' : 'work_reports',
      )
      .findOne(filter, { session });
    if (!raw) throw unavailable();
    const rawVersion =
      workflow === 'PROJECT_DOCUMENT'
        ? await this.db().collection('project_document_versions').findOne(
            {
              documentId: resourceId,
              versionNumber: raw.currentVersionNumber,
              organizationId: filter.organizationId,
              projectId: filter.projectId,
            },
            { session },
          )
        : null;
    if (workflow === 'PROJECT_DOCUMENT' && !rawVersion) throw unavailable();
    const body =
      workflow === 'PROJECT_DOCUMENT'
        ? String(rawVersion!.content ?? '')
        : reportBody(raw);
    const title =
      workflow === 'PROJECT_DOCUMENT'
        ? String(raw.title)
        : typeof raw.title === 'string'
          ? raw.title
          : `Work report ${new Date(raw.periodStart as string).toISOString().slice(0, 10)}`;
    const version = Number(
      workflow === 'PROJECT_DOCUMENT'
        ? (raw.editorVersionNumber ?? 0)
        : (raw.currentVersionNumber ?? 0),
    );
    const context =
      workflow === 'PROJECT_DOCUMENT'
        ? { documentType: String(raw.documentType) }
        : {
            reportScope: String(raw.reportScope ?? 'MEMBER'),
            periodStart: new Date(raw.periodStart as string).toISOString(),
            periodEnd: new Date(raw.periodEnd as string).toISOString(),
            dueAt: new Date(raw.dueAt as string).toISOString(),
          };
    const hash = fingerprint([
      workflow,
      String(resourceId),
      version,
      raw.currentVersionNumber,
      raw.updatedAt,
      raw.status,
      raw.createdByUserId ?? raw.memberUserId,
      title,
      body,
      context,
      rawVersion?.file ?? raw.file ?? null,
    ]);
    return {
      identity: { workflow, resourceId, context },
      raw,
      rawVersion,
      record,
      title,
      body,
      version,
      hash,
    };
  }
  async createEditor(
    headers: CaptureRequestHeaders,
    projectId: string,
    input: CreateEditorInput,
  ): Promise<AgentDraftView> {
    await this.storageReady();
    const actor = await this.authorization.resolveProject(headers, projectId);
    const identity: Identity =
      input.workflow === 'PROJECT_DOCUMENT'
        ? {
            workflow: input.workflow,
            resourceId: input.documentId ? oid(input.documentId) : null,
            context: input.documentType
              ? { documentType: input.documentType }
              : {},
          }
        : {
            workflow: input.workflow,
            resourceId: oid(input.reportId),
            context: {},
          };
    const source = await this.source(actor, identity, true);
    if (source.body.length > 30000 || source.title.length > 300)
      throw new UnprocessableEntityException({
        code: 'NOTE_EDITOR_LIMIT_EXCEEDED',
      });
    const payload = { kind: 'editor-create', projectId, ...input };
    const replay = await this.prior(actor, input.operationId, payload);
    if (replay) return this.replayDraft(replay);
    const now = new Date();
    const d: DraftRow = {
      _id: randomUUID(),
      ...this.scope(actor),
      workflow: identity.workflow,
      resourceId: identity.resourceId,
      context: source.identity.context,
      taskId: null,
      noteId: null,
      baseNoteVersion: source.version,
      revision: 1,
      state: {
        baseNoteHash: source.hash,
        title: source.title,
        contentMarkdown: source.body,
        hasAppliedRewrite: false,
        conversation: [],
        clarifications: [],
        pendingQuestion: null,
        suggestion: null,
        messageTurns: 0,
      },
      expiresAt: new Date(now.getTime() + 86400000),
      createdAt: now,
      updatedAt: now,
    };
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
  async resumeEditor(
    headers: CaptureRequestHeaders,
    projectId: string,
    workflow: EditorWorkflow,
    resourceId?: string,
    documentType?: DocumentType,
  ) {
    await this.storageReady();
    const actor = await this.authorization.resolveProject(headers, projectId);
    await this.source(
      actor,
      {
        workflow,
        resourceId: resourceId ? oid(resourceId) : null,
        context: documentType ? { documentType } : {},
      },
      true,
    );
    const d = await this.drafts().findOne(
      {
        ...this.scope(actor),
        workflow,
        resourceId: resourceId ? oid(resourceId) : null,
        ...(!resourceId ? { 'context.documentType': documentType } : {}),
        expiresAt: { $gt: new Date() },
      },
      { sort: { updatedAt: -1 } },
    );
    return d ? this.get(headers, projectId, d._id) : null;
  }
  private versionsCollection(workflow: EditorWorkflow) {
    return this.db().collection(
      workflow === 'PROJECT_DOCUMENT'
        ? 'project_document_editor_versions'
        : 'work_report_versions',
    );
  }
  private versionFilter(
    actor: WorkNotesActor,
    workflow: EditorWorkflow,
    resourceId: Types.ObjectId,
  ) {
    return {
      organizationId: oid(actor.organizationId),
      projectId: oid(actor.projectId),
      [workflow === 'PROJECT_DOCUMENT' ? 'documentId' : 'reportId']: resourceId,
    };
  }
  private async snapshot(
    actor: WorkNotesActor,
    workflow: EditorWorkflow,
    id: Types.ObjectId,
    version: number,
    title: string,
    body: string,
    canonical: ProjectDocumentRecord | WorkReportRecord,
    session: ClientSession,
    provenance: Record<string, unknown>,
  ) {
    await this.versionsCollection(workflow).insertOne(
      {
        ...this.versionFilter(actor, workflow, id),
        versionNumber: version,
        ...(workflow === 'PROJECT_DOCUMENT'
          ? {
              documentVersionNumber: (canonical as ProjectDocumentRecord)
                .version,
            }
          : {}),
        title,
        contentMarkdown: body,
        canonicalResult: canonical,
        editedByUserId: oid(actor.userId),
        createdAt: new Date(),
        provenance,
      },
      { session },
    );
  }
  private async commitSource(
    actor: WorkNotesActor,
    d: DraftRow,
    session: ClientSession,
    kind = 'AUTHOR_SAVE',
  ) {
    const source = await this.source(actor, this.identity(d), true, session);
    if (
      source.version !== d.baseNoteVersion ||
      source.hash !== d.state.baseNoteHash
    )
      throw stale();
    if (
      !d.state.title.trim() ||
      !d.state.contentMarkdown.trim() ||
      d.state.contentMarkdown.length > 30000 ||
      d.state.title.length > (d.workflow === 'PROJECT_DOCUMENT' ? 240 : 300)
    )
      throw invalid();
    const workflow = source.identity.workflow,
      id = source.identity.resourceId ?? new Types.ObjectId(),
      now = new Date();
    let version = source.version + 1;
    if (
      source.version === 0 &&
      source.record &&
      (workflow === 'PROJECT_DOCUMENT' || source.body.trim())
    ) {
      await this.snapshot(
        actor,
        workflow,
        id,
        1,
        source.title,
        source.body,
        source.record,
        session,
        { kind: 'LEGACY_CANONICAL_BASELINE' },
      );
      version = 2;
    }
    if (
      workflow === 'PROJECT_DOCUMENT' &&
      source.version > 0 &&
      source.record
    ) {
      const previous = await this.versionsCollection(workflow).findOne(
        {
          ...this.versionFilter(actor, workflow, id),
          versionNumber: source.version,
        },
        { session },
      );
      if (!previous) throw stale();
      const canonical = previous.canonicalResult as
        ProjectDocumentRecord | undefined;
      if (
        previous.title !== source.title ||
        previous.contentMarkdown !== source.body ||
        canonical?.description !==
          (source.record as ProjectDocumentRecord).description ||
        canonical?.type !== (source.record as ProjectDocumentRecord).type
      ) {
        await this.snapshot(
          actor,
          workflow,
          id,
          version,
          source.title,
          source.body,
          source.record,
          session,
          { kind: 'LEGACY_CANONICAL_BASELINE' },
        );
        version++;
      }
    }
    const provenance = {
      kind,
      actorUserId: actor.userId,
      at: now.toISOString(),
      ...(d.state.hasAppliedRewrite ? { agent: d.state.provenance } : {}),
    };
    const scope = {
      organizationId: oid(actor.organizationId),
      projectId: oid(actor.projectId),
    };
    if (workflow === 'PROJECT_DOCUMENT') {
      const previous = source.raw;
      const documentVersion = previous
        ? Number(previous.currentVersionNumber) +
          (['APPROVED', 'REJECTED'].includes(String(previous.status)) ? 1 : 0)
        : 1;
      const common = {
        title: d.state.title,
        documentType: source.identity.context.documentType,
        status: 'DRAFT',
        updatedAt: now,
      };
      if (previous) {
        const updated = await this.db()
          .collection('project_documents')
          .updateOne(
            {
              _id: id,
              ...scope,
              currentVersionNumber: previous.currentVersionNumber,
              updatedAt: previous.updatedAt,
            },
            {
              $set: {
                ...common,
                editorVersionNumber: version,
                currentVersionNumber: documentVersion,
                updatedByUserId: oid(actor.userId),
              },
            },
            { session },
          );
        if (updated.matchedCount !== 1) throw stale();
      } else
        await this.db()
          .collection('project_documents')
          .insertOne(
            {
              _id: id,
              ...scope,
              ...common,
              currentVersionNumber: 1,
              editorVersionNumber: version,
              createdByUserId: oid(actor.userId),
              updatedByUserId: oid(actor.userId),
              createdAt: now,
            },
            { session },
          );
      const versionFilter = {
        documentId: id,
        versionNumber: documentVersion,
        ...scope,
      };
      if (previous && documentVersion === previous.currentVersionNumber) {
        const updated = await this.db()
          .collection('project_document_versions')
          .updateOne(
            {
              ...versionFilter,
              status: { $in: ['DRAFT', 'CHANGES_REQUESTED'] },
              editedByUserId: oid(actor.userId),
            },
            {
              $set: { ...common, content: d.state.contentMarkdown, provenance },
            },
            { session },
          );
        if (updated.matchedCount !== 1) throw stale();
      } else
        await this.db()
          .collection('project_document_versions')
          .insertOne(
            {
              _id: new Types.ObjectId(),
              ...versionFilter,
              ...common,
              content: d.state.contentMarkdown,
              ...(source.rawVersion?.file
                ? { file: source.rawVersion.file }
                : {}),
              ...(source.rawVersion?.description !== undefined
                ? { description: source.rawVersion.description }
                : {}),
              editedByUserId: oid(actor.userId),
              reviewHistory: [],
              createdAt: now,
              provenance,
            },
            { session },
          );
    } else {
      const updated = await this.db()
        .collection('work_reports')
        .updateOne(
          {
            _id: id,
            ...scope,
            memberUserId: oid(actor.userId),
            status: { $in: ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'] },
            updatedAt: source.raw!.updatedAt,
          },
          {
            $set: {
              title: d.state.title,
              contentMarkdown: d.state.contentMarkdown,
              contentSchemaVersion: 2,
              currentVersionNumber: version,
              provenance,
              updatedAt: now,
            },
            $unset: {
              accomplishments: '',
              approach: '',
              reason: '',
              blockers: '',
              nextSteps: '',
            },
          },
          { session },
        );
      if (updated.matchedCount !== 1) throw stale();
    }
    const canonical = await this.notes.editorSourceRecord(
      actor,
      workflow,
      String(id),
      session,
    );
    await this.snapshot(
      actor,
      workflow,
      id,
      version,
      d.state.title,
      d.state.contentMarkdown,
      canonical,
      session,
      provenance,
    );
    await this.audit?.append(
      {
        organizationId: actor.organizationId,
        projectId: actor.projectId,
        actorUserId: actor.userId,
        action:
          workflow === 'PROJECT_DOCUMENT'
            ? source.raw
              ? 'DOCUMENT_DRAFT_UPDATED'
              : 'DOCUMENT_CREATED'
            : 'REPORT_DRAFT_SAVED',
        targetResource: workflow,
        targetResourceId: String(id),
        metadata: { editorVersion: version, kind },
      },
      session,
    );
    return { canonical, workflow, resourceId: String(id), version };
  }
  private async replayEditorSave(
    headers: CaptureRequestHeaders,
    projectId: string,
    result: unknown,
  ) {
    const receipt = result as {
      resourceId: string;
      workflow: EditorWorkflow;
      version: number;
    };
    if (
      !receipt?.resourceId ||
      !['PROJECT_DOCUMENT', 'WORK_REPORT'].includes(receipt.workflow)
    )
      throw stale();
    const actor = await this.authorization.resolveProject(headers, projectId);
    const current = await this.notes.editorSourceRecord(
      actor,
      receipt.workflow,
      receipt.resourceId,
    );
    const saved = await this.versionsCollection(receipt.workflow).findOne({
      ...this.versionFilter(actor, receipt.workflow, oid(receipt.resourceId)),
      versionNumber: receipt.version,
    });
    if (!saved?.canonicalResult) throw unavailable();
    return {
      ...(saved.canonicalResult as ProjectDocumentRecord | WorkReportRecord),
      permissions: current.permissions,
    };
  }
  async saveEditor(
    headers: CaptureRequestHeaders,
    projectId: string,
    id: string,
    input: SaveInput,
  ) {
    await this.storageReady();
    const actor = await this.authorization.resolveProject(headers, projectId);
    const payload = { kind: 'editor-save', projectId, id, ...input };
    const replay = await this.prior(actor, input.operationId, payload);
    if (replay) return this.replayEditorSave(headers, projectId, replay.result);
    await this.owned(headers, projectId, id);
    return this.transaction(async (_db, session) => {
      const existing = await this.prior(
        actor,
        input.operationId,
        payload,
        session,
      );
      if (existing)
        return this.replayEditorSave(headers, projectId, existing.result);
      const d = await this.drafts().findOne(
        {
          _id: id,
          ...this.scope(actor),
          revision: input.expectedRevision,
          expiresAt: { $gt: new Date() },
        },
        { session },
      );
      if (!d) throw stale();
      const raw = d.state.rewriteOriginal;
      if (
        raw &&
        (raw.title !== d.state.title || raw.body !== d.state.contentMarkdown) &&
        !input.discardOriginalConfirmed
      )
        throw new UnprocessableEntityException({
          code: 'ORIGINAL_DELETION_CONFIRMATION_REQUIRED',
        });
      const saved = await this.commitSource(actor, d, session);
      const receipt = {
        closed: true,
        resourceId: saved.resourceId,
        workflow: saved.workflow,
        version: saved.version,
      };
      await this.drafts().deleteOne(
        { _id: id, revision: d.revision },
        { session },
      );
      await this.operations().updateMany(
        { draftId: id, ...this.scope(actor) },
        {
          $set: { status: 'COMPLETED', result: receipt },
          $unset: { failureCode: '' },
        },
        { session },
      );
      await this.operations().insertOne(
        this.receipt(actor, input.operationId, id, payload, receipt),
        { session },
      );
      return saved.canonical;
    });
  }
  async editorVersions(
    headers: CaptureRequestHeaders,
    projectId: string,
    workflow: EditorWorkflow,
    id: string,
    page: number,
    pageSize: number,
  ) {
    await this.storageReady();
    const actor = await this.authorization.resolveProject(headers, projectId);
    await this.notes.editorSourceRecord(actor, workflow, id);
    const filter = this.versionFilter(actor, workflow, oid(id)),
      collection = this.versionsCollection(workflow);
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
        contentMarkdown: String(r.contentMarkdown),
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
  async updateReportLinks(
    headers: CaptureRequestHeaders,
    projectId: string,
    id: string,
    documentIds: string[],
  ) {
    await this.storageReady();
    const actor = await this.authorization.resolveProject(headers, projectId);
    await this.source(
      actor,
      { workflow: 'WORK_REPORT', resourceId: oid(id), context: {} },
      true,
    );
    if (
      documentIds.length > 30 ||
      new Set(documentIds).size !== documentIds.length ||
      documentIds.some((v) => !/^[a-f\d]{24}$/i.test(v))
    )
      throw invalid();
    for (const documentId of documentIds)
      await this.notes.editorSourceRecord(
        actor,
        'PROJECT_DOCUMENT',
        documentId,
      );
    await this.transaction(async (_db, session) => {
      await this.source(
        actor,
        { workflow: 'WORK_REPORT', resourceId: oid(id), context: {} },
        true,
        session,
      );
      const result = await this.db()
        .collection('work_reports')
        .updateOne(
          {
            _id: oid(id),
            organizationId: oid(actor.organizationId),
            projectId: oid(projectId),
            memberUserId: oid(actor.userId),
            status: { $in: ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'] },
          },
          { $set: { documentIds, updatedAt: new Date() } },
          { session },
        );
      if (result.matchedCount !== 1) throw stale();
      await this.audit?.append(
        {
          organizationId: actor.organizationId,
          projectId,
          actorUserId: actor.userId,
          action: 'REPORT_DOCUMENT_LINKS_UPDATED',
          targetResource: 'WORK_REPORT',
          targetResourceId: id,
          metadata: { linkedDocuments: documentIds.length },
        },
        session,
      );
    });
    return this.notes.editorSourceRecord(actor, 'WORK_REPORT', id);
  }
  async restoreEditor(
    headers: CaptureRequestHeaders,
    projectId: string,
    workflow: EditorWorkflow,
    id: string,
    input: RestoreInput & { expectedContentHash: string },
  ) {
    await this.storageReady();
    const actor = await this.authorization.resolveProject(headers, projectId);
    const identity = { workflow, resourceId: oid(id), context: {} };
    await this.source(actor, identity, true);
    const payload = {
      kind: 'editor-restore',
      projectId,
      workflow,
      id,
      ...input,
    };
    const replay = await this.prior(actor, input.operationId, payload);
    if (replay) return this.replayEditorSave(headers, projectId, replay.result);
    return this.transaction(async (_db, session) => {
      const prior = await this.prior(
        actor,
        input.operationId,
        payload,
        session,
      );
      if (prior) return this.replayEditorSave(headers, projectId, prior.result);
      const source = await this.source(actor, identity, true, session);
      if (
        source.version !== input.expectedVersion ||
        source.hash !== input.expectedContentHash
      )
        throw stale();
      const snapshot = await this.versionsCollection(workflow).findOne(
        {
          ...this.versionFilter(actor, workflow, oid(id)),
          versionNumber: input.versionNumber,
        },
        { session },
      );
      if (!snapshot) throw unavailable();
      const now = new Date();
      const d: DraftRow = {
        _id: randomUUID(),
        ...this.scope(actor),
        workflow,
        resourceId: oid(id),
        context: source.identity.context,
        taskId: null,
        noteId: null,
        baseNoteVersion: source.version,
        revision: 1,
        state: {
          baseNoteHash: source.hash,
          title: String(snapshot.title),
          contentMarkdown: String(snapshot.contentMarkdown),
          hasAppliedRewrite: false,
          conversation: [],
          clarifications: [],
          pendingQuestion: null,
          suggestion: null,
          messageTurns: 0,
        },
        expiresAt: now,
        createdAt: now,
        updatedAt: now,
      };
      const saved = await this.commitSource(actor, d, session, 'RESTORE');
      const receipt = {
        closed: true,
        resourceId: id,
        workflow,
        version: saved.version,
      };
      await this.operations().insertOne(
        this.receipt(actor, input.operationId, d._id, payload, receipt),
        { session },
      );
      return saved.canonical;
    });
  }
}
