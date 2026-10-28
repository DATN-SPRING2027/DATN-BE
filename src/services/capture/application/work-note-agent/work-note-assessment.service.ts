import {
  BadGatewayException,
  ConflictException,
  HttpException,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { Connection } from 'mongoose';
import {
  WorkNoteAgentDraftsService,
  type DraftRow,
} from './work-note-agent-drafts.service';
import { WorkNoteAgentModel } from '../../infrastructure/ai/work-note-agent.model';
import { WorkNotesAuthorizationService } from '../work-notes-authorization.service';
import { WorkNotesService } from '../work-notes.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { CAPTURE_PERSISTENCE } from '../../infrastructure/persistence';
import type {
  CaptureRequestHeaders,
  WorkNotesActor,
} from '../work-notes.types';
import type {
  AssessmentAnswer,
  AssessmentCorrection,
  AssessmentInput,
  AssessmentModelInput,
  AssessmentMutation,
  AssessmentReply,
  AssessmentReset,
  AssessmentSource,
  AssessmentView,
} from './work-note-assessment.types';
import {
  assessmentHash,
  assertAssessmentFidelity,
  buildAssessmentMessages,
} from './work-note-assessment.protocol';
import {
  assembleAssessment,
  assessmentActions,
  staleAssessment,
} from './work-note-assessment.state';

const DAY = 86400000;
const stale = () =>
  new ConflictException({
    code: 'ASSESSMENT_STALE',
    message:
      'The note, task, purpose or assessment changed. Check information again.',
  });
const invalid = (message = 'Assessment input is invalid.') =>
  new UnprocessableEntityException({ code: 'VALIDATION_FAILED', message });
const taskHash = (a: WorkNotesActor) =>
  assessmentHash([
    a.taskContext,
    a.taskContextVersion,
    Boolean(a.taskContextInvalid),
  ]);
@Injectable()
export class WorkNoteAssessmentService extends WorkNoteAgentDraftsService {
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
  private enabled() {
    const f = this.config.get<boolean | string>('WORKNOTE_ASSESSMENT_ENABLED');
    if (f !== true && f !== 'true')
      throw new ServiceUnavailableException({
        code: 'WORKNOTE_ASSESSMENT_DISABLED',
        message: 'Assessment is unavailable. You can still save.',
      });
  }
  private current(
    d: DraftRow,
    a: WorkNotesActor,
    id: string,
    input: AssessmentMutation,
    allowStale = false,
  ) {
    if (!allowStale && a.taskContextInvalid)
      throw new ServiceUnavailableException({
        code: 'ASSESSMENT_CONTEXT_INVALID',
        message:
          'Task context could not be loaded correctly. Retry loading it; your note can still be saved.',
      });
    const v = d.state.assessment;
    if (
      !v ||
      v.id !== id ||
      v.revision !== input.expectedAssessmentRevision ||
      d.revision !== input.expectedRevision
    )
      throw stale();
    if (
      !allowStale &&
      (v.state === 'stale' ||
        v.sourceRevision !== d.revision ||
        v.taskContextHash !== taskHash(a) ||
        Date.parse(v.expiresAt) <= Date.now())
    )
      throw stale();
    if (
      allowStale &&
      (v.sourceRevision !== d.revision || v.taskContextHash !== taskHash(a))
    )
      return staleAssessment(v);
    return v;
  }
  private sources(
    d: DraftRow,
    a: WorkNotesActor,
    answers: AssessmentAnswer[],
  ): AssessmentSource[] {
    if (a.taskContextInvalid || !a.taskContext)
      throw new ServiceUnavailableException({
        code: 'ASSESSMENT_CONTEXT_INVALID',
        message:
          'Task context could not be loaded correctly. This is not missing authored requirements. Retry; your note can still be saved.',
      });
    const t = a.taskContext,
      h = taskHash(a),
      v = a.taskContextVersion ?? h;
    const source = (
      id: string,
      kind: AssessmentSource['kind'],
      label: string,
      text: string,
      version: string,
    ): AssessmentSource => ({
      id,
      kind,
      label,
      text,
      version,
      loadStatus: 'LOADED',
      includedInRequest: true,
    });
    return [
      source('task.title', 'TASK', 'Task title', t.title, v),
      source(
        'task.description',
        'TASK',
        'Task description',
        t.description ?? '',
        v,
      ),
      source(
        'task.status',
        'TASK',
        'Task status (not execution evidence)',
        t.status,
        v,
      ),
      ...t.steps.map((s, i) =>
        source(`task.step.${i}`, 'TASK', `Checklist ${i + 1}`, s.text, v),
      ),
      source(
        'note.title',
        'NOTE',
        'Note title',
        d.state.title,
        String(d.revision),
      ),
      source(
        'note.body',
        'NOTE',
        'Note content',
        d.state.contentMarkdown,
        String(d.revision),
      ),
      ...answers.map((x) =>
        source(
          `answer.${x.id}`,
          'ANSWER',
          `Author clarification: ${x.target}`,
          x.disposition === 'answered' ? (x.answer ?? '') : x.disposition,
          String(d.revision),
        ),
      ),
    ];
  }
  async assess(
    headers: CaptureRequestHeaders,
    p: string,
    id: string,
    input: AssessmentInput,
  ) {
    this.enabled();
    return this.infer(headers, p, id, input, 'assess', null, (d, a) => ({
      sources: this.sources(d, a, []),
      purpose: input.purpose,
      previous: null,
      answers: [],
    }));
  }
  async reply(
    headers: CaptureRequestHeaders,
    p: string,
    id: string,
    assessmentId: string,
    input: AssessmentReply,
  ) {
    this.enabled();
    return this.infer(headers, p, id, input, 'reply', assessmentId, (d, a) => {
      const v = this.current(d, a, assessmentId, input);
      if (
        v.state !== 'waiting_for_answer' ||
        !v.nextQuestion ||
        v.nextQuestion.id !== input.questionId ||
        v.nextQuestion.gapId !== input.gapId
      )
        throw stale();
      const g = v.gaps.find((g) => g.id === input.gapId);
      if (!g || v.answers.some((x) => x.gapId === g.id)) throw stale();
      const answer: AssessmentAnswer = {
        id: randomUUID(),
        gapId: g.id,
        target: g.target,
        disposition: input.disposition,
        ...(input.disposition === 'answered' ? { answer: input.answer } : {}),
        purpose: v.purpose,
        taskContextHash: v.taskContextHash,
      };
      const answers = [...v.answers, answer];
      if (answers.length > 20)
        throw invalid('Start a new assessment before adding more answers.');
      return {
        sources: this.sources(d, a, answers),
        purpose: v.purpose,
        previous: v,
        answers,
      };
    });
  }
  async correct(
    headers: CaptureRequestHeaders,
    p: string,
    id: string,
    assessmentId: string,
    input: AssessmentCorrection,
  ) {
    this.enabled();
    return this.infer(
      headers,
      p,
      id,
      input,
      'correct',
      assessmentId,
      (d, a) => {
        const v = this.current(d, a, assessmentId, input);
        if (
          ![...v.claims, ...v.gaps].some(
            (c) => c.id === input.targetClaimOrGapId,
          )
        )
          throw invalid('Correction target is not part of this assessment.');
        const answer: AssessmentAnswer = {
          id: randomUUID(),
          gapId: input.targetClaimOrGapId,
          target: 'author correction',
          disposition: 'answered',
          answer: input.correctionText,
          purpose: v.purpose,
          taskContextHash: v.taskContextHash,
        };
        const answers = [...v.answers, answer];
        if (answers.length > 20)
          throw invalid(
            'Start a new assessment before adding more corrections.',
          );
        return {
          sources: this.sources(d, a, answers),
          purpose: v.purpose,
          previous: v,
          answers,
          correction: {
            targetId: input.targetClaimOrGapId,
            text: input.correctionText,
          },
        };
      },
    );
  }
  async resetAssessment(
    headers: CaptureRequestHeaders,
    p: string,
    id: string,
    assessmentId: string,
    input: AssessmentReset,
  ) {
    this.enabled();
    return this.infer(
      headers,
      p,
      id,
      input,
      'reset_assessment',
      assessmentId,
      (d, a) => {
        const v = this.current(d, a, assessmentId, input, true);
        const answers = input.carryAnswerIds.map((x) => {
          const answer = v.answers.find((v) => v.id === x);
          if (
            !answer ||
            answer.disposition !== 'answered' ||
            answer.taskContextHash !== taskHash(a)
          )
            throw invalid('Answer cannot be carried into the new context.');
          if (
            input.newPurpose !== v.purpose &&
            (input.newPurpose === 'QA' ||
              v.purpose === 'QA' ||
              input.newPurpose === 'OTHER' ||
              v.purpose === 'OTHER')
          )
            throw invalid(
              'Answer relevance is not established for the new purpose.',
            );
          return answer;
        });
        return {
          sources: this.sources(d, a, answers),
          purpose: input.newPurpose,
          previous: null,
          answers,
        };
      },
    );
  }
  private async infer(
    headers: CaptureRequestHeaders,
    p: string,
    id: string,
    input: AssessmentInput | AssessmentMutation,
    kind: string,
    assessmentId: string | null,
    build: (d: DraftRow, a: WorkNotesActor) => AssessmentModelInput,
  ): Promise<AssessmentView> {
    const { actor, draft: d } = await this.owned(headers, p, id),
      payload = {
        kind: `assessment_${kind}`,
        projectId: p,
        id,
        assessmentId,
        ...input,
      };
    const prior = await this.prior(actor, input.operationId, payload);
    if (prior) {
      if (
        !prior.result ||
        typeof prior.result !== 'object' ||
        !('schemaVersion' in prior.result)
      )
        throw stale();
      const recorded = prior.result as AssessmentView;
      if (
        recorded.sourceRevision !== d.revision ||
        recorded.taskContextHash !== taskHash(actor) ||
        recorded.id !== d.state.assessment?.id ||
        recorded.revision !== d.state.assessment?.revision
      )
        throw stale();
      return recorded;
    }
    if (d.revision !== input.expectedRevision) throw stale();
    const modelInput = build(d, actor);
    try {
      buildAssessmentMessages(modelInput);
    } catch {
      throw new UnprocessableEntityException({
        code: 'ASSESSMENT_CONTEXT_LIMIT',
        message:
          'The complete context exceeds the analysis budget. No requirements were silently omitted.',
      });
    }
    if (!(await this.consumeAgentQuota(actor)))
      throw new HttpException(
        {
          code: 'AGENT_RATE_LIMIT',
          message: 'Agent quota reached; Save is still available.',
        },
        429,
      );
    const provisional = modelInput.previous
      ? structuredClone(modelInput.previous)
      : assembleAssessment(
          modelInput,
          {
            purpose:
              modelInput.purpose === 'AUTO' ? 'OTHER' : modelInput.purpose,
            taskUnderstanding: {
              objective: '',
              scope: '',
              requirements: [],
              unknowns: [],
            },
            claims: [],
            coverage: [],
            gaps: [],
            taskContextStatus: 'INSUFFICIENT',
            noteAdequacy: 'UNDETERMINED',
            nextQuestion: null,
          },
          {
            sourceRevision: d.revision,
            taskContextHash: taskHash(actor),
            model: this.config.get<string>('XKIRO_MODEL') ?? '',
            expiresAt: d.expiresAt.toISOString(),
          },
        );
    provisional.state = 'analyzing';
    provisional.allowedActions = ['manual'];
    provisional.nextQuestion = null;
    await this.transaction(async (_db, session) => {
      if (await this.prior(actor, input.operationId, payload, session))
        throw stale();
      const match = await this.drafts().updateOne(
        {
          _id: id,
          ...this.scope(actor),
          revision: d.revision,
          expiresAt: { $gt: new Date() },
          ...(d.state.assessment
            ? {
                'state.assessment.id': d.state.assessment.id,
                'state.assessment.revision': d.state.assessment.revision,
              }
            : {}),
          $or: [
            { inferenceLeaseUntil: { $exists: false } },
            { inferenceLeaseUntil: { $lte: new Date() } },
          ],
        },
        {
          $set: {
            inferenceOperationId: input.operationId,
            inferenceLeaseUntil: new Date(Date.now() + 45000),
            'state.assessment': provisional,
            'state.pendingQuestion': null,
          },
        },
        { session },
      );
      if (match.modifiedCount !== 1) throw stale();
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
      const completion = await this.model.assess(modelInput);
      const fresh = await this.owned(headers, p, id);
      if (taskHash(fresh.actor) !== taskHash(actor)) throw stale();
      const v = assembleAssessment(modelInput, completion.result, {
        sourceRevision: d.revision,
        taskContextHash: taskHash(actor),
        model: this.config.get<string>('XKIRO_MODEL') ?? '',
        expiresAt: new Date(
          Math.min(d.expiresAt.getTime(), d.createdAt.getTime() + DAY),
        ).toISOString(),
      });
      if (!modelInput.previous) v.id = provisional.id;
      v.trace = [
        ...v.trace,
        {
          phase: 'analysis',
          reasonCode: 'MODEL_COMPLETED',
          at: new Date().toISOString(),
          ...completion.provenance,
        },
      ]
        .map(
          ({
            phase,
            reasonCode,
            at,
            durationMs,
            promptTokens,
            completionTokens,
            httpAttempts,
          }) => ({
            phase,
            reasonCode,
            at,
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(promptTokens !== undefined ? { promptTokens } : {}),
            ...(completionTokens !== undefined ? { completionTokens } : {}),
            ...(httpAttempts !== undefined ? { httpAttempts } : {}),
          }),
        )
        .slice(-40);
      return await this.transaction(async (_db, session) => {
        const changed = await this.drafts().updateOne(
          {
            _id: id,
            ...this.scope(actor),
            revision: d.revision,
            inferenceOperationId: input.operationId,
            inferenceLeaseUntil: { $gt: new Date() },
            'state.assessment.id': provisional.id,
            'state.assessment.revision': provisional.revision,
            expiresAt: { $gt: new Date() },
          },
          {
            $set: {
              'state.assessment': v,
              updatedAt: new Date(),
              expiresAt: new Date(v.expiresAt),
            },
            $unset: { inferenceOperationId: '', inferenceLeaseUntil: '' },
          },
          { session },
        );
        if (changed.modifiedCount !== 1) throw stale();
        await this.operations().updateOne(
          { _id: this.opId(actor, input.operationId) },
          { $set: { status: 'COMPLETED', result: v } },
          { session },
        );
        return v;
      });
    } catch (e) {
      await this.operations().updateOne(
        { _id: this.opId(actor, input.operationId), status: 'PENDING' },
        { $set: { status: 'FAILED', failureCode: 'ASSESSMENT_FAILED' } },
      );
      await this.drafts().updateOne(
        {
          _id: id,
          inferenceOperationId: input.operationId,
          'state.assessment.id': provisional.id,
          'state.assessment.revision': provisional.revision,
        },
        {
          $set: {
            'state.assessment.state':
              e instanceof ConflictException ? 'stale' : 'error',
            'state.assessment.allowedActions': ['reset', 'feedback', 'manual'],
          },
          $unset: { inferenceOperationId: '', inferenceLeaseUntil: '' },
        },
      );
      if (e instanceof HttpException) throw e;
      throw new BadGatewayException({
        code: 'ASSESSMENT_FAILED',
        message:
          'Assessment could not be completed safely. Your note is unchanged and can still be saved.',
      });
    }
  }
  async rewriteAssessment(
    headers: CaptureRequestHeaders,
    p: string,
    id: string,
    assessmentId: string,
    input: AssessmentMutation,
  ) {
    this.enabled();
    const { actor, draft: d } = await this.owned(headers, p, id),
      payload = {
        kind: 'assessment_rewrite',
        projectId: p,
        id,
        assessmentId,
        ...input,
      };
    const replay = await this.prior(actor, input.operationId, payload);
    if (replay) {
      const current = d.state.assessment;
      if (
        !current ||
        current.id !== assessmentId ||
        current.sourceRevision !== d.revision ||
        current.taskContextHash !== taskHash(actor) ||
        current.revision !== input.expectedAssessmentRevision + 1
      )
        throw stale();
      return replay.result;
    }
    const v = this.current(d, actor, assessmentId, input);
    if (!v.allowedActions.includes('rewrite')) throw stale();
    if (!(await this.consumeAgentQuota(actor)))
      throw new HttpException({ code: 'AGENT_RATE_LIMIT' }, 429);
    await this.transaction(async (_db, session) => {
      if (await this.prior(actor, input.operationId, payload, session))
        throw stale();
      const claim = await this.drafts().updateOne(
        {
          _id: id,
          ...this.scope(actor),
          revision: d.revision,
          'state.assessment.revision': v.revision,
          $or: [
            { inferenceLeaseUntil: { $exists: false } },
            { inferenceLeaseUntil: { $lte: new Date() } },
          ],
        },
        {
          $set: {
            inferenceOperationId: input.operationId,
            inferenceLeaseUntil: new Date(Date.now() + 45000),
          },
        },
        { session },
      );
      if (claim.modifiedCount !== 1) throw stale();
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
      const completion = await this.model.rewrite({
        workflow: 'TASK_NOTE',
        operation: 'custom',
        scope: 'whole_note',
        instruction: `Biên tập note cho mục đích ${v.purpose}, giữ nguồn và mọi điều chưa rõ. Đánh giá hiện tại ${v.noteAdequacy}; không tự nâng thành đầy đủ/đã hoàn thành. Chỉ trả đề xuất khi có thể giữ trung thực dữ kiện gốc; không tự hỏi thêm ngoài workflow.`,
        draft: {
          revision: d.revision,
          title: d.state.title,
          body: d.state.contentMarkdown,
        },
        task: actor.taskContext ?? null,
        clarifications: v.answers.map((a) => ({
          id: a.id,
          question: a.target,
          state: a.disposition === 'skipped' ? 'skipped' : 'answered',
          ...(a.disposition !== 'skipped'
            ? { answer: a.disposition === 'unknown' ? 'Chưa biết' : a.answer }
            : {}),
        })),
        history: v.gaps
          .filter((g) => g.status !== 'answered')
          .slice(0, 8)
          .map((g) => ({
            role: 'user' as const,
            content: JSON.stringify({
              assessmentLimitation: {
                kind: g.kind,
                target: g.target,
                status: g.status,
                owner: g.owner,
              },
            }),
          })),
      });
      if (
        completion.result.status !== 'SUGGESTION_READY' ||
        !completion.result.suggestion?.replacementText
      )
        throw invalid('Editor did not provide a valid proposal.');
      assertAssessmentFidelity(
        d.state.contentMarkdown,
        completion.result.suggestion.replacementText,
      );
      for (const answer of v.answers) {
        if (answer.disposition === 'answered' && answer.answer)
          assertAssessmentFidelity(
            answer.answer,
            completion.result.suggestion.replacementText,
          );
      }
      const fresh = await this.owned(headers, p, id);
      if (taskHash(fresh.actor) !== taskHash(actor)) throw stale();
      const response = { ...completion.result, sourceRevision: d.revision };
      await this.transaction(async (_db, session) => {
        const next = {
          ...v,
          revision: v.revision + 1,
          trace: [
            ...v.trace,
            {
              phase: 'rewrite',
              reasonCode: 'PROPOSAL_ONLY',
              at: new Date().toISOString(),
            },
          ].slice(-40),
        };
        const changed = await this.drafts().updateOne(
          {
            _id: id,
            ...this.scope(actor),
            revision: d.revision,
            inferenceOperationId: input.operationId,
            inferenceLeaseUntil: { $gt: new Date() },
            'state.assessment.id': v.id,
            'state.assessment.revision': v.revision,
            expiresAt: { $gt: new Date() },
          },
          {
            $set: {
              'state.suggestion': completion.result.suggestion,
              'state.suggestionTaskHash': this.legacyTaskHash(
                actor.taskContext,
              ),
              'state.suggestionProvenance': completion.provenance,
              'state.assessment': next,
            },
            $unset: { inferenceOperationId: '', inferenceLeaseUntil: '' },
          },
          { session },
        );
        if (changed.modifiedCount !== 1) throw stale();
        await this.operations().updateOne(
          { _id: this.opId(actor, input.operationId) },
          { $set: { status: 'COMPLETED', result: response } },
          { session },
        );
      });
      return response;
    } catch (e) {
      await this.operations().updateOne(
        { _id: this.opId(actor, input.operationId), status: 'PENDING' },
        {
          $set: { status: 'FAILED', failureCode: 'ASSESSMENT_REWRITE_FAILED' },
        },
      );
      if (e instanceof HttpException) throw e;
      throw new BadGatewayException({
        code: 'ASSESSMENT_REWRITE_FAILED',
        message: 'Proposal failed validation. Original text remains available.',
      });
    } finally {
      await this.drafts().updateOne(
        { _id: id, inferenceOperationId: input.operationId },
        { $unset: { inferenceOperationId: '', inferenceLeaseUntil: '' } },
      );
    }
  }
  private legacyTaskHash(value: unknown): string {
    return assessmentHash(
      JSON.parse(
        JSON.stringify(value ?? null, (_k, v: unknown) =>
          v && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(
                Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
              )
            : v,
        ),
      ),
    );
  }
  private async metadata(
    headers: CaptureRequestHeaders,
    p: string,
    id: string,
    assessmentId: string,
    input: AssessmentMutation,
    kind: string,
    change: (v: AssessmentView) => void,
    allowStale = false,
  ) {
    this.enabled();
    const boundInput = { ...input, assessmentId };
    return this.mutate(
      headers,
      p,
      id,
      boundInput,
      `assessment_${kind}`,
      async (d, a, _db, session) => {
        const v = structuredClone(
          this.current(d, a, assessmentId, input, allowStale),
        );
        if (
          v.state === 'analyzing' &&
          (!d.inferenceLeaseUntil ||
            d.inferenceLeaseUntil.getTime() <= Date.now())
        ) {
          v.state = 'error';
          v.allowedActions = ['reset', 'feedback', 'manual'];
        }
        if (
          kind === 'author_validate' &&
          !v.allowedActions.includes('validate_author')
        )
          throw stale();
        change(v);
        v.revision++;
        v.allowedActions = assessmentActions(v);
        const updated = await this.drafts().updateOne(
          {
            _id: id,
            ...this.scope(a),
            revision: d.revision,
            'state.assessment.id': assessmentId,
            'state.assessment.revision': input.expectedAssessmentRevision,
            $or: [
              { inferenceLeaseUntil: { $exists: false } },
              { inferenceLeaseUntil: { $lte: new Date() } },
            ],
          },
          {
            $set: { 'state.assessment': v },
            $unset: { inferenceOperationId: '', inferenceLeaseUntil: '' },
          },
          { session },
        );
        if (updated.modifiedCount !== 1) throw stale();
        return v;
      },
    );
  }
  async validateAuthor(
    headers: CaptureRequestHeaders,
    p: string,
    id: string,
    assessmentId: string,
    input: AssessmentMutation,
  ) {
    return this.metadata(
      headers,
      p,
      id,
      assessmentId,
      input,
      'author_validate',
      (v) => {
        v.authorValidated = true;
        v.signals.authorValidated = true;
      },
    );
  }
  async feedback(
    headers: CaptureRequestHeaders,
    p: string,
    id: string,
    assessmentId: string,
    input: AssessmentMutation & {
      category:
        | 'UNNECESSARY_QUESTION'
        | 'MISSING_QUESTION'
        | 'WRONG_SOURCE'
        | 'FALSE_SUFFICIENT';
    },
  ) {
    return this.metadata(
      headers,
      p,
      id,
      assessmentId,
      input,
      'feedback',
      (v) => {
        v.feedback = [
          ...(v.feedback ?? []),
          { category: input.category, at: new Date().toISOString() },
        ].slice(-20);
      },
      true,
    );
  }
}
