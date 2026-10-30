/* Async fake services intentionally implement the production Promise contract. */
/* eslint-disable @typescript-eslint/require-await */
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import { WorkNoteAssessmentService } from './work-note-assessment.service';
import type { DraftRow } from './work-note-agent-drafts.service';
import type {
  AssessmentModelInput,
  AssessmentModelOutput,
} from './work-note-assessment.types';
import type { WorkNoteAgentModel } from '../../infrastructure/ai/work-note-agent.model';
import type { WorkNotesAuthorizationService } from '../work-notes-authorization.service';
import type { WorkNotesService } from '../work-notes.service';
import type { RedisService } from '../../infrastructure/redis/redis.service';
import type { WorkNotesActor } from '../work-notes.types';
import {
  prepareAgentRequest,
  parseAgentResult,
  type AgentInput,
} from './work-note-agent';

describe('Persisted Task assessment scope and lifecycle', () => {
  jest.setTimeout(120000);
  let repl: MongoMemoryReplSet,
    connection: Connection,
    service: WorkNoteAssessmentService;
  const projectId = new Types.ObjectId().toHexString(),
    taskId = new Types.ObjectId().toHexString(),
    organizationId = new Types.ObjectId().toHexString();
  let actor: WorkNotesActor;
  let invalid = false;
  let fail = false;
  let model: { assess: jest.Mock; rewrite: jest.Mock };
  const headers = { authorization: 'Bearer synthetic' };
  const op = () => ({ operationId: randomUUID() });
  const result = (input: AssessmentModelInput): AssessmentModelOutput => ({
    purpose: input.purpose === 'AUTO' ? 'PROGRESS' : input.purpose,
    taskUnderstanding: {
      objective: 'Update API',
      scope: 'API',
      requirements: [],
      unknowns: [],
    },
    claims: [
      {
        text: input.sources.find((s) => s.id === 'note.body')!.text,
        sourceRefs: [
          {
            sourceId: 'note.body',
            quote: input.sources.find((s) => s.id === 'note.body')!.text,
          },
        ],
        originKind: 'AUTHOR_REPORT',
        supportRelation: 'FULL',
      },
    ],
    coverage: [],
    gaps: [],
    nextQuestion: null,
    taskContextStatus: 'INSUFFICIENT',
    noteAdequacy: 'ENOUGH_FOR_PURPOSE',
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
    for (const c of ['work_note_agent_drafts', 'work_note_agent_operations'])
      await connection
        .db!.collection(c)
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await connection
      .db!.collection('work_note_versions')
      .createIndex({ workNoteId: 1, versionNumber: 1 }, { unique: true });
    invalid = false;
    fail = false;
    actor = {
      userId: new Types.ObjectId().toHexString(),
      userName: 'Author',
      organizationId,
      projectId,
      canReview: false,
      canConfigure: false,
      taskContext: {
        title: 'Implement API',
        description: null,
        status: 'DONE',
        steps: [],
      },
    };
    const auth = {
      resolveProject: jest.fn(async () => {
        if (fail) throw Error('auth unavailable');
        return actor;
      }),
      resolveTask: jest.fn(async () => ({
        ...actor,
        taskContextInvalid: invalid,
      })),
    };
    model = {
      assess: jest.fn(async (i: AssessmentModelInput) => ({
        result: result(i),
        provenance: { model: 'synthetic/model', httpAttempts: 1 },
      })),
      rewrite: jest.fn(),
    };
    service = new WorkNoteAssessmentService(
      new ConfigService({
        WORKNOTE_EDITOR_ENABLED: true,
        WORKNOTE_ASSESSMENT_ENABLED: true,
        XKIRO_MODEL: 'synthetic/model',
      }),
      auth as unknown as WorkNotesAuthorizationService,
      {} as WorkNotesService,
      model as unknown as WorkNoteAgentModel,
      {
        consumeRateLimit: jest.fn(async () => true),
      } as unknown as RedisService,
      connection,
    );
  });
  const draft = async () => {
    const d = await service.create(headers, projectId, { ...op(), taskId });
    return service.update(headers, projectId, d.id, {
      ...op(),
      expectedRevision: d.revision,
      title: 'API progress',
      contentMarkdown: 'Updated API. Not tested.',
    });
  };
  it('assesses only on demand, resumes the result and replays without a second inference', async () => {
    const d = await draft();
    expect(model.assess).not.toHaveBeenCalled();
    const i = {
      ...op(),
      expectedRevision: d.revision,
      purpose: 'PROGRESS' as const,
    };
    const a = await service.assess(headers, projectId, d.id, i);
    expect(a.contextManifest.sources.some((s) => s.id === 'task.title')).toBe(
      true,
    );
    expect(a.reviewerSemanticAssessment).toBe('NOT_ESTABLISHED');
    expect((await service.assess(headers, projectId, d.id, i)).id).toBe(a.id);
    expect(model.assess).toHaveBeenCalledTimes(1);
    expect((await service.get(headers, projectId, d.id)).assessment?.id).toBe(
      a.id,
    );
  });
  it('does not confuse malformed Task acquisition with missing authored requirements', async () => {
    const d = await draft();
    invalid = true;
    await expect(
      service.assess(headers, projectId, d.id, {
        ...op(),
        expectedRevision: d.revision,
        purpose: 'AUTO',
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(model.assess).not.toHaveBeenCalled();
    expect(
      (
        await connection
          .db!.collection<DraftRow>('work_note_agent_drafts')
          .findOne({ _id: d.id })
      )?.state.contentMarkdown,
    ).toBe('Updated API. Not tested.');
  });
  it('invalidates assessment on note edits and rejects stale rewrite', async () => {
    const d = await draft(),
      a = await service.assess(headers, projectId, d.id, {
        ...op(),
        expectedRevision: d.revision,
        purpose: 'PROGRESS',
      });
    const n = await service.update(headers, projectId, d.id, {
      ...op(),
      expectedRevision: d.revision,
      title: d.title,
      contentMarkdown: 'New note. Not tested.',
    });
    expect(n.assessment?.state).toBe('stale');
    await expect(
      service.rewriteAssessment(headers, projectId, d.id, a.id, {
        ...op(),
        expectedRevision: n.revision,
        expectedAssessmentRevision: a.revision,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(model.rewrite).not.toHaveBeenCalled();
  });
  it('enforces absolute24h even when a legacy record has a later expiresAt', async () => {
    const d = await draft();
    await connection
      .db!.collection<DraftRow>('work_note_agent_drafts')
      .updateOne(
        { _id: d.id },
        {
          $set: {
            createdAt: new Date(Date.now() - 86401000),
            expiresAt: new Date(Date.now() + 86400000),
          },
        },
      );
    await expect(service.get(headers, projectId, d.id)).rejects.toMatchObject({
      status: 404,
    });
  });
  it('records author validation and feedback without declaring reviewer acceptance or invoking AI', async () => {
    const d = await draft(),
      a = await service.assess(headers, projectId, d.id, {
        ...op(),
        expectedRevision: d.revision,
        purpose: 'PROGRESS',
      });
    const v = await service.validateAuthor(headers, projectId, d.id, a.id, {
      ...op(),
      expectedRevision: d.revision,
      expectedAssessmentRevision: a.revision,
    });
    expect(v.signals.authorValidated).toBe(true);
    expect(v.signals.saved).toBe(false);
    expect(v.signals.reviewerSemanticAssessment).toBe('NOT_ESTABLISHED');
    const f = await service.feedback(headers, projectId, d.id, v.id, {
      ...op(),
      expectedRevision: d.revision,
      expectedAssessmentRevision: v.revision,
      category: 'WRONG_SOURCE',
    });
    expect(f.feedback?.[0].category).toBe('WRONG_SOURCE');
    expect(model.assess).toHaveBeenCalledTimes(1);
  });
  it('rejects replay after Task changes without a second provider call', async () => {
    const d = await draft();
    const i = {
      ...op(),
      expectedRevision: d.revision,
      purpose: 'PROGRESS' as const,
    };
    await service.assess(headers, projectId, d.id, i);
    actor.taskContext = {
      ...actor.taskContext!,
      description: 'A different acceptance criterion',
    };
    await expect(
      service.assess(headers, projectId, d.id, i),
    ).rejects.toMatchObject({ status: 409 });
    expect(model.assess).toHaveBeenCalledTimes(1);
  });
  it('binds metadata operation IDs to their assessment path', async () => {
    const d = await draft();
    const a = await service.assess(headers, projectId, d.id, {
      ...op(),
      expectedRevision: d.revision,
      purpose: 'PROGRESS',
    });
    const i = {
      ...op(),
      expectedRevision: d.revision,
      expectedAssessmentRevision: a.revision,
    };
    await service.validateAuthor(headers, projectId, d.id, a.id, i);
    await expect(
      service.validateAuthor(headers, projectId, d.id, randomUUID(), i),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('allows recovery in a new session after model failure, without modifying the note', async () => {
    const d = await draft();
    model.assess.mockRejectedValueOnce(Error('provider failure'));
    await expect(
      service.assess(headers, projectId, d.id, {
        ...op(),
        expectedRevision: d.revision,
        purpose: 'PROGRESS',
      }),
    ).rejects.toMatchObject({ status: 502 });
    const failed = (await service.get(headers, projectId, d.id)).assessment!;
    expect(failed.state).toBe('error');
    expect(failed.revision).toBeGreaterThan(0);
    const fresh = await service.resetAssessment(
      headers,
      projectId,
      d.id,
      failed.id,
      {
        ...op(),
        expectedRevision: d.revision,
        expectedAssessmentRevision: failed.revision,
        newPurpose: 'PROGRESS',
        carryAnswerIds: [],
      },
    );
    expect(fresh.id).not.toBe(failed.id);
    expect(fresh.answers).toEqual([]);
    expect((await service.get(headers, projectId, d.id)).contentMarkdown).toBe(
      d.contentMarkdown,
    );
  });
  it('preserves concurrent feedback when an inference completes after its lease expires', async () => {
    const d = await draft();
    let finish!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    model.assess.mockImplementationOnce(async (i: AssessmentModelInput) => {
      started();
      await new Promise<void>((r) => {
        finish = r;
      });
      return { result: result(i), provenance: { httpAttempts: 1 } };
    });
    const pending = service.assess(headers, projectId, d.id, {
      ...op(),
      expectedRevision: d.revision,
      purpose: 'PROGRESS',
    });
    const outcome = pending.catch((e) => e as { status: number });
    await begun;
    const provisional = (await service.get(headers, projectId, d.id))
      .assessment!;
    await connection
      .db!.collection<DraftRow>('work_note_agent_drafts')
      .updateOne(
        { _id: d.id },
        { $set: { inferenceLeaseUntil: new Date(Date.now() - 1) } },
      );
    const feedback = await service.feedback(
      headers,
      projectId,
      d.id,
      provisional.id,
      {
        ...op(),
        expectedRevision: d.revision,
        expectedAssessmentRevision: provisional.revision,
        category: 'WRONG_SOURCE',
      },
    );
    finish();
    expect(await outcome).toMatchObject({ status: 409 });
    const resumed = (await service.get(headers, projectId, d.id)).assessment!;
    expect(resumed.revision).toBe(feedback.revision);
    expect(resumed.feedback).toEqual(feedback.feedback);
  });
  it('keeps unknown answers unresolved and suppresses the same question', async () => {
    const d = await draft();
    const withGap = (i: AssessmentModelInput): AssessmentModelOutput => ({
      ...result(i),
      noteAdequacy: 'NEEDS_AUTHOR_INPUT',
      gaps: [
        {
          kind: 'EVIDENCE',
          target: 'environment',
          impact: 'BLOCKING',
          owner: 'NOTE_AUTHOR',
          sourceRefs: [{ sourceId: 'note.body', quote: d.contentMarkdown }],
        },
      ],
      nextQuestion: {
        gapIndex: 0,
        text: 'Which environment?',
        reason: 'Environment is unspecified.',
        options: [],
      },
    });
    model.assess.mockImplementation(async (i: AssessmentModelInput) => ({
      result: withGap(i),
      provenance: { httpAttempts: 1 },
    }));
    const a = await service.assess(headers, projectId, d.id, {
      ...op(),
      expectedRevision: d.revision,
      purpose: 'PROGRESS',
    });
    expect(a.state).toBe('waiting_for_answer');
    const next = await service.reply(headers, projectId, d.id, a.id, {
      ...op(),
      expectedRevision: d.revision,
      expectedAssessmentRevision: a.revision,
      gapId: a.nextQuestion!.gapId,
      questionId: a.nextQuestion!.id,
      disposition: 'unknown',
    });
    expect(next.answers[0].disposition).toBe('unknown');
    expect(next.gaps[0].status).toBe('unknown');
    expect(next.nextQuestion).toBeNull();
    expect(next.state).toBe('paused');
    expect(next.noteAdequacy).not.toBe('ENOUGH_FOR_PURPOSE');
    const reset = await service.resetAssessment(
      headers,
      projectId,
      d.id,
      next.id,
      {
        ...op(),
        expectedRevision: d.revision,
        expectedAssessmentRevision: next.revision,
        newPurpose: 'QA',
        carryAnswerIds: [],
      },
    );
    expect(reset.id).not.toBe(a.id);
    expect(reset.answers).toEqual([]);
  });
  it('checks ownership and authorization again before inference and replay', async () => {
    const d = await draft();
    const i = {
      ...op(),
      expectedRevision: d.revision,
      purpose: 'PROGRESS' as const,
    };
    await service.assess(headers, projectId, d.id, i);
    actor.userId = new Types.ObjectId().toHexString();
    await expect(
      service.assess(headers, projectId, d.id, i),
    ).rejects.toMatchObject({ status: 404 });
    expect(model.assess).toHaveBeenCalledTimes(1);
  });
  it('replays proposal generation without applying it, then tracks explicit Apply separately from Save', async () => {
    const d = await draft();
    const a = await service.assess(headers, projectId, d.id, {
      ...op(),
      expectedRevision: d.revision,
      purpose: 'PROGRESS',
    });
    model.rewrite.mockImplementation(async (input: AgentInput) => ({
      result: parseAgentResult(
        prepareAgentRequest(input),
        JSON.stringify({
          status: 'SUGGESTION_READY',
          message: 'Proposal only',
          suggestion: {
            replacementText: d.contentMarkdown + ' Awaiting review.',
            suggestedTitle: null,
            changeSummary: ['Clarified progress'],
          },
          questions: [],
          uncertainties: [],
        }),
      ),
      provenance: { model: 'synthetic/model', httpAttempts: 1 },
    }));
    const i = {
      ...op(),
      expectedRevision: d.revision,
      expectedAssessmentRevision: a.revision,
    };
    const proposal = (await service.rewriteAssessment(
      headers,
      projectId,
      d.id,
      a.id,
      i,
    )) as { suggestion: { id: string } };
    expect((await service.get(headers, projectId, d.id)).contentMarkdown).toBe(
      d.contentMarkdown,
    );
    const replay = (await service.rewriteAssessment(
      headers,
      projectId,
      d.id,
      a.id,
      i,
    )) as { suggestion: { id: string } };
    expect(replay.suggestion.id).toBe(proposal.suggestion.id);
    expect(model.rewrite).toHaveBeenCalledTimes(1);
    const applied = await service.apply(
      headers,
      projectId,
      d.id,
      proposal.suggestion.id,
      {
        ...op(),
        expectedRevision: d.revision,
        action: 'replace_body',
        applyTitle: false,
      },
    );
    expect(applied.assessment?.state).toBe('stale');
    expect(applied.assessment?.signals.proposalApplied).toBe(true);
    expect(applied.assessment?.signals.saved).toBe(false);
    expect(applied.assessment?.signals.authorValidated).toBe(false);
    await service.save(headers, projectId, d.id, {
      ...op(),
      expectedRevision: applied.revision,
      discardOriginalConfirmed: true,
    });
    const receipt = await connection
      .db!.collection<{ result: { assessmentSignals: unknown } }>(
        'work_note_agent_operations',
      )
      .findOne({ 'result.assessmentSignals.saved': true });
    expect(receipt?.result.assessmentSignals).toMatchObject({
      saved: true,
      proposalApplied: true,
      authorValidated: false,
      reviewerSemanticAssessment: 'NOT_ESTABLISHED',
    });
  });
  it('anchors corrections to a claim, replays once and does not silently carry answers to QA', async () => {
    const d = await draft();
    const a = await service.assess(headers, projectId, d.id, {
      ...op(),
      expectedRevision: d.revision,
      purpose: 'PROGRESS',
    });
    const i = {
      ...op(),
      expectedRevision: d.revision,
      expectedAssessmentRevision: a.revision,
      targetClaimOrGapId: a.claims[0].id,
      correctionText: 'Only local API code changed. Not tested.',
    };
    const corrected = await service.correct(headers, projectId, d.id, a.id, i);
    expect(corrected.answers[0].answer).toBe(i.correctionText);
    const correctedCall = model.assess.mock.calls.at(-1) as [
      AssessmentModelInput,
    ];
    const correctedInput = correctedCall[0];
    expect(correctedInput.correction).toEqual({
      targetId: i.targetClaimOrGapId,
      text: i.correctionText,
    });
    expect(
      (await service.correct(headers, projectId, d.id, a.id, i)).revision,
    ).toBe(corrected.revision);
    expect(model.assess).toHaveBeenCalledTimes(2);
    await expect(
      service.resetAssessment(headers, projectId, d.id, a.id, {
        ...op(),
        expectedRevision: d.revision,
        expectedAssessmentRevision: corrected.revision,
        newPurpose: 'QA',
        carryAnswerIds: [corrected.answers[0].id],
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(actor.taskContext?.title).toBe('Implement API');
  });
  it('rejects invalid Task acquisition on rewrite even if the projected text has not changed', async () => {
    const d = await draft();
    const a = await service.assess(headers, projectId, d.id, {
      ...op(),
      expectedRevision: d.revision,
      purpose: 'PROGRESS',
    });
    invalid = true;
    expect(
      (await service.get(headers, projectId, d.id)).assessment?.state,
    ).toBe('stale');
    await expect(
      service.rewriteAssessment(headers, projectId, d.id, a.id, {
        ...op(),
        expectedRevision: d.revision,
        expectedAssessmentRevision: a.revision,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(model.rewrite).not.toHaveBeenCalled();
  });
  it('does not replay a timestamp-less legacy raw receipt beyond the original draft lifetime', async () => {
    const createInput = { ...op(), taskId };
    const d = await service.create(headers, projectId, createInput);
    await connection.db!.collection('work_note_agent_operations').updateMany(
      { draftId: d.id },
      {
        $unset: { createdAt: '' },
        $set: { expiresAt: new Date(Date.now() + 86400000) },
      },
    );
    await connection
      .db!.collection<DraftRow>('work_note_agent_drafts')
      .updateOne(
        { _id: d.id },
        {
          $set: {
            createdAt: new Date(Date.now() - 86401000),
            expiresAt: new Date(Date.now() + 86400000),
          },
        },
      );
    await expect(
      service.create(headers, projectId, createInput),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('keeps Save independent and removes analysis content from all closed receipts', async () => {
    const d = await draft();
    await service.assess(headers, projectId, d.id, {
      ...op(),
      expectedRevision: d.revision,
      purpose: 'PROGRESS',
    });
    await service.save(headers, projectId, d.id, {
      ...op(),
      expectedRevision: d.revision,
      discardOriginalConfirmed: false,
    });
    expect(
      await connection
        .db!.collection<DraftRow>('work_note_agent_drafts')
        .countDocuments(),
    ).toBe(0);
    const note = await connection.db!.collection('work_notes').findOne({});
    expect(note?.assessment).toBeUndefined();
    const receipts = await connection
      .db!.collection('work_note_agent_operations')
      .find()
      .toArray();
    expect(JSON.stringify(receipts)).not.toContain('Updated API');
    expect(JSON.stringify(receipts)).not.toContain('contextManifest');
  });
  it('allocates a dual-call inference lease (>170s) when WORKNOTE_ASSESSMENT_ARCHITECTURE is split', async () => {
    const splitService = new WorkNoteAssessmentService(
      new ConfigService({
        WORKNOTE_EDITOR_ENABLED: true,
        WORKNOTE_ASSESSMENT_ENABLED: true,
        WORKNOTE_ASSESSMENT_ARCHITECTURE: 'split',
        XKIRO_MODEL: 'synthetic/model',
      }),
      {
        resolveProject: jest.fn(async () => actor),
        resolveTask: jest.fn(async () => actor),
      } as unknown as WorkNotesAuthorizationService,
      {} as WorkNotesService,
      model as unknown as WorkNoteAgentModel,
      {
        consumeRateLimit: jest.fn(async () => true),
      } as unknown as RedisService,
      connection,
    );
    const d = await draft();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => {
      entered = r;
    });
    model.assess.mockImplementationOnce(async (i: AssessmentModelInput) => {
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
      return { result: result(i), provenance: { httpAttempts: 1 } };
    });
    const startedAt = Date.now();
    const pending = splitService.assess(headers, projectId, d.id, {
      ...op(),
      expectedRevision: d.revision,
      purpose: 'PROGRESS',
    });
    await gate;
    const row = await connection
      .db!.collection<DraftRow>('work_note_agent_drafts')
      .findOne({ _id: d.id });
    expect(
      (row?.inferenceLeaseUntil as Date).getTime() - startedAt,
    ).toBeGreaterThanOrEqual(180_000);
    release();
    await pending;
  });
});
