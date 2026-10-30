import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import {
  WorkNoteAgentDraftsService,
  type DraftRow,
} from './work-note-agent-drafts.service';
import { WorkNoteAgentModel } from '../../infrastructure/ai/work-note-agent.model';
import {
  parseAgentResult,
  prepareAgentRequest,
  type AgentInput,
} from './work-note-agent';
import type { WorkNotesAuthorizationService } from '../work-notes-authorization.service';
import type { WorkNotesService } from '../work-notes.service';
import type { RedisService } from '../../infrastructure/redis/redis.service';
import type { WorkNotesActor } from '../work-notes.types';

describe('Task Note Agent persisted local workflow', () => {
  jest.setTimeout(120000);
  let repl: MongoMemoryReplSet;
  let connection: Connection;
  let service: WorkNoteAgentDraftsService;
  const projectId = new Types.ObjectId().toHexString(),
    taskId = new Types.ObjectId().toHexString(),
    organizationId = new Types.ObjectId().toHexString();
  let actor: WorkNotesActor;
  type ModelOutput = {
    result: ReturnType<typeof parseAgentResult>;
    provenance: Record<string, unknown>;
  };
  let model: { rewrite: jest.Mock<Promise<ModelOutput>, [AgentInput]> };
  let redis: { consumeRateLimit: jest.Mock<Promise<boolean>, []> };
  const headers = { authorization: 'Bearer synthetic-test-session' };
  const operation = () => ({ operationId: randomUUID() });
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
      taskTitle: 'Validate export',
      taskContext: {
        title: 'Validate export',
        description: 'Verify rollback before release.',
        status: 'DONE',
        steps: [],
      },
    };
    model = {
      rewrite: jest.fn((input: AgentInput) =>
        Promise.resolve({
          result: parseAgentResult(
            prepareAgentRequest(input),
            JSON.stringify({
              status: 'SUGGESTION_READY',
              message: 'Proposal.',
              suggestion: {
                replacementText: 'Chưa kiểm thử.',
                suggestedTitle: null,
                changeSummary: ['Sửa câu.'],
              },
              questions: [],
              uncertainties: [],
            }),
          ),
          provenance: {
            provider: 'xkiro',
            model: 'synthetic/model',
            promptVersion: 'synthetic',
            formattingRecovery: [],
          },
        }),
      ),
    };
    redis = { consumeRateLimit: jest.fn(() => Promise.resolve(true)) };
    const auth = {
      resolveProject: jest.fn(() => Promise.resolve(actor)),
      resolveTask: jest.fn(() => Promise.resolve(actor)),
    };
    const notes = {
      getTaskNote: jest.fn(
        async (
          _headers: unknown,
          _project: string,
          _task: string,
          id: string,
        ) => {
          const row = await connection
            .db!.collection('work_notes')
            .findOne({ _id: new Types.ObjectId(id) });
          if (!row) throw Error('not found');
          return {
            ...row,
            id,
            permissions: {
              canEdit:
                String(row.authorUserId) === actor.userId || actor.canReview,
            },
          };
        },
      ),
    };
    service = new WorkNoteAgentDraftsService(
      new ConfigService({ WORKNOTE_EDITOR_ENABLED: true }),
      auth as unknown as WorkNotesAuthorizationService,
      notes as unknown as WorkNotesService,
      model as unknown as WorkNoteAgentModel,
      redis as unknown as RedisService,
      connection,
    );
  });
  async function draft(body = 'Chưa test.') {
    const d = await service.create(headers, projectId, {
      ...operation(),
      taskId,
    });
    return service.update(headers, projectId, d.id, {
      ...operation(),
      expectedRevision: d.revision,
      title: 'Synthetic note',
      contentMarkdown: body,
    });
  }
  it('fails closed if the required migration/expiry indexes are absent', async () => {
    await connection
      .db!.collection('work_note_agent_drafts')
      .dropIndex('expiresAt_1');
    await expect(
      service.create(headers, projectId, { ...operation(), taskId }),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('does not resurrect a closed draft when the original create operation is replayed after Save', async () => {
    const createInput = { ...operation(), taskId };
    const d = await service.create(headers, projectId, createInput);
    const edited = await service.update(headers, projectId, d.id, {
      ...operation(),
      expectedRevision: 1,
      title: 'Canonical',
      contentMarkdown: 'Unchanged original.',
    });
    await service.save(headers, projectId, d.id, {
      ...operation(),
      expectedRevision: edited.revision,
      discardOriginalConfirmed: false,
    });
    await expect(
      service.create(headers, projectId, createInput),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await connection
        .db!.collection('work_note_agent_drafts')
        .countDocuments(),
    ).toBe(0);
  });
  it('rejects reuse of an operation ID in a different Project with a conflict instead of a duplicate-key failure', async () => {
    const input = { ...operation(), taskId };
    await service.create(headers, projectId, input);
    const otherProject = new Types.ObjectId().toHexString();
    actor = { ...actor, projectId: otherProject };
    await expect(
      service.create(headers, otherProject, {
        ...input,
        taskId: new Types.ObjectId().toHexString(),
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('preserves an existing author and rejects concurrent legacy edits even when legacy timestamps are absent', async () => {
    const noteId = new Types.ObjectId();
    const author = new Types.ObjectId();
    actor = { ...actor, canReview: true };
    await connection.db!.collection('work_notes').insertOne({
      _id: noteId,
      organizationId: new Types.ObjectId(organizationId),
      projectId: new Types.ObjectId(projectId),
      taskId: new Types.ObjectId(taskId),
      authorUserId: author,
      type: 'TASK_NOTE',
      status: 'CONFIRMED',
      title: 'Legacy',
      whatDone: 'A',
      howSolved: 'B',
      whyThisWay: 'C',
    });
    const d = await service.create(headers, projectId, {
      ...operation(),
      taskId,
      noteId: String(noteId),
    });
    const saved = await service.save(headers, projectId, d.id, {
      ...operation(),
      expectedRevision: d.revision,
      discardOriginalConfirmed: false,
    });
    expect(saved.authorId).toBe(String(author));
    expect(saved.authorName).toBe(String(author));
    const otherId = new Types.ObjectId();
    await connection.db!.collection('work_notes').insertOne({
      _id: otherId,
      organizationId: new Types.ObjectId(organizationId),
      projectId: new Types.ObjectId(projectId),
      taskId: new Types.ObjectId(taskId),
      authorUserId: new Types.ObjectId(actor.userId),
      type: 'TASK_NOTE',
      status: 'CONFIRMED',
      title: 'Legacy second',
      whatDone: 'A',
      howSolved: 'B',
      whyThisWay: 'C',
    });
    const next = await service.create(headers, projectId, {
      ...operation(),
      taskId,
      noteId: String(otherId),
    });
    await connection
      .db!.collection('work_notes')
      .updateOne(
        { _id: otherId },
        { $set: { whatDone: 'Changed by an old client' } },
      );
    await expect(
      service.save(headers, projectId, next.id, {
        ...operation(),
        expectedRevision: next.revision,
        discardOriginalConfirmed: false,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('continues a server-owned clarification and retains the answered ledger without leaking chat into canonical content', async () => {
    const d = await draft('Lỗi export chưa rõ nguyên nhân.');
    model.rewrite.mockImplementationOnce((input) =>
      Promise.resolve({
        result: parseAgentResult(
          prepareAgentRequest(input),
          JSON.stringify({
            status: 'CLARIFICATION_REQUIRED',
            message: 'Cần thêm thông tin.',
            suggestion: null,
            questions: [
              {
                text: 'Lỗi xuất hiện ở môi trường nào?',
                reason: 'Cần phân biệt phạm vi.',
                options: [],
              },
            ],
            uncertainties: [],
          }),
        ),
        provenance: {},
      }),
    );
    await service.message(headers, projectId, d.id, message(d.revision));
    const pending = (await service.get(headers, projectId, d.id))
      .pendingQuestion!;
    await service.message(headers, projectId, d.id, {
      ...message(d.revision),
      replyToQuestionId: pending.id,
      questionDisposition: 'answered',
      answer: 'Chỉ ở staging.',
    });
    expect(model.rewrite.mock.calls[1][0].clarifications).toEqual([
      {
        id: pending.id,
        question: pending.text,
        state: 'answered',
        answer: 'Chỉ ở staging.',
      },
    ]);
    expect(
      (await service.get(headers, projectId, d.id)).pendingQuestion,
    ).toBeNull();
  });
  it('inserts after exactly the second selected occurrence and makes operation replay nonduplicating', async () => {
    const d = await draft('same / same');
    const start = 7;
    model.rewrite.mockImplementationOnce((input) =>
      Promise.resolve({
        result: parseAgentResult(
          prepareAgentRequest(input),
          JSON.stringify({
            status: 'SUGGESTION_READY',
            message: 'Proposal.',
            suggestion: {
              replacementText: ' NEW',
              suggestedTitle: null,
              changeSummary: ['Adjusted.'],
            },
            questions: [],
            uncertainties: [],
          }),
        ),
        provenance: {},
      }),
    );
    const response = await service.message(headers, projectId, d.id, {
      ...message(d.revision),
      scope: 'selection',
      selection: { start, end: 11, quote: 'same' },
    });
    const input = {
      ...operation(),
      expectedRevision: d.revision,
      action: 'insert_after' as const,
      applyTitle: false,
    };
    const applied = await service.apply(
      headers,
      projectId,
      d.id,
      response.suggestion!.id,
      input,
    );
    expect(applied.contentMarkdown).toBe('same / same NEW');
    expect(
      (
        await service.apply(
          headers,
          projectId,
          d.id,
          response.suggestion!.id,
          input,
        )
      ).contentMarkdown,
    ).toBe(applied.contentMarkdown);
  });
  const message = (revision: number) => ({
    ...operation(),
    expectedRevision: revision,
    operation: 'grammar' as const,
    scope: 'whole_note' as const,
    instruction: 'Sửa ngữ pháp.',
    includeWholeNoteContext: false,
  });
  it('autosaves, resumes, saves without AI and returns the same canonical version on Save replay', async () => {
    const d = await draft();
    expect((await service.resume(headers, projectId, taskId))?.id).toBe(d.id);
    const request = {
      ...operation(),
      expectedRevision: d.revision,
      discardOriginalConfirmed: false,
    };
    const saved = await service.save(headers, projectId, d.id, request);
    const replay = await service.save(headers, projectId, d.id, request);
    expect(replay.id).toBe(saved.id);
    expect(replay.currentVersionNumber).toBe(1);
    expect(model.rewrite).not.toHaveBeenCalled();
    expect(
      await connection
        .db!.collection('work_note_agent_drafts')
        .countDocuments(),
    ).toBe(0);
    const receipts = await connection
      .db!.collection('work_note_agent_operations')
      .find()
      .toArray();
    expect(JSON.stringify(receipts)).not.toContain('Chưa test.');
    expect(receipts).toHaveLength(3);
  });
  it('requires original deletion confirmation after Apply and preserves recovery on cancelled Save', async () => {
    const d = await draft();
    const response = await service.message(
      headers,
      projectId,
      d.id,
      message(d.revision),
    );
    const applied = await service.apply(
      headers,
      projectId,
      d.id,
      response.suggestion!.id,
      {
        ...operation(),
        expectedRevision: d.revision,
        action: 'replace_body',
        applyTitle: false,
      },
    );
    await expect(
      service.save(headers, projectId, d.id, {
        ...operation(),
        expectedRevision: applied.revision,
        discardOriginalConfirmed: false,
      }),
    ).rejects.toMatchObject({
      response: { code: 'ORIGINAL_DELETION_CONFIRMATION_REQUIRED' },
    });
    expect((await service.get(headers, projectId, d.id)).contentMarkdown).toBe(
      'Chưa kiểm thử.',
    );
    expect(
      (
        await service.save(headers, projectId, d.id, {
          ...operation(),
          expectedRevision: applied.revision,
          discardOriginalConfirmed: true,
        })
      ).contentMarkdown,
    ).toBe('Chưa kiểm thử.');
  });
  it('rejects stale snapshots and cross-owner access before calling a provider', async () => {
    const d = await draft();
    await expect(
      service.message(headers, projectId, d.id, {
        ...message(d.revision),
        scope: 'selection',
        selection: { start: 0, end: 4, quote: 'fake' },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await service.update(headers, projectId, d.id, {
      ...operation(),
      expectedRevision: d.revision,
      title: d.title,
      contentMarkdown: 'Edited.',
    });
    await expect(
      service.message(headers, projectId, d.id, message(d.revision)),
    ).rejects.toMatchObject({ status: 409 });
    actor = { ...actor, userId: new Types.ObjectId().toHexString() };
    await expect(service.get(headers, projectId, d.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(model.rewrite).not.toHaveBeenCalled();
  });
  it('enforces expiry on reads and writes independently of TTL cleanup', async () => {
    const d = await draft();
    await connection
      .db!.collection('work_note_agent_drafts')
      .updateOne({ _id: d.id } as never, { $set: { expiresAt: new Date(0) } });
    await expect(service.get(headers, projectId, d.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.save(headers, projectId, d.id, {
        ...operation(),
        expectedRevision: d.revision,
        discardOriginalConfirmed: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('does not refresh inactivity expiry for a no-op autosave and aligns transient receipt expiry', async () => {
    const d = await draft();
    const expires = new Date(Date.now() + 3600000);
    await connection
      .db!.collection<{ _id: string }>('work_note_agent_drafts')
      .updateOne({ _id: d.id }, { $set: { expiresAt: expires } });
    await connection
      .db!.collection('work_note_agent_operations')
      .updateMany({}, { $set: { expiresAt: expires } });
    const updated = await service.update(headers, projectId, d.id, {
      ...operation(),
      expectedRevision: d.revision,
      title: d.title,
      contentMarkdown: d.contentMarkdown,
    });
    expect(updated.revision).toBe(d.revision);
    expect(updated.expiresAt).toBe(expires.toISOString());
    expect(
      (
        await connection
          .db!.collection('work_note_agent_operations')
          .find()
          .toArray()
      ).every((r) => (r.expiresAt as Date).getTime() === expires.getTime()),
    ).toBe(true);
  });
  it('does not apply an inference after the draft changes while awaiting a model', async () => {
    const d = await draft();
    let release!: (value: ModelOutput) => void;
    const normal = model.rewrite.getMockImplementation()!;
    let started!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    model.rewrite.mockImplementationOnce(() => {
      started();
      return new Promise((r) => {
        release = r;
      });
    });
    const pending = service.message(
      headers,
      projectId,
      d.id,
      message(d.revision),
    );
    await ready;
    await service.update(headers, projectId, d.id, {
      ...operation(),
      expectedRevision: d.revision,
      title: d.title,
      contentMarkdown: 'Changed while waiting.',
    });
    release(
      await normal({
        operation: 'grammar',
        scope: 'whole_note',
        instruction: 'Sửa.',
        workflow: 'TASK_NOTE',
        draft: {
          revision: d.revision,
          title: d.title,
          body: d.contentMarkdown,
        },
        task: null,
        clarifications: [],
        history: [],
      }),
    );
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect((await service.get(headers, projectId, d.id)).suggestion).toBeNull();
  });
  it('keeps ordinary Save usable after model failure or quota exhaustion', async () => {
    const d = await draft();
    redis.consumeRateLimit.mockResolvedValueOnce(false);
    await expect(
      service.message(headers, projectId, d.id, message(d.revision)),
    ).rejects.toMatchObject({ status: 429 });
    expect(model.rewrite).not.toHaveBeenCalled();
    redis.consumeRateLimit.mockRejectedValueOnce(
      Error('quota store unavailable'),
    );
    await expect(
      service.message(headers, projectId, d.id, message(d.revision)),
    ).rejects.toMatchObject({ status: 503 });
    model.rewrite.mockRejectedValueOnce(Error('synthetic provider failure'));
    await expect(
      service.message(headers, projectId, d.id, message(d.revision)),
    ).rejects.toMatchObject({ status: 502 });
    expect(
      (
        await service.save(headers, projectId, d.id, {
          ...operation(),
          expectedRevision: d.revision,
          discardOriginalConfirmed: false,
        })
      ).status,
    ).toBe('CONFIRMED');
  });
  it('bounds a quota store that never settles and still allows ordinary Save', async () => {
    const d = await draft();
    redis.consumeRateLimit.mockImplementationOnce(
      () => new Promise<boolean>(() => undefined),
    );
    let timer: ReturnType<typeof setTimeout>;
    const outcome = await Promise.race([
      service.message(headers, projectId, d.id, message(d.revision)).then(
        () => ({ status: 200 }),
        (error) => error as { status: number },
      ),
      new Promise<{ status: number }>((resolve) => {
        timer = setTimeout(() => resolve({ status: 0 }), 2500);
      }),
    ]);
    clearTimeout(timer!);
    expect(outcome.status).toBe(503);
    expect(model.rewrite).not.toHaveBeenCalled();
    expect(
      (
        await service.save(headers, projectId, d.id, {
          ...operation(),
          expectedRevision: d.revision,
          discardOriginalConfirmed: false,
        })
      ).status,
    ).toBe('CONFIRMED');
  });
  it('versions edits and restores history as a new version without rewriting an old version', async () => {
    const initial = await draft();
    const saved = await service.save(headers, projectId, initial.id, {
      ...operation(),
      expectedRevision: initial.revision,
      discardOriginalConfirmed: false,
    });
    const edit = await service.create(headers, projectId, {
      ...operation(),
      taskId,
      noteId: saved.id,
    });
    const updated = await service.update(headers, projectId, edit.id, {
      ...operation(),
      expectedRevision: edit.revision,
      title: 'Second title',
      contentMarkdown: 'Second canonical.',
    });
    await service.save(headers, projectId, edit.id, {
      ...operation(),
      expectedRevision: updated.revision,
      discardOriginalConfirmed: false,
    });
    const restored = await service.restore(
      headers,
      projectId,
      taskId,
      saved.id,
      { ...operation(), expectedVersion: 2, versionNumber: 1 },
    );
    expect(restored.currentVersionNumber).toBe(3);
    expect(restored.contentMarkdown).toBe('Chưa test.');
    expect(
      (await service.versions(headers, projectId, taskId, saved.id, 1, 20))
        .data,
    ).toHaveLength(3);
  });

  it('rejects message completion when inferenceLeaseUntil expired and drops stale drafts on resume after restore', async () => {
    const initial = await draft('First version text.');
    const saved = await service.save(headers, projectId, initial.id, {
      ...operation(),
      expectedRevision: initial.revision,
      discardOriginalConfirmed: false,
    });
    const secondDraft = await service.create(headers, projectId, {
      ...operation(),
      taskId,
      noteId: saved.id,
    });
    const secondEdited = await service.update(
      headers,
      projectId,
      secondDraft.id,
      {
        ...operation(),
        expectedRevision: secondDraft.revision,
        title: 'Version 2',
        contentMarkdown: 'Second version text.',
      },
    );
    await service.save(headers, projectId, secondDraft.id, {
      ...operation(),
      expectedRevision: secondEdited.revision,
      discardOriginalConfirmed: false,
    });

    const staleOpen = await service.create(headers, projectId, {
      ...operation(),
      taskId,
      noteId: saved.id,
    });

    // Verify message() sets a >= 70s lease and rejects with 409 if lease expired mid-flight
    let releaseModel!: () => void;
    let enteredModel!: () => void;
    const modelEntered = new Promise<void>((resolve) => {
      enteredModel = resolve;
    });
    model.rewrite.mockImplementationOnce(async (input) => {
      enteredModel();
      await new Promise<void>((resolve) => {
        releaseModel = resolve;
      });
      return {
        result: parseAgentResult(
          prepareAgentRequest(input),
          JSON.stringify({
            status: 'SUGGESTION_READY',
            message: 'Late proposal.',
            suggestion: {
              replacementText: 'Late text.',
              suggestedTitle: null,
              changeSummary: ['Late.'],
            },
            questions: [],
            uncertainties: [],
          }),
        ),
        provenance: {},
      };
    });

    const startedAt = Date.now();
    const pendingMessage = service
      .message(headers, projectId, staleOpen.id, message(staleOpen.revision))
      .catch((err) => err as { status: number });
    await modelEntered;
    const leasedRow = await connection
      .db!.collection<DraftRow>('work_note_agent_drafts')
      .findOne({ _id: staleOpen.id });
    expect(
      (leasedRow?.inferenceLeaseUntil as Date).getTime() - startedAt,
    ).toBeGreaterThanOrEqual(70_000);

    await connection
      .db!.collection<DraftRow>('work_note_agent_drafts')
      .updateOne(
        { _id: staleOpen.id },
        { $set: { inferenceLeaseUntil: new Date(Date.now() - 1) } },
      );
    releaseModel();
    expect(await pendingMessage).toMatchObject({ status: 409 });

    // Restore version 1 while staleOpen was still stored in DB; resume() must drop staleOpen and return null
    await service.restore(headers, projectId, taskId, saved.id, {
      ...operation(),
      expectedVersion: 2,
      versionNumber: 1,
    });
    expect(
      await service.resume(headers, projectId, taskId, saved.id),
    ).toBeNull();
  });
});
