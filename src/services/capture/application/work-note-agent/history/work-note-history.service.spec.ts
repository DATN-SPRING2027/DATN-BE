import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import { WorkNoteAgentDraftsService } from '../work-note-agent-drafts.service';
import { WorkNoteAgentModel } from '../../../infrastructure/ai/work-note-agent.model';
import {
  parseAgentResult,
  prepareAgentRequest,
  type AgentInput,
} from '../work-note-agent';
import type { WorkNotesAuthorizationService } from '../../work-notes-authorization.service';
import type { WorkNotesService } from '../../work-notes.service';
import type { RedisService } from '../../../infrastructure/redis/redis.service';
import type { RelatedTaskRef, WorkNotesActor } from '../../work-notes.types';
import { CONFIRM_APPLIES, CONFIRM_STILL_TRUE } from './clarification-dedup';
import { LEDGER_COLLECTION } from './work-note-history.retriever';
import { FAKE } from '../security/fixtures/sensitive-corpus';

describe('Historical Work Note retrieval in the Agent workflow', () => {
  jest.setTimeout(120000);
  let repl: MongoMemoryReplSet;
  let connection: Connection;
  let service: WorkNoteAgentDraftsService;
  let actor: WorkNotesActor;
  let relatedTasks: RelatedTaskRef[];
  let rewrite: jest.Mock<Promise<unknown>, [AgentInput]>;
  let reply: unknown;
  const projectId = new Types.ObjectId().toHexString();
  const taskId = new Types.ObjectId().toHexString();
  const otherTaskId = new Types.ObjectId().toHexString();
  const organizationId = new Types.ObjectId().toHexString();
  const headers = { authorization: 'Bearer synthetic-test-session' };
  const op = () => ({ operationId: randomUUID() });
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  const insertNote = (fields: Record<string, unknown>) =>
    connection.db!.collection('work_notes').insertOne({
      organizationId: new Types.ObjectId(organizationId),
      projectId: new Types.ObjectId(projectId),
      taskId: new Types.ObjectId(taskId),
      type: 'TASK_NOTE',
      status: 'CONFIRMED',
      authorUserId: new Types.ObjectId(),
      authorName: 'Synthetic',
      contentSchemaVersion: 2,
      currentVersionNumber: 1,
      ...fields,
    });

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
    await connection
      .db!.collection('work_note_versions')
      .createIndex({ workNoteId: 1, versionNumber: 1 }, { unique: true });
    for (const name of ['work_note_agent_drafts', 'work_note_agent_operations'])
      await connection
        .db!.collection(name)
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    actor = {
      userId: new Types.ObjectId().toHexString(),
      userName: 'Synthetic author',
      projectId,
      organizationId,
      canReview: false,
      canConfigure: false,
      taskTitle: 'Kiểm thử module cốt lõi',
      taskContext: {
        title: 'Kiểm thử module cốt lõi',
        description: null,
        status: 'IN_PROGRESS',
        steps: [],
      },
    };
    relatedTasks = [];
    reply = {
      status: 'CLARIFICATION_REQUIRED',
      message: 'Cần thêm thông tin kiểm thử.',
      suggestion: null,
      questions: [
        {
          text: 'Bạn đã test module cốt lõi ở trạng thái nào?',
          reason: 'Cần xác nhận kết quả.',
          options: ['Đã test', 'Chưa test'],
        },
      ],
      uncertainties: [],
    };
    rewrite = jest.fn((input: AgentInput) =>
      Promise.resolve({
        result: parseAgentResult(
          prepareAgentRequest(input),
          JSON.stringify(reply),
        ),
        provenance: {
          provider: 'xkiro',
          model: 'synthetic/model',
          promptVersion: 'x',
          formattingRecovery: [],
        },
      }),
    );
    const config = new ConfigService({
      WORKNOTE_EDITOR_ENABLED: true,
      WORKNOTE_SECURITY_PLACEHOLDER_KEY: 'history-spec-key',
    });
    // Real gateway (masking) + mocked provider call.
    const model = Object.assign(new WorkNoteAgentModel(config), { rewrite });
    const auth = {
      resolveProject: jest.fn(() => Promise.resolve(actor)),
      resolveTask: jest.fn(() => Promise.resolve(actor)),
      resolveRelatedTasks: jest.fn(() => Promise.resolve(relatedTasks)),
    };
    service = new WorkNoteAgentDraftsService(
      config,
      auth as unknown as WorkNotesAuthorizationService,
      {
        getTaskNote: jest.fn(() =>
          Promise.resolve({ permissions: { canEdit: true } }),
        ),
      } as unknown as WorkNotesService,
      model,
      {
        consumeRateLimit: jest.fn(() => Promise.resolve(true)),
      } as unknown as RedisService,
      connection,
    );
  });

  async function draft(body: string) {
    const d = await service.create(headers, projectId, { ...op(), taskId });
    return service.update(headers, projectId, d.id, {
      ...op(),
      expectedRevision: d.revision,
      title: 'Tiến độ hôm nay',
      contentMarkdown: body,
    });
  }
  const message = (revision: number) => ({
    ...op(),
    expectedRevision: revision,
    operation: 'clarify' as const,
    scope: 'whole_note' as const,
    instruction: 'Làm rõ kết quả kiểm thử.',
    includeWholeNoteContext: false,
  });

  it('retrieves only same-Task CONFIRMED notes, masks them, and turns a repeated question into a quoted confirmation', async () => {
    await insertNote({
      title: 'Tiến độ tuần 43',
      contentMarkdown: `Đã test module cốt lõi trên staging.\nDB_PASSWORD=${FAKE.dbPassword}`,
      createdAt: daysAgo(2),
      updatedAt: daysAgo(2),
    });
    await insertNote({
      taskId: new Types.ObjectId(otherTaskId),
      title: 'Task khác',
      contentMarkdown: 'Đã deploy production dịch vụ khác.',
      createdAt: daysAgo(1),
    });
    await insertNote({
      status: 'DELETED',
      title: 'Đã xoá',
      contentMarkdown: 'Đã test module thanh toán.',
      createdAt: daysAgo(1),
    });
    await insertNote({
      title: 'Có private key',
      contentMarkdown: `Đã test module cốt lõi.\n${FAKE.privateKey}`,
      createdAt: daysAgo(1),
    });

    const d = await draft('Đang viết ghi chú kiểm thử.');
    const response = (await service.message(
      headers,
      projectId,
      d.id,
      message(d.revision),
    )) as unknown as {
      questions: { text: string; options: string[] }[];
      history?: {
        notes: { title: string }[];
        facts: { quote: string; status: string }[];
      };
    };

    const sent = rewrite.mock.calls[0][0].historicalContext!;
    expect(sent.notes.map((n) => n.title)).toEqual(['Tiến độ tuần 43']);
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain(FAKE.dbPassword);
    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain('dịch vụ khác');
    expect(serialized).not.toContain('thanh toán');

    expect(response.questions[0].text).toContain(
      '"Đã test module cốt lõi trên staging."',
    );
    expect(response.questions[0].options).toContain(CONFIRM_STILL_TRUE);
    expect(response.history?.facts.some((f) => f.status === 'CURRENT')).toBe(
      true,
    );
    const pending = (await service.get(headers, projectId, d.id))
      .pendingQuestion as {
      historyRef?: { noteTitle: string };
    };
    expect(pending.historyRef?.noteTitle).toBe('Tiến độ tuần 43');
  });

  it('never uses the note being edited as its own history and exposes verification findings', async () => {
    const own = await insertNote({
      title: 'Chính note này',
      contentMarkdown: 'Đã test module cốt lõi.',
      createdAt: daysAgo(3),
    });
    await insertNote({
      title: 'Note cũ',
      contentMarkdown: 'Hoàn thành tính năng export báo cáo.',
      createdAt: daysAgo(3),
    });
    const created = await service.create(headers, projectId, {
      ...op(),
      taskId,
      noteId: undefined,
    });
    const view = await service.history(headers, projectId, created.id);
    expect(view?.notes.map((n) => n.title).sort()).toEqual(
      ['Chính note này', 'Note cũ'].sort(),
    );

    // Editing `own`: it must be excluded.
    const draftRow = await connection
      .db!.collection('work_note_agent_drafts')
      .findOne({ _id: created.id as never });
    await connection
      .db!.collection('work_note_agent_drafts')
      .updateOne({ _id: draftRow!._id }, { $set: { noteId: own.insertedId } });
    const editing = await service.history(headers, projectId, created.id);
    expect(editing?.notes.map((n) => n.title)).toEqual(['Note cũ']);
    // Task is IN_PROGRESS but the old note claims completion.
    expect(editing?.findings).toEqual([
      expect.objectContaining({
        status: 'CONFLICT_TASK',
        reason: 'TASK_STATUS_DIFFERS',
      }),
    ]);
  });

  it('records answered clarifications in a Task-level ledger on Save (masked)', async () => {
    reply = {
      status: 'CLARIFICATION_REQUIRED',
      message: 'Cần môi trường.',
      suggestion: null,
      questions: [
        { text: 'Bạn đã kiểm thử ở môi trường nào?', reason: 'x', options: [] },
      ],
      uncertainties: [],
    };
    const d = await draft('Đã sửa API export.');
    await service.message(headers, projectId, d.id, message(d.revision));
    const pending = (await service.get(headers, projectId, d.id))
      .pendingQuestion!;
    reply = {
      status: 'ANSWER',
      message: 'Đã ghi nhận.',
      suggestion: null,
      questions: [],
      uncertainties: [],
    };
    await service.message(headers, projectId, d.id, {
      ...message(d.revision),
      replyToQuestionId: pending.id,
      questionDisposition: 'answered',
      answer: `Staging, tài khoản test mk: ${FAKE.dbPassword}`,
    });
    const current = await service.get(headers, projectId, d.id);
    await service.save(headers, projectId, d.id, {
      ...op(),
      expectedRevision: current.revision,
      discardOriginalConfirmed: false,
    });
    const ledger = await connection
      .db!.collection(LEDGER_COLLECTION)
      .find()
      .toArray();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      question: 'Bạn đã kiểm thử ở môi trường nào?',
      disposition: 'answered',
    });
    expect(String(ledger[0].answer)).not.toContain(FAKE.dbPassword);
    expect(String(ledger[0].answer)).toContain('[[WN_SEC:PASSWORD:');

    // A new draft sees the answer as history (no need to ask again).
    const next = await draft('Viết tiếp.');
    const view = await service.history(headers, projectId, next.id);
    expect(view?.notes.some((n) => n.source === 'CLARIFICATION_LEDGER')).toBe(
      true,
    );
  });

  it('is disabled by WORKNOTE_HISTORY_ENABLED=false', async () => {
    await insertNote({
      title: 'Tiến độ',
      contentMarkdown: 'Đã test module cốt lõi trên staging.',
      createdAt: daysAgo(1),
    });
    const svc = service as unknown as { config: ConfigService };
    svc.config = new ConfigService({
      WORKNOTE_EDITOR_ENABLED: true,
      WORKNOTE_HISTORY_ENABLED: 'false',
    });
    const d = await draft('Đang viết.');
    await service.message(headers, projectId, d.id, message(d.revision));
    expect(rewrite.mock.calls[0][0].historicalContext).toBeUndefined();
  });

  it('retrieves masked CONFIRMED notes from readable parent/child Tasks with relation & taskKey, and honors WORKNOTE_HISTORY_RELATED_ENABLED', async () => {
    const parentTaskId = new Types.ObjectId().toHexString();
    const childTaskId = new Types.ObjectId().toHexString();
    relatedTasks = [
      {
        id: parentTaskId,
        key: 'OPS-10',
        title: 'Kiến trúc tổng thể',
        relation: 'PARENT',
      },
      {
        id: childTaskId,
        key: 'OPS-12',
        title: 'Viết test module cốt lõi',
        relation: 'CHILD',
      },
    ];
    await insertNote({
      taskId: new Types.ObjectId(parentTaskId),
      title: 'Quyết định kiến trúc cha',
      contentMarkdown: `Chốt dùng Redis Cluster cho module cốt lõi trên staging.\nDB_PASSWORD=${FAKE.dbPassword}`,
      createdAt: daysAgo(2),
    });
    await insertNote({
      taskId: new Types.ObjectId(childTaskId),
      title: 'Ghi chú subtask con',
      contentMarkdown: 'Đã chạy bộ test module cốt lõi trên staging.',
      createdAt: daysAgo(1),
    });
    await insertNote({
      taskId: new Types.ObjectId(otherTaskId),
      title: 'Task không liên quan',
      contentMarkdown: 'Đã deploy module kế toán.',
      createdAt: daysAgo(1),
    });

    const d = await draft('Đang viết ghi chú kiểm thử module cốt lõi.');
    const response = (await service.message(
      headers,
      projectId,
      d.id,
      message(d.revision),
    )) as unknown as {
      questions: { text: string; options: string[] }[];
      history?: {
        notes: { title: string; relation: string; taskKey?: string }[];
        facts: { quote: string; relation: string; taskKey?: string }[];
      };
    };

    const sent = rewrite.mock.calls[0][0].historicalContext!;
    expect(sent.notes.map((n) => `${n.relation}:${n.taskKey ?? ''}`)).toEqual(
      expect.arrayContaining(['PARENT:OPS-10', 'CHILD:OPS-12']),
    );
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain(FAKE.dbPassword);
    expect(serialized).not.toContain('kế toán');

    // Child/parent match uses CONFIRM_APPLIES and names the related Task.
    expect(response.questions[0].options).toContain(CONFIRM_APPLIES);
    expect(response.questions[0].text).toMatch(/Task (cha OPS-10|con OPS-12)/);

    // Disabling WORKNOTE_HISTORY_RELATED_ENABLED drops parent/child notes.
    const svc = service as unknown as { config: ConfigService };
    svc.config = new ConfigService({
      WORKNOTE_EDITOR_ENABLED: true,
      WORKNOTE_SECURITY_PLACEHOLDER_KEY: 'history-spec-key',
      WORKNOTE_HISTORY_RELATED_ENABLED: 'false',
    });
    const viewDisabled = await service.history(headers, projectId, d.id);
    expect(viewDisabled).toBeNull();
  });

  it('expands CONFIRM_STILL_TRUE in chat message(), masks persisted state.clarifications, and drops ARCHIVED notes from task_clarification_ledger', async () => {
    await insertNote({
      title: 'Tiến độ ban đầu',
      contentMarkdown: 'Đã test module cốt lõi trên staging.',
      createdAt: daysAgo(2),
    });

    const d = await draft('Đang cập nhật tiến độ.');
    const firstTurn = (await service.message(
      headers,
      projectId,
      d.id,
      message(d.revision),
    )) as unknown as {
      questions: { id: string; text: string; options: string[] }[];
    };
    expect(firstTurn.questions[0].options).toContain(CONFIRM_STILL_TRUE);

    reply = {
      status: 'SUGGESTION_READY',
      message: 'Đã biên tập với xác nhận.',
      suggestion: {
        replacementText: 'Đã test module cốt lõi trên staging.',
        suggestedTitle: null,
        changeSummary: ['Cập nhật từ xác nhận'],
      },
      questions: [],
      uncertainties: [],
    };
    const refreshed = await service.get(headers, projectId, d.id);
    await service.message(headers, projectId, d.id, {
      ...op(),
      expectedRevision: refreshed.revision,
      operation: 'clarify',
      scope: 'whole_note',
      instruction: 'Viết rõ tiến độ',
      includeWholeNoteContext: false,
      replyToQuestionId: firstTurn.questions[0].id,
      questionDisposition: 'answered',
      answer: CONFIRM_STILL_TRUE,
    });
    const secondInput = rewrite.mock.calls[1][0];
    expect(secondInput.clarifications.at(-1)?.answer).toContain(
      '"Đã test module cốt lõi trên staging."',
    );

    // Also verify secret masking on persisted state.clarifications & ledger filtering on ARCHIVED notes.
    reply = {
      status: 'CLARIFICATION_REQUIRED',
      message: 'Cần thông tin cấu hình.',
      suggestion: null,
      questions: [
        {
          text: 'Mật khẩu kết nối DB staging là gì?',
          reason: 'Cần bổ sung cấu hình.',
          options: [],
        },
      ],
      uncertainties: [],
    };
    const d2 = await draft('Ghi chú kết nối DB.');
    const askSecret = (await service.message(
      headers,
      projectId,
      d2.id,
      message(d2.revision),
    )) as unknown as { questions: { id: string }[] };
    reply = {
      status: 'SUGGESTION_READY',
      message: 'Đã cập nhật.',
      suggestion: {
        replacementText: 'Ghi chú kết nối DB đã cập nhật.',
        suggestedTitle: null,
        changeSummary: ['Cập nhật'],
      },
      questions: [],
      uncertainties: [],
    };
    const d2AfterAsk = await service.get(headers, projectId, d2.id);
    await service.message(headers, projectId, d2.id, {
      ...op(),
      expectedRevision: d2AfterAsk.revision,
      operation: 'clarify',
      scope: 'whole_note',
      instruction: 'Cập nhật',
      includeWholeNoteContext: false,
      replyToQuestionId: askSecret.questions[0].id,
      questionDisposition: 'answered',
      answer: `DB_PASSWORD=${FAKE.dbPassword}`,
    });
    const storedDraft = (await connection
      .db!.collection('work_note_agent_drafts')
      .findOne({ _id: d2.id as never })) as {
      state?: { clarifications?: unknown };
    } | null;
    expect(JSON.stringify(storedDraft?.state?.clarifications)).not.toContain(
      FAKE.dbPassword,
    );
    expect(JSON.stringify(storedDraft?.state?.clarifications)).toContain(
      '[[WN_SEC:PASSWORD:',
    );

    const d2Ready = await service.get(headers, projectId, d2.id);
    const savedNote = await service.save(headers, projectId, d2.id, {
      ...op(),
      expectedRevision: d2Ready.revision,
      discardOriginalConfirmed: false,
    });
    const ledgerCountBefore = await connection
      .db!.collection(LEDGER_COLLECTION)
      .countDocuments({});
    expect(ledgerCountBefore).toBeGreaterThan(0);

    // Soft-deleting (ARCHIVED) the saved note must prevent its ledger rows from surfacing in history!
    await connection
      .db!.collection('work_notes')
      .updateOne(
        { _id: new Types.ObjectId(savedNote.id) },
        { $set: { status: 'ARCHIVED' } },
      );
    await connection
      .db!.collection('work_notes')
      .deleteMany({ title: 'Tiến độ ban đầu' });

    const d3 = await draft('Kiểm tra sau khi xoá note.');
    const viewAfterArchive = await service.history(headers, projectId, d3.id);
    expect(viewAfterArchive).toBeNull();
  });
});
