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
import { assessmentHash } from './work-note-assessment.protocol';
import {
  ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
  ASSESSMENT_EDITOR_PROVIDER_POLICY,
  buildAssessmentEditorInput,
  assertAssessmentEditorProposal,
} from './work-note-assessment-editor';
import {
  AssessmentPipelineError,
  buildAssessmentSources,
  canRequestAssessmentRewrite,
  computeAssessmentTaskHash,
  finalizeAssessmentTurn,
  prepareCorrectionAssessmentInput,
  prepareInitialAssessmentInput,
  prepareReplyAssessmentInput,
  prepareResetAssessmentInput,
  validateAssessmentRequestBudget,
  type AssessmentArchitecture,
} from './work-note-assessment.pipeline';
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
  computeAssessmentTaskHash({
    taskContext: a.taskContext,
    taskContextVersion: a.taskContextVersion,
    taskContextInvalid: Boolean(a.taskContextInvalid),
  });
const rethrowPipelineError = (error: unknown): never => {
  if (error instanceof AssessmentPipelineError) {
    switch (error.code) {
      case 'ASSESSMENT_CONTEXT_INVALID':
      case 'CONTEXT_UNAVAILABLE':
        throw new ServiceUnavailableException({
          code: 'ASSESSMENT_CONTEXT_INVALID',
          message: error.message,
        });
      case 'ASSESSMENT_STALE':
        throw stale();
      case 'VALIDATION_FAILED':
        throw invalid(error.message);
      case 'ASSESSMENT_CONTEXT_LIMIT':
        throw new UnprocessableEntityException({
          code: 'ASSESSMENT_CONTEXT_LIMIT',
          message: error.message,
        });
    }
  }
  throw error;
};

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
  private architecture(): AssessmentArchitecture {
    const candidate = this.model as unknown as {
      getAssessmentArchitecture?: () => AssessmentArchitecture;
    };
    return candidate.getAssessmentArchitecture?.() ?? 'combined';
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
    try {
      return buildAssessmentSources({
        taskContext: a.taskContext,
        taskContextVersion: a.taskContextVersion,
        taskContextInvalid: Boolean(a.taskContextInvalid),
        note: {
          revision: d.revision,
          title: d.state.title,
          contentMarkdown: d.state.contentMarkdown,
        },
        answers,
      });
    } catch (error) {
      return rethrowPipelineError(error);
    }
  }
  async assess(
    headers: CaptureRequestHeaders,
    p: string,
    id: string,
    input: AssessmentInput,
  ) {
    this.enabled();
    return this.infer(headers, p, id, input, 'assess', null, (d, a) =>
      prepareInitialAssessmentInput({
        purpose: input.purpose,
        sourcesBuilder: (answers) => this.sources(d, a, answers),
      }),
    );
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
      try {
        return prepareReplyAssessmentInput({
          current: v,
          questionId: input.questionId,
          gapId: input.gapId,
          disposition: input.disposition,
          answer: input.answer,
          sourcesBuilder: (answers) => this.sources(d, a, answers),
        });
      } catch (error) {
        return rethrowPipelineError(error);
      }
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
        try {
          return prepareCorrectionAssessmentInput({
            current: v,
            targetClaimOrGapId: input.targetClaimOrGapId,
            correctionText: input.correctionText,
            sourcesBuilder: (answers) => this.sources(d, a, answers),
          });
        } catch (error) {
          return rethrowPipelineError(error);
        }
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
        try {
          return prepareResetAssessmentInput({
            current: v,
            currentTaskContextHash: taskHash(a),
            newPurpose: input.newPurpose,
            carryAnswerIds: input.carryAnswerIds,
            sourcesBuilder: (answers) => this.sources(d, a, answers),
          });
        } catch (error) {
          return rethrowPipelineError(error);
        }
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
      validateAssessmentRequestBudget(modelInput, this.architecture());
    } catch (error) {
      rethrowPipelineError(error);
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
            inferenceLeaseUntil: new Date(
              Date.now() +
                ASSESSMENT_ANALYSIS_PROVIDER_POLICY.timeoutMs +
                10000,
            ),
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
      const v = finalizeAssessmentTurn({
        input: modelInput,
        modelResult: completion.result,
        sourceRevision: d.revision,
        taskContextHash: taskHash(actor),
        modelName: this.config.get<string>('XKIRO_MODEL') ?? '',
        expiresAt: new Date(
          Math.min(d.expiresAt.getTime(), d.createdAt.getTime() + DAY),
        ).toISOString(),
        provisionalId: provisional.id,
        provenance: completion.provenance,
      });
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
    if (!canRequestAssessmentRewrite(v)) throw stale();
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
            inferenceLeaseUntil: new Date(
              Date.now() + ASSESSMENT_EDITOR_PROVIDER_POLICY.timeoutMs + 10000,
            ),
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
      const editorInput = buildAssessmentEditorInput(
        {
          revision: d.revision,
          title: d.state.title,
          body: d.state.contentMarkdown,
        },
        actor.taskContext ?? null,
        v,
      );
      const completion = await this.model.rewrite(editorInput, 'assessment');
      assertAssessmentEditorProposal(editorInput, completion.result);
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
