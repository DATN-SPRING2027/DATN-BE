import { AssessmentPhaseBudget } from './assessment-phase-budget';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse as parseEnv } from 'dotenv';
import type {
  AssessmentModelInput,
  AssessmentModelOutput,
  AssessmentView,
} from '../../src/services/capture/application/work-note-agent/work-note-assessment.types';
import {
  WorkNoteXkiroClient,
  XkiroError,
} from '../../src/services/capture/infrastructure/ai/work-note-xkiro.client';
import { AgentValidationError } from '../../src/services/capture/application/work-note-agent/work-note-agent';
import {
  buildAssessmentMessages,
  ASSESSMENT_PROMPT_VERSION,
} from '../../src/services/capture/application/work-note-agent/work-note-assessment.protocol';
import {
  SPLIT_ASSESSMENT_PROMPT_VERSION,
  buildTaskInterpreterMessages,
  type TaskInterpreterOutput,
} from '../../src/services/capture/application/work-note-agent/work-note-assessment-split';
import {
  AssessmentPipelineError,
  buildAssessmentSources,
  computeAssessmentTaskHash,
  executeAssessmentEditorCall,
  executeAssessmentModelCall,
  extractSnapshotsFromSources,
  finalizeAssessmentTurn,
  isEligibleForAutomatedEditorEvaluation,
  prepareCorrectionAssessmentInput,
  prepareInitialAssessmentInput,
  prepareReplyAssessmentInput,
  prepareResetAssessmentInput,
  validateAssessmentRequestBudget,
  type AssessmentArchitecture,
} from '../../src/services/capture/application/work-note-agent/work-note-assessment.pipeline';
import {
  ASSESSMENT_EDITOR_SYSTEM_PROMPT,
  ASSESSMENT_EDITOR_PROVIDER_POLICY,
  ASSESSMENT_EDITOR_INSTRUCTION_VERSION,
  ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
} from '../../src/services/capture/application/work-note-agent/work-note-assessment-editor';
import {
  loadAssessmentCorpus,
  loadRegression80Corpus,
  loadRelease60Corpus,
  gradeAssessment,
  makeAssessmentWorksheet,
  type AssessmentEvaluationRow,
  type AssessmentCorpus,
} from './assessment-evaluation';

