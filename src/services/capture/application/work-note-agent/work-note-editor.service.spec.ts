import { ConfigService } from '@nestjs/config';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { WorkNoteEditorService } from './work-note-editor.service';
import { WorkNotesService } from '../work-notes.service';
import type { WorkNotesAuthorizationService } from '../work-notes-authorization.service';
import type { WorkNoteAgentModel } from '../../infrastructure/ai/work-note-agent.model';
import type { RedisService } from '../../infrastructure/redis/redis.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import {
  parseAgentResult,
  prepareAgentRequest,
  type AgentInput,
} from './work-note-agent';
describe('Document / Report editor transaction and workflow preservation', () => {
  jest.setTimeout(90000);
  let repl: MongoMemoryReplSet,
    connection: Connection,
    service: WorkNoteEditorService,
    notes: WorkNotesService;
  const projectId = new Types.ObjectId().toHexString(),
    organizationId = new Types.ObjectId().toHexString(),
    userId = new Types.ObjectId().toHexString();
  const headers = { authorization: 'Bearer synthetic' };
  const actor = {
    userId,
    userName: 'Synthetic author',
    organizationId,
    projectId,
    canReview: false,
    canConfigure: false,
  };
  const auth = {
    resolveProject: jest.fn(() => Promise.resolve(actor)),
    resolveTask: jest.fn(() => {
      throw Error('No Task lookup is permitted');
    }),
  };
  const model = {
    rewrite: jest.fn((input: AgentInput) =>
      Promise.resolve({
        result: parseAgentResult(
          prepareAgentRequest(input),
          JSON.stringify({
            status: 'SUGGESTION_READY',
            message: 'Proposal',
            suggestion: {
              replacementText: 'Chưa kiểm thử.',
              suggestedTitle: null,
              changeSummary: ['Sửa câu.'],
            },
            questions: [],
            uncertainties: [],
          }),
        ),
        provenance: { provider: 'fixture' },
      }),
    ),
  };
  const op = () => ({ operationId: randomUUID() });
  beforeAll(async () => {
    repl = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: { count: 1 },
    });
    connection = await mongoose
      .createConnection(repl.getUri(), { dbName: 'continuum_capture' })
      .asPromise();
  });
  afterAll(async () => {
    await connection?.close();
    await repl?.stop();
  });
  beforeEach(async () => {
    await connection.dropDatabase();
    for (const name of ['work_note_agent_drafts', 'work_note_agent_operations'])
      await connection
        .db!.collection(name)
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await connection
      .db!.collection('work_note_versions')
      .createIndex({ workNoteId: 1, versionNumber: 1 }, { unique: true });
    await connection
      .db!.collection('project_document_editor_versions')
      .createIndex({ documentId: 1, versionNumber: 1 }, { unique: true });
    await connection
      .db!.collection('work_report_versions')
      .createIndex({ reportId: 1, versionNumber: 1 }, { unique: true });
    notes = new WorkNotesService(
      auth as unknown as WorkNotesAuthorizationService,
      connection,
      new OutboxService(connection),
    );
    service = new WorkNoteEditorService(
      new ConfigService({
        WORKNOTE_EDITOR_ENABLED: true,
        WORKNOTE_SHARED_EDITOR_ENABLED: true,
      }),
      auth as unknown as WorkNotesAuthorizationService,
      notes,
      model as unknown as WorkNoteAgentModel,
      {
        consumeRateLimit: () => Promise.resolve(true),
      } as unknown as RedisService,
      connection,
    );
    auth.resolveTask.mockClear();
    model.rewrite.mockClear();
  });
  it('creates a Document draft without a Task and saves it without submitting', async () => {
    const d = await service.createEditor(headers, projectId, {
      ...op(),
      workflow: 'PROJECT_DOCUMENT',
      documentType: 'RESEARCH',
    });
    const edited = await service.update(headers, projectId, d.id, {
      ...op(),
      expectedRevision: d.revision,
      title: 'Retry research',
      contentMarkdown: 'Chưa test.',
    });
    const response = await service.message(headers, projectId, d.id, {
      ...op(),
      expectedRevision: edited.revision,
      operation: 'grammar',
      scope: 'whole_note',
      instruction: 'Sửa câu.',
      includeWholeNoteContext: false,
    });
    expect(model.rewrite.mock.calls[0][0]).toMatchObject({
      workflow: 'PROJECT_DOCUMENT',
      task: null,
    });
    const applied = await service.apply(
      headers,
      projectId,
      d.id,
      response.suggestion!.id,
      {
        ...op(),
        expectedRevision: edited.revision,
        action: 'replace_body',
        applyTitle: false,
      },
    );
    await expect(
      service.saveEditor(headers, projectId, d.id, {
        ...op(),
        expectedRevision: applied.revision,
        discardOriginalConfirmed: false,
      }),
    ).rejects.toMatchObject({ status: 422 });
    const saved = await service.saveEditor(headers, projectId, d.id, {
      ...op(),
      expectedRevision: applied.revision,
      discardOriginalConfirmed: true,
    });
    expect(saved).toMatchObject({ status: 'DRAFT', content: 'Chưa kiểm thử.' });
    expect(auth.resolveTask).not.toHaveBeenCalled();
    expect(
      await connection
        .db!.collection('work_note_agent_drafts')
        .countDocuments(),
    ).toBe(0);
  });
  it('preserves Report obligation metadata and supports freeform Submit without legacy writes', async () => {
    const id = new Types.ObjectId(),
      periodStart = new Date('2026-10-26T00:00:00Z'),
      periodEnd = new Date('2026-11-02T00:00:00Z');
    await connection.db!.collection('work_reports').insertOne({
      _id: id,
      organizationId: new Types.ObjectId(organizationId),
      projectId: new Types.ObjectId(projectId),
      memberUserId: new Types.ObjectId(userId),
      reportScope: 'MEMBER',
      frequency: 'WEEKLY',
      periodStart,
      periodEnd,
      dueAt: periodEnd,
      status: 'OVERDUE',
      accomplishments: 'Đã chỉnh retry.',
      approach: 'Đọc log.',
      reason: 'Chưa rõ nguyên nhân.',
      createdAt: periodStart,
      updatedAt: periodStart,
      reviewHistory: [],
    });
    const d = await service.createEditor(headers, projectId, {
      ...op(),
      workflow: 'WORK_REPORT',
      reportId: String(id),
    });
    const edited = await service.update(headers, projectId, d.id, {
      ...op(),
      expectedRevision: d.revision,
      title: 'Weekly investigation',
      contentMarkdown: 'Đã chỉnh retry; chưa xác định nguyên nhân.',
    });
    const saved = await service.saveEditor(headers, projectId, d.id, {
      ...op(),
      expectedRevision: edited.revision,
      discardOriginalConfirmed: false,
    });
    expect(saved).toMatchObject({
      status: 'OVERDUE',
      reportScope: 'MEMBER',
      contentSchemaVersion: 2,
    });
    const row = await connection
      .db!.collection('work_reports')
      .findOne({ _id: id });
    expect(row?.periodStart).toEqual(periodStart);
    expect(row?.frequency).toBe('WEEKLY');
    await expect(
      notes.updateWorkReportDraft(headers, projectId, String(id), {
        accomplishments: 'lossy',
        approach: 'lossy',
        reason: 'lossy',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await notes.submitWorkReport(headers, projectId, String(id))).status,
    ).toBe('PENDING_REVIEW');
    expect(
      await connection.db!.collection('work_report_versions').countDocuments(),
    ).toBe(2);
  });
  it('retains intervening legacy Document edits and replays the original saved canonical response', async () => {
    const d = await service.createEditor(headers, projectId, {
      ...op(),
      workflow: 'PROJECT_DOCUMENT',
      documentType: 'OTHER',
    });
    const firstDraft = await service.update(headers, projectId, d.id, {
      ...op(),
      expectedRevision: 1,
      title: 'Investigation',
      contentMarkdown: 'First canonical.',
    });
    const input = {
      ...op(),
      expectedRevision: firstDraft.revision,
      discardOriginalConfirmed: false,
    };
    const first = await service.saveEditor(headers, projectId, d.id, input);
    await notes.updateDocumentDraft(headers, projectId, first.id, {
      title: 'Legacy edit',
      type: 'OTHER',
      content: 'Legacy canonical.',
    });
    const next = await service.createEditor(headers, projectId, {
      ...op(),
      workflow: 'PROJECT_DOCUMENT',
      documentId: first.id,
    });
    const edited = await service.update(headers, projectId, next.id, {
      ...op(),
      expectedRevision: next.revision,
      title: 'Latest',
      contentMarkdown: 'Latest canonical.',
    });
    await service.saveEditor(headers, projectId, next.id, {
      ...op(),
      expectedRevision: edited.revision,
      discardOriginalConfirmed: false,
    });
    expect(
      (await service.saveEditor(headers, projectId, d.id, input)) as unknown,
    ).toMatchObject({ title: 'Investigation', content: 'First canonical.' });
    const versions = await service.editorVersions(
      headers,
      projectId,
      'PROJECT_DOCUMENT',
      first.id,
      1,
      20,
    );
    expect(versions.data.map((v) => v.contentMarkdown)).toEqual([
      'Latest canonical.',
      'Legacy canonical.',
      'First canonical.',
    ]);
  });
  it('rejects stale saves and restores, preserving attached files across approved Document edits', async () => {
    const initial = await service.createEditor(headers, projectId, {
      ...op(),
      workflow: 'PROJECT_DOCUMENT',
      documentType: 'OTHER',
    });
    const content = await service.update(headers, projectId, initial.id, {
      ...op(),
      expectedRevision: initial.revision,
      title: 'Initial',
      contentMarkdown: 'First body.',
    });
    const first = await service.saveEditor(headers, projectId, initial.id, {
      ...op(),
      expectedRevision: content.revision,
      discardOriginalConfirmed: false,
    });
    const file = {
      fileName: 'evidence.txt',
      contentType: 'text/plain',
      size: 20,
      storageKey: 'synthetic-owned-file',
    };
    await connection
      .db!.collection('project_documents')
      .updateOne(
        { _id: new Types.ObjectId(first.id) },
        { $set: { status: 'APPROVED' } },
      );
    await connection
      .db!.collection('project_document_versions')
      .updateOne(
        { documentId: new Types.ObjectId(first.id), versionNumber: 1 },
        { $set: { status: 'APPROVED', file } },
      );
    const draft = await service.createEditor(headers, projectId, {
      ...op(),
      workflow: 'PROJECT_DOCUMENT',
      documentId: first.id,
    });
    const edit = await service.update(headers, projectId, draft.id, {
      ...op(),
      expectedRevision: draft.revision,
      title: 'Next',
      contentMarkdown: 'Second body.',
    });
    await service.saveEditor(headers, projectId, draft.id, {
      ...op(),
      expectedRevision: edit.revision,
      discardOriginalConfirmed: false,
    });
    const reviewVersion = await connection
      .db!.collection('project_document_versions')
      .findOne({ documentId: new Types.ObjectId(first.id), versionNumber: 2 });
    expect(reviewVersion).toMatchObject({ status: 'DRAFT', file });
    const pending = await service.createEditor(headers, projectId, {
      ...op(),
      workflow: 'PROJECT_DOCUMENT',
      documentId: first.id,
    });
    await notes.updateDocumentDraft(headers, projectId, first.id, {
      title: 'Outside edit',
      type: 'OTHER',
      content: 'Changed elsewhere.',
    });
    await expect(
      service.saveEditor(headers, projectId, pending.id, {
        ...op(),
        expectedRevision: pending.revision,
        discardOriginalConfirmed: false,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.restoreEditor(headers, projectId, 'PROJECT_DOCUMENT', first.id, {
        ...op(),
        expectedVersion: pending.baseNoteVersion,
        expectedContentHash: pending.baseContentHash!,
        versionNumber: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const fresh = await service.createEditor(headers, projectId, {
      ...op(),
      workflow: 'PROJECT_DOCUMENT',
      documentId: first.id,
    });
    const restored = await service.restoreEditor(
      headers,
      projectId,
      'PROJECT_DOCUMENT',
      first.id,
      {
        ...op(),
        expectedVersion: fresh.baseNoteVersion,
        expectedContentHash: fresh.baseContentHash!,
        versionNumber: 1,
      },
    );
    expect(restored).toMatchObject({
      title: 'Initial',
      content: 'First body.',
      status: 'DRAFT',
    });
    expect(
      await connection
        .db!.collection('project_document_editor_versions')
        .countDocuments(),
    ).toBe(4);
  });
  it('denies other authors Reports and does not rewrite canonical text when updating document links', async () => {
    const id = new Types.ObjectId(),
      now = new Date();
    await connection.db!.collection('work_reports').insertOne({
      _id: id,
      organizationId: new Types.ObjectId(organizationId),
      projectId: new Types.ObjectId(projectId),
      memberUserId: new Types.ObjectId(),
      status: 'DRAFT',
      frequency: 'WEEKLY',
      periodStart: now,
      periodEnd: now,
      dueAt: now,
      createdAt: now,
      updatedAt: now,
      title: 'Original',
      contentMarkdown: 'Canonical.',
      contentSchemaVersion: 2,
      currentVersionNumber: 3,
    });
    await expect(
      service.createEditor(headers, projectId, {
        ...op(),
        workflow: 'WORK_REPORT',
        reportId: String(id),
      }),
    ).rejects.toMatchObject({ status: 404 });
    await connection
      .db!.collection('work_reports')
      .updateOne(
        { _id: id },
        { $set: { memberUserId: new Types.ObjectId(userId) } },
      );
    await service.updateReportLinks(headers, projectId, String(id), []);
    expect(
      await connection.db!.collection('work_reports').findOne({ _id: id }),
    ).toMatchObject({
      title: 'Original',
      contentMarkdown: 'Canonical.',
      currentVersionNumber: 3,
      status: 'DRAFT',
      documentIds: [],
    });
    await expect(
      service.updateReportLinks(headers, projectId, String(id), [
        new Types.ObjectId().toHexString(),
      ]),
    ).rejects.toMatchObject({ status: 404 });
    await connection
      .db!.collection('work_reports')
      .updateOne({ _id: id }, { $set: { status: 'PENDING_REVIEW' } });
    await expect(
      service.updateReportLinks(headers, projectId, String(id), []),
    ).rejects.toMatchObject({ status: 403 });
  });
});