export class AssessmentAttemptBudget {
  private actualHttpAttempts = 0;
  private reportedTokens = 0;
  private unknownUsageAttempts = 0;
  private chargedTokens = 0;
  denialCode:
    | 'HTTP_ATTEMPT_BUDGET'
    | 'TOKEN_RESERVATION_BUDGET'
    | 'PHASE_HTTP_ATTEMPT_BUDGET'
    | 'PHASE_TOKEN_RESERVATION_BUDGET'
    | null = null;
  readonly fetch: typeof fetch;
  constructor(
    private readonly maxAttempts: number,
    private readonly maxAccountedTokens: number,
    fetcher: typeof fetch = fetch,
    private readonly phase?: AssessmentPhaseBudget,
  ) {
    this.fetch = async (url, init) => {
      const endpoint =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (endpoint !== 'https://api.xkiro.com/v1/chat/completions')
        throw Error('ASSESSMENT_ENDPOINT_DENIED');
      if (this.actualHttpAttempts >= this.maxAttempts) {
        this.denialCode = 'HTTP_ATTEMPT_BUDGET';
        throw Error(this.denialCode);
      }
      let payload: { max_tokens?: number };
      if (typeof init?.body !== 'string')
        throw Error('ASSESSMENT_PAYLOAD_INVALID');
      const body = init.body;
      try {
        const parsed: unknown = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw Error('INVALID');
        payload = parsed;
      } catch {
        throw Error('ASSESSMENT_PAYLOAD_INVALID');
      }
      if (
        !Number.isSafeInteger(payload.max_tokens) ||
        payload.max_tokens! < 128 ||
        payload.max_tokens! > 8192
      )
        throw Error('ASSESSMENT_OUTPUT_BUDGET');
      // Conservative local reservation, not a tokenizer or a billing guarantee.
      // Unknown/failed usage remains fully charged, never treated as free.
      const reservation =
        Buffer.byteLength(body, 'utf8') + payload.max_tokens! + 128;
      if (this.chargedTokens + reservation > this.maxAccountedTokens) {
        this.denialCode = 'TOKEN_RESERVATION_BUDGET';
        throw Error(this.denialCode);
      }
      let phaseTicket: number | undefined;
      try {
        phaseTicket = this.phase?.reserve(reservation);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === 'PHASE_HTTP_ATTEMPT_BUDGET' ||
            error.message === 'PHASE_TOKEN_RESERVATION_BUDGET')
        )
          this.denialCode = error.message;
        throw error;
      }
      this.actualHttpAttempts++;
      this.chargedTokens += reservation;
      let response: Response;
      try {
        response = await fetcher(url, init);
      } catch {
        this.unknownUsageAttempts++;
        if (phaseTicket !== undefined) this.phase!.settle(phaseTicket, null);
        throw Error('ASSESSMENT_PROVIDER_NETWORK');
      }
      let reported: number | null = null;
      try {
        const reader = response.clone().body?.getReader();
        if (!reader) throw Error('NO_BODY');
        let bytes = 0,
          text = '';
        const decoder = new TextDecoder();
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 1_000_000) {
            await reader.cancel();
            throw Error('USAGE_BODY_LIMIT');
          }
          text += decoder.decode(part.value, { stream: true });
        }
        const usage = (
          JSON.parse(text + decoder.decode()) as {
            usage?: {
              total_tokens?: number;
              prompt_tokens?: number;
              completion_tokens?: number;
            };
          }
        ).usage;
        const sum =
          usage?.total_tokens ??
          (usage?.prompt_tokens !== undefined &&
          usage?.completion_tokens !== undefined
            ? usage.prompt_tokens + usage.completion_tokens
            : null);
        if (typeof sum === 'number' && Number.isSafeInteger(sum) && sum >= 0)
          reported = sum;
      } catch {
        /* Body/error details stay private; unknown usage retains reservation. */
      }
      if (phaseTicket !== undefined) this.phase!.settle(phaseTicket, reported);
      if (reported === null) this.unknownUsageAttempts++;
      else {
        this.reportedTokens += reported;
        this.chargedTokens += reported - reservation;
      }
      return response;
    };
  }
  snapshot() {
    return {
      maxHttpAttempts: this.maxAttempts,
      actualHttpAttempts: this.actualHttpAttempts,
      reportedTokens: this.reportedTokens,
      unknownUsageAttempts: this.unknownUsageAttempts,
      accountedTokenReservation: this.chargedTokens,
      maxAccountedTokens: this.maxAccountedTokens,
      monetaryCost: null,
      costStatus: 'NOT_ESTABLISHED',
      tokenAccounting: 'LOCAL_CONSERVATIVE_RESERVATION_NOT_PROVIDER_BILL',
    };
  }
}

export type AssessmentRunOptions = {
  live: boolean;
  corpus: 'v4' | 'regression80' | 'release60';
  batch: 'pilot' | 'full' | 'release';
  split: 'development' | 'validation' | 'holdout' | 'all';
  architecture: AssessmentArchitecture;
  model?: string;
  maxAttempts: number;
  maxPhaseAttempts?: number;
  maxTokens: number;
  maxTotalTokens: number;
  timeoutMs: number;
  phaseId?: string;
  caseIds?: string;
  maxTurns?: number;
  editorLimit?: number;
  disableInterpreterCache?: boolean;
  interCallDelayMs?: number;
  noFailFast?: boolean;
};

export function parseAssessmentRunOptions(
  args: readonly string[],
): AssessmentRunOptions {
  const o: AssessmentRunOptions = {
    live: false,
    corpus: 'v4',
    batch: 'pilot',
    split: 'development',
    architecture: 'combined',
    maxAttempts: 29,
    maxTokens: 8192,
    maxTotalTokens: 500000,
    timeoutMs: ASSESSMENT_ANALYSIS_PROVIDER_POLICY.timeoutMs,
  };
  const names: Record<string, keyof AssessmentRunOptions> = {
    '--corpus': 'corpus',
    '--batch': 'batch',
    '--split': 'split',
    '--architecture': 'architecture',
    '--model': 'model',
    '--max-attempts': 'maxAttempts',
    '--max-phase-attempts': 'maxPhaseAttempts',
    '--max-tokens': 'maxTokens',
    '--max-total-tokens': 'maxTotalTokens',
    '--timeout-ms': 'timeoutMs',
    '--phase-id': 'phaseId',
    '--cases': 'caseIds',
    '--max-turns': 'maxTurns',
    '--editor-limit': 'editorLimit',
    '--inter-call-delay-ms': 'interCallDelayMs',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--live') {
      o.live = true;
      continue;
    }
    if (args[i] === '--dry-run') {
      o.live = false;
      continue;
    }
    if (args[i] === '--disable-interpreter-cache') {
      o.disableInterpreterCache = true;
      continue;
    }
    if (args[i] === '--no-fail-fast') {
      o.noFailFast = true;
      continue;
    }
    const field = names[args[i]],
      value = args[++i];
    if (!field || !value || value.startsWith('--'))
      throw Error('ASSESSMENT_ARGUMENT_INVALID');
    Object.assign(o, {
      [field]: [
        'maxAttempts',
        'maxPhaseAttempts',
        'maxTokens',
        'maxTotalTokens',
        'timeoutMs',
        'maxTurns',
        'editorLimit',
        'interCallDelayMs',
      ].includes(field)
        ? Number(value)
        : value,
    });
  }
  const attemptCeiling =
    o.batch === 'pilot' ? 29 : o.batch === 'full' ? 176 : 280;
  if (
    !['v4', 'regression80', 'release60'].includes(o.corpus) ||
    !['pilot', 'full', 'release'].includes(o.batch) ||
    !['development', 'validation', 'holdout', 'all'].includes(o.split) ||
    !['combined', 'split'].includes(o.architecture) ||
    (o.batch === 'pilot' && o.split !== 'development') ||
    !Number.isSafeInteger(o.maxAttempts) ||
    o.maxAttempts < 1 ||
    o.maxAttempts > attemptCeiling ||
    (o.maxPhaseAttempts !== undefined &&
      (!Number.isSafeInteger(o.maxPhaseAttempts) ||
        o.maxPhaseAttempts < o.maxAttempts ||
        o.maxPhaseAttempts > attemptCeiling)) ||
    !Number.isSafeInteger(o.maxTokens) ||
    o.maxTokens < 128 ||
    o.maxTokens > 8192 ||
    !Number.isSafeInteger(o.maxTotalTokens) ||
    o.maxTotalTokens < 500 ||
    o.maxTotalTokens > 4_000_000 ||
    !Number.isSafeInteger(o.timeoutMs) ||
    o.timeoutMs < 1000 ||
    o.timeoutMs > 90000 ||
    (o.maxTurns !== undefined &&
      (!Number.isSafeInteger(o.maxTurns) ||
        o.maxTurns < 1 ||
        o.maxTurns > 3)) ||
    (o.editorLimit !== undefined &&
      (!Number.isSafeInteger(o.editorLimit) ||
        o.editorLimit < 0 ||
        o.editorLimit > 80)) ||
    (o.interCallDelayMs !== undefined &&
      (!Number.isSafeInteger(o.interCallDelayMs) ||
        o.interCallDelayMs < 0 ||
        o.interCallDelayMs > 5000)) ||
    (o.model !== undefined && !/^[\w.-]+\/[\w.:-]+$/.test(o.model))
  )
    throw Error('ASSESSMENT_ARGUMENT_LIMIT');
  if (o.phaseId !== undefined && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(o.phaseId))
    throw Error('ASSESSMENT_PHASE_ID_INVALID');
  if (o.live && !o.model) throw Error('ASSESSMENT_MODEL_REQUIRED');
  return o;
}

type Dependencies = {
  readCorpus?: () => AssessmentCorpus;
  readCredentials?: () => Promise<{
    apiKey: string;
    formattingRecovery?: boolean;
  }>;
  fetcher?: typeof fetch;
  writeReport?: boolean;
};

const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const delay = (ms: number) =>
  ms > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

const safeCode = (e: unknown): string => {
  if (e instanceof AssessmentPipelineError) return e.code;
  if (e instanceof XkiroError) {
    const status =
      typeof e.status === 'number' &&
      Number.isInteger(e.status) &&
      e.status >= 100 &&
      e.status <= 599
        ? `_${e.status}`
        : '';
    return `XKIRO_${e.code}${status}`;
  }
  if (e instanceof AgentValidationError) return `REWRITE_${e.code}`;
  const v = e instanceof Error ? e.message : '';
  if (v === 'Assessment output is invalid.') return 'ASSESSMENT_SCHEMA_INVALID';
  return /^[A-Z][A-Z_]{1,70}$/.test(v)
    ? v
    : 'ASSESSMENT_PROVIDER_OR_PROTOCOL_FAILURE';
};

export async function runAssessmentEvaluation(
  args: readonly string[],
  dependencies: Dependencies = {},
) {
  const options = parseAssessmentRunOptions(args),
    defaultCorpusLoader =
      options.corpus === 'release60'
        ? loadRelease60Corpus
        : options.corpus === 'regression80'
          ? loadRegression80Corpus
          : loadAssessmentCorpus,
    corpus = (dependencies.readCorpus ?? defaultCorpusLoader)();
  const eligible = corpus.scenarios.filter((c) =>
    options.batch === 'pilot'
      ? c.pilot
      : options.split === 'all' || c.split === options.split,
  );
  const ids = options.caseIds?.split(',');
  if (
    ids &&
    (new Set(ids).size !== ids.length ||
      ids.some((id) => !eligible.some((c) => c.id === id)))
  )
    throw Error('ASSESSMENT_CASE_SELECTION_INVALID');
  const scenarios = ids
    ? ids.map((id) => eligible.find((c) => c.id === id)!)
    : eligible;
  const effectiveTurnCount = (turnsLen: number) =>
    options.maxTurns !== undefined
      ? Math.min(turnsLen, options.maxTurns)
      : turnsLen;
  const scriptedTurns = scenarios.reduce(
    (n, c) => n + effectiveTurnCount(c.turns.length),
    0,
  );
  const analyses =
    options.architecture === 'combined'
      ? scriptedTurns
      : options.disableInterpreterCache
        ? scriptedTurns * 2
        : scenarios.length + scriptedTurns;
  const plannedEditors =
    options.editorLimit !== undefined
      ? Math.min(scenarios.length, options.editorLimit)
      : scenarios.length;
  const ceiling = {
    scenarios: scenarios.length,
    analysisCalls: analyses,
    editorCalls: plannedEditors,
    logicalCalls: analyses + plannedEditors,
    httpAttempts: analyses + plannedEditors,
    retries: 0,
  };
  const activePromptVersion =
    options.architecture === 'split'
      ? SPLIT_ASSESSMENT_PROMPT_VERSION
      : ASSESSMENT_PROMPT_VERSION;
  const firstMessages =
    options.architecture === 'split'
      ? buildTaskInterpreterMessages({ sources: scenarios[0].sources })
      : buildAssessmentMessages({
          sources: scenarios[0].sources,
          purpose: scenarios[0].purpose,
          previous: null,
          answers: [],
        });
  const base = {
    mode: options.live ? 'live' : 'dry-run',
    classification: 'synthetic-only',
    architecture: options.architecture,
    corpusVersion: corpus.version,
    corpusHash: fingerprint(corpus),
    ceiling,
    semanticAcceptance: 'NOT_ESTABLISHED',
    limits: {
      maxHttpAttempts: options.maxAttempts,
      maxOutputTokensPerCall: options.maxTokens,
      maxAccountedTokenReservation: options.maxTotalTokens,
    },
    promptVersion: activePromptVersion,
    systemPromptHash: fingerprint(firstMessages[0]),
    promptTemplateHash: fingerprint(firstMessages.slice(0, -1)),
  };
  if (!options.live) return { ...base, rows: [] as AssessmentEvaluationRow[] };
  if (!dependencies.fetcher && !options.phaseId)
    throw Error('ASSESSMENT_PHASE_ID_REQUIRED');
  const phaseCeiling =
    options.maxPhaseAttempts ??
    (options.batch === 'pilot'
      ? 29
      : options.batch === 'full'
        ? 176
        : options.maxAttempts);
  const phase = options.phaseId
    ? new AssessmentPhaseBudget(
        resolve(
          process.cwd(),
          '.worknote-agent-evals',
          options.phaseId + '.budget.json',
        ),
        phaseCeiling,
        options.maxTotalTokens,
      )
    : undefined;
  const readCredentials =
    dependencies.readCredentials ??
    (async () => {
      const env = parseEnv(
        await readFile(resolve(process.cwd(), '.env'), 'utf8'),
      );
      return {
        apiKey: env.XKIRO_API_KEY,
        formattingRecovery: env.WORKNOTE_AGENT_FORMATTING_RECOVERY === 'true',
      };
    });
  const credentials = await readCredentials();
  if (!credentials.apiKey?.trim())
    throw Error('ASSESSMENT_CREDENTIALS_UNAVAILABLE');
  const budget = new AssessmentAttemptBudget(
    options.maxAttempts,
    options.maxTotalTokens,
    dependencies.fetcher,
    phase,
  );
  const client = new WorkNoteXkiroClient(
    {
      apiKey: credentials.apiKey,
      model: options.model!,
      ...ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
    },
    budget.fetch,
  );
  const editorClient = new WorkNoteXkiroClient(
    {
      apiKey: credentials.apiKey,
      model: options.model!,
      ...ASSESSMENT_EDITOR_PROVIDER_POLICY,
    },
    budget.fetch,
  );
  const completeMessage = async (
    messages: Parameters<typeof client.complete>[0],
    role: 'analysis' | 'interpreter' | 'assessor' | 'editor',
  ) => {
    if (options.interCallDelayMs && budget.snapshot().actualHttpAttempts > 0) {
      await delay(options.interCallDelayMs);
    }
    if (role === 'editor') {
      return editorClient.complete(
        messages,
        `assessment-editor-${randomUUID()}`,
      );
    }
    return client.complete(messages, `assessment-${role}-${randomUUID()}`);
  };

  const rows: AssessmentEvaluationRow[] = [];
  let stop = false,
    consecutiveErrors = 0,
    editorRuns = 0;
  const maxEditorRuns =
    options.editorLimit !== undefined ? options.editorLimit : scenarios.length;

  for (const c of scenarios) {
    if (stop) {
      rows.push({ caseId: c.id, turn: 1, skipped: true });
      continue;
    }
    const extracted = extractSnapshotsFromSources(c.sources, {
      revision: 1,
      stepDoneByIndex: c.stepDoneByIndex,
    });
    const taskContext = extracted.taskContext;
    const taskContextVersion = extracted.taskContextVersion;
    let noteSnapshot = extracted.note;
    let sourceOverrides = structuredClone(c.sources);
    const currentTaskHash = computeAssessmentTaskHash({
      taskContext,
      taskContextVersion,
      taskContextInvalid: false,
    });
    const sourcesBuilder = (answers: AssessmentModelInput['answers']) =>
      buildAssessmentSources({
        taskContext,
        taskContextVersion,
        taskContextInvalid: false,
        note: noteSnapshot,
        answers,
        sourceOverrides,
      });
    const interpreterCache = options.disableInterpreterCache
      ? undefined
      : new Map<string, TaskInterpreterOutput>();

    let input: AssessmentModelInput = prepareInitialAssessmentInput({
      purpose: c.purpose,
      sourcesBuilder,
    });
    let output: AssessmentModelOutput | null = null;
    let activeAssessment: AssessmentView | null = null;
    const turnLimit = effectiveTurnCount(c.turns.length);

    for (let i = 0; i < turnLimit; i++) {
      const turn = c.turns[i];
      const started = Date.now();
      let rawSyntheticResponse: string | undefined;
      let requestTemplateHash: string | undefined;
      const stageRawResponses: string[] = [];
      try {
        if (turn.noteReplacement) {
          noteSnapshot = {
            ...noteSnapshot,
            revision: noteSnapshot.revision + 1,
            contentMarkdown: turn.noteReplacement,
          };
          sourceOverrides = sourceOverrides.map((s) =>
            s.id === 'note.body'
              ? {
                  ...s,
                  text: turn.noteReplacement!,
                  version: `note-${i + 1}`,
                }
              : s,
          );
          input = prepareInitialAssessmentInput({
            purpose: input.purpose,
            sourcesBuilder,
          });
          activeAssessment = null;
        } else if (i === 0) {
          input = prepareInitialAssessmentInput({
            purpose: c.purpose,
            sourcesBuilder,
          });
        } else if (
          turn.action === 'answer' ||
          turn.action === 'unknown' ||
          turn.action === 'skip'
        ) {
          if (!activeAssessment?.nextQuestion)
            throw Error('SCRIPTED_QUESTION_NOT_PRODUCED');
          const disposition =
            turn.action === 'answer'
              ? 'answered'
              : turn.action === 'unknown'
                ? 'unknown'
                : 'skipped';
          input = prepareReplyAssessmentInput({
            current: activeAssessment,
            questionId: activeAssessment.nextQuestion.id,
            gapId: activeAssessment.nextQuestion.gapId,
            disposition,
            answer: turn.answer,
            answerId: `answer-${i}`,
            sourcesBuilder,
          });
        } else if (turn.action === 'correct') {
          const targetId =
            activeAssessment?.claims[0]?.id ?? activeAssessment?.gaps[0]?.id;
          if (!activeAssessment || !targetId)
            throw Error('SCRIPTED_CORRECTION_TARGET_MISSING');
          input = prepareCorrectionAssessmentInput({
            current: activeAssessment,
            targetClaimOrGapId: targetId,
            correctionText: turn.correctionText!,
            answerId: `correction-${i}`,
            sourcesBuilder,
          });
        } else if (turn.action === 'reset') {
          if (!activeAssessment) throw Error('SCRIPTED_RESET_MISSING_PRIOR');
          const carryAnswerIds = turn.carryAnswered
            ? activeAssessment.answers
                .filter((a) => a.disposition === 'answered')
                .map((a) => a.id)
            : [];
          input = prepareResetAssessmentInput({
            current: activeAssessment,
            currentTaskContextHash: currentTaskHash,
            newPurpose: turn.newPurpose!,
            carryAnswerIds,
            sourcesBuilder,
          });
        }

        validateAssessmentRequestBudget(input, options.architecture);
        const executed = await executeAssessmentModelCall({
          input,
          architecture: options.architecture,
          formattingRecovery: credentials.formattingRecovery === true,
          modelName: options.model!,
          complete: completeMessage,
          interpreterCache,
          onStageProgress: (stage) => {
            requestTemplateHash = stage.requestTemplateHash;
            if (stage.rawResponse !== undefined) {
              const sanitized = stage.rawResponse
                .split(credentials.apiKey)
                .join('[REDACTED]');
              stageRawResponses.push(sanitized);
              rawSyntheticResponse =
                options.architecture === 'split'
                  ? JSON.stringify(stageRawResponses)
                  : sanitized;
            }
          },
        });
        const parsedOutput = executed.result;
        output = parsedOutput;
        const grade = gradeAssessment(c, i, parsedOutput, input);
        activeAssessment = finalizeAssessmentTurn({
          input,
          modelResult: parsedOutput,
          sourceRevision: noteSnapshot.revision,
          taskContextHash: currentTaskHash,
          modelName: 'evaluation/synthetic',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          provenance: executed.provenance,
        });
        const runtimeGrade = gradeAssessment(
          c,
          i,
          {
            ...parsedOutput,
            noteAdequacy: activeAssessment.noteAdequacy,
            nextQuestion: activeAssessment.nextQuestion
              ? parsedOutput.nextQuestion
              : null,
          },
          input,
          activeAssessment,
        );
        rows.push({
          caseId: c.id,
          turn: i + 1,
          role: 'analysis',
          rawSyntheticResponse,
          requestTemplateHash,
          formattingRecovery: executed.provenance.formattingRecovery,
          runtimeState: {
            state: activeAssessment.state,
            noteAdequacy: activeAssessment.noteAdequacy,
            counters: activeAssessment.counters,
          },
          output: parsedOutput,
          grade,
          runtimeGrade,
          sources: structuredClone(input.sources),
          answers: structuredClone(input.answers),
          elapsedMs: Date.now() - started,
        });
        consecutiveErrors = 0;
        if (
          !options.noFailFast &&
          c.critical &&
          (!grade.automatedPass || !runtimeGrade.automatedPass)
        ) {
          stop = true;
          break;
        }
      } catch (e) {
        const errorCode = budget.denialCode ?? safeCode(e);
        if (
          turn.expected.boundaryError &&
          errorCode === 'CONTEXT_UNAVAILABLE'
        ) {
          rows.push({
            caseId: c.id,
            turn: i + 1,
            role: 'analysis',
            boundaryDenied: true,
            errorCode,
            elapsedMs: Date.now() - started,
          });
          output = null;
          activeAssessment = null;
          break;
        }
        rows.push({
          caseId: c.id,
          turn: i + 1,
          role: 'analysis',
          errorCode,
          elapsedMs: Date.now() - started,
          requestTemplateHash,
          ...(rawSyntheticResponse ? { rawSyntheticResponse } : {}),
          sources: structuredClone(input.sources),
          answers: structuredClone(input.answers),
        });
        consecutiveErrors++;
        if (
          /BUDGET/.test(errorCode) ||
          consecutiveErrors >= 3 ||
          (!options.noFailFast && c.critical)
        )
          stop = true;
        output = null;
        activeAssessment = null;
        break;
      }
    }

    if (
      !stop &&
      output &&
      editorRuns < maxEditorRuns &&
      isEligibleForAutomatedEditorEvaluation(activeAssessment)
    ) {
      editorRuns++;
      let rawEditorResponse: string | undefined;
      const editorStarted = Date.now();
      try {
        const executedEditor = await executeAssessmentEditorCall({
          note: noteSnapshot,
          taskContext,
          assessment: activeAssessment,
          formattingRecovery: credentials.formattingRecovery === true,
          modelName: options.model!,
          complete: completeMessage,
          onRawResponse: (raw) => {
            rawEditorResponse = raw
              .split(credentials.apiKey)
              .join('[REDACTED]');
          },
        });
        rows.push({
          caseId: c.id,
          turn: turnLimit,
          role: 'editor',
          elapsedMs: Date.now() - editorStarted,
          editorOutput: executedEditor.result,
          editorValidation: {
            runtimeProposalAccepted: true,
            formattingRecovery: executedEditor.formattingRecovery,
          },
          sources: structuredClone(input.sources),
          answers: structuredClone(input.answers),
        });
        consecutiveErrors = 0;
      } catch (e) {
        const code = budget.denialCode ?? safeCode(e);
        rows.push({
          caseId: c.id,
          turn: turnLimit,
          role: 'editor',
          elapsedMs: Date.now() - editorStarted,
          ...(rawEditorResponse
            ? { rawSyntheticResponse: rawEditorResponse }
            : {}),
          sources: structuredClone(input.sources),
          answers: structuredClone(input.answers),
          errorCode: code,
        });
        consecutiveErrors++;
        if (
          /BUDGET/.test(code) ||
          consecutiveErrors >= 3 ||
          (!options.noFailFast && c.critical)
        )
          stop = true;
      }
    }
  }
  const report = {
    ...base,
    model: options.model,
    promptVersion: activePromptVersion,
    createdAt: new Date().toISOString(),
    promptTemplateSelection: 'PER_PURPOSE_MAX4_EXAMPLES',
    promptTemplateHashScope: 'FIRST_SELECTED_SCENARIO_INITIAL_TURN',
    budget: budget.snapshot(),
    phaseId: options.phaseId ?? null,
    ...(phase ? { phaseBudget: phase.snapshot() } : {}),
    rows,
    manualReview: 'required',
    runtimeCoverage:
      'SHARED_REQUEST_PARSER_STATE_AND_PROPOSAL_GUARDS_NOT_IAM_API_E2E',
    editorInstructionVersion: ASSESSMENT_EDITOR_INSTRUCTION_VERSION,
    editorSystemPromptHash: fingerprint(ASSESSMENT_EDITOR_SYSTEM_PROMPT),
    providerConfiguration: {
      analysis: {
        ...ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
        maxTokens: options.maxTokens,
        timeoutMs: options.timeoutMs,
      },
      editor: {
        ...ASSESSMENT_EDITOR_PROVIDER_POLICY,
        formattingRecovery: credentials.formattingRecovery === true,
      },
    },
  };
  if (dependencies.writeReport !== false) {
    const directory = resolve(process.cwd(), '.worknote-agent-evals');
    await mkdir(directory, { recursive: true });
    const filename = `assessment-v4-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const sanitize = (value: unknown) =>
      JSON.stringify(value, null, 2)
        .split(credentials.apiKey)
        .join('[REDACTED]') + '\n';
    await writeFile(resolve(directory, `${filename}.json`), sanitize(report), {
      flag: 'wx',
    });
    await writeFile(
      resolve(directory, `${filename}.review.json`),
      sanitize(makeAssessmentWorksheet(rows, corpus)),
      { flag: 'wx' },
    );
  }
  return report;
}

if (require.main === module) {
  runAssessmentEvaluation(process.argv.slice(2))
    .then((report) =>
      console.log(
        JSON.stringify({
          mode: report.mode,
          architecture: report.architecture,
          classification: report.classification,
          ceiling: report.ceiling,
          limits: report.limits,
          corpusHash: report.corpusHash,
          promptVersion: report.promptVersion,
          systemPromptHash: report.systemPromptHash,
          promptTemplateHash: report.promptTemplateHash,
          semanticAcceptance: report.semanticAcceptance,
          ...('budget' in report ? { budget: report.budget } : {}),
          ...('phaseBudget' in report
            ? { phaseBudget: report.phaseBudget }
            : {}),
          rows: report.rows.map((r) => ({
            caseId: r.caseId,
            turn: r.turn,
            role: r.role,
            errorCode: r.errorCode,
            skipped: r.skipped,
            grade: r.grade,
            runtimeGrade: r.runtimeGrade,
          })),
        }),
      ),
    )
    .catch(() => {
      console.error('ASSESSMENT_EVALUATION_FAILED');
      process.exitCode = 1;
    });
}
