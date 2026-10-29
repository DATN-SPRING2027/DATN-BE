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
  parseAssessmentCompletion,
  ASSESSMENT_PROMPT_VERSION,
} from '../../src/services/capture/application/work-note-agent/work-note-assessment.protocol';
import { assembleAssessment } from '../../src/services/capture/application/work-note-agent/work-note-assessment.state';
import {
  buildAssessmentEditorInput,
  prepareAssessmentEditorRequest,
  ASSESSMENT_EDITOR_SYSTEM_PROMPT,
  assertAssessmentEditorProposal,
  ASSESSMENT_EDITOR_PROVIDER_POLICY,
  ASSESSMENT_EDITOR_INSTRUCTION_VERSION,
  ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
} from '../../src/services/capture/application/work-note-agent/work-note-assessment-editor';
import { parseRewriteCompletion } from '../../src/services/capture/application/work-note-agent/work-note-agent.completion';
import {
  loadAssessmentCorpus,
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
  batch: 'pilot' | 'full';
  split: 'development' | 'validation' | 'holdout' | 'all';
  model?: string;
  maxAttempts: number;
  maxTokens: number;
  maxTotalTokens: number;
  timeoutMs: number;
  phaseId?: string;
  caseIds?: string;
};
export function parseAssessmentRunOptions(
  args: readonly string[],
): AssessmentRunOptions {
  const o: AssessmentRunOptions = {
    live: false,
    batch: 'pilot',
    split: 'development',
    maxAttempts: 29,
    maxTokens: 8192,
    maxTotalTokens: 500000,
    timeoutMs: 30000,
  };
  const names: Record<string, keyof AssessmentRunOptions> = {
    '--batch': 'batch',
    '--split': 'split',
    '--model': 'model',
    '--max-attempts': 'maxAttempts',
    '--max-tokens': 'maxTokens',
    '--max-total-tokens': 'maxTotalTokens',
    '--timeout-ms': 'timeoutMs',
    '--phase-id': 'phaseId',
    '--cases': 'caseIds',
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
    const field = names[args[i]],
      value = args[++i];
    if (!field || !value || value.startsWith('--'))
      throw Error('ASSESSMENT_ARGUMENT_INVALID');
    Object.assign(o, {
      [field]: [
        'maxAttempts',
        'maxTokens',
        'maxTotalTokens',
        'timeoutMs',
      ].includes(field)
        ? Number(value)
        : value,
    });
  }
  if (
    !['pilot', 'full'].includes(o.batch) ||
    !['development', 'validation', 'holdout', 'all'].includes(o.split) ||
    (o.batch === 'pilot' && o.split !== 'development') ||
    !Number.isSafeInteger(o.maxAttempts) ||
    o.maxAttempts < 1 ||
    o.maxAttempts > (o.batch === 'pilot' ? 29 : 176) ||
    !Number.isSafeInteger(o.maxTokens) ||
    o.maxTokens < 128 ||
    o.maxTokens > 8192 ||
    !Number.isSafeInteger(o.maxTotalTokens) ||
    o.maxTotalTokens < 500 ||
    o.maxTotalTokens > 2_000_000 ||
    !Number.isSafeInteger(o.timeoutMs) ||
    o.timeoutMs < 1000 ||
    o.timeoutMs > 30000 ||
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
const safeCode = (e: unknown): string => {
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

// Uses the production state algorithm; this still does not impersonate IAM/API transactions.
function evaluationView(
  input: AssessmentModelInput,
  output: AssessmentModelOutput,
  revision: number,
): AssessmentView {
  return assembleAssessment(input, output, {
    sourceRevision: revision,
    taskContextHash: fingerprint(
      input.sources.filter((s) => s.kind === 'TASK'),
    ),
    model: 'evaluation/synthetic',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
}

export async function runAssessmentEvaluation(
  args: readonly string[],
  dependencies: Dependencies = {},
) {
  const options = parseAssessmentRunOptions(args),
    corpus = (dependencies.readCorpus ?? loadAssessmentCorpus)();
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
  const analyses = scenarios.reduce((n, c) => n + c.turns.length, 0);
  const ceiling = {
    scenarios: scenarios.length,
    analysisCalls: analyses,
    editorCalls: scenarios.length,
    logicalCalls: analyses + scenarios.length,
    httpAttempts: analyses + scenarios.length,
    retries: 0,
  };
  const base = {
    mode: options.live ? 'live' : 'dry-run',
    classification: 'synthetic-only',
    corpusVersion: corpus.version,
    corpusHash: fingerprint(corpus),
    ceiling,
    semanticAcceptance: 'NOT_ESTABLISHED',
    limits: {
      maxHttpAttempts: options.maxAttempts,
      maxOutputTokensPerCall: options.maxTokens,
      maxAccountedTokenReservation: options.maxTotalTokens,
    },
    promptVersion: ASSESSMENT_PROMPT_VERSION,
    systemPromptHash: fingerprint(
      buildAssessmentMessages({
        sources: scenarios[0].sources,
        purpose: scenarios[0].purpose,
        previous: null,
        answers: [],
      })[0],
    ),
    promptTemplateHash: fingerprint(
      buildAssessmentMessages({
        sources: scenarios[0].sources,
        purpose: scenarios[0].purpose,
        previous: null,
        answers: [],
      }).slice(0, -1),
    ),
  };
  if (!options.live) return { ...base, rows: [] as AssessmentEvaluationRow[] };
  if (!dependencies.fetcher && !options.phaseId)
    throw Error('ASSESSMENT_PHASE_ID_REQUIRED');
  const phase = options.phaseId
    ? new AssessmentPhaseBudget(
        resolve(
          process.cwd(),
          '.worknote-agent-evals',
          options.phaseId + '.budget.json',
        ),
        options.batch === 'pilot' ? 29 : 176,
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
  const rows: AssessmentEvaluationRow[] = [];
  let stop = false,
    consecutiveErrors = 0;
  for (const c of scenarios) {
    if (stop) {
      rows.push({ caseId: c.id, turn: 1, skipped: true });
      continue;
    }
    let input: AssessmentModelInput = {
      sources: structuredClone(c.sources),
      purpose: c.purpose,
      previous: null,
      answers: [],
    };
    let output: AssessmentModelOutput | null = null;
    let activeAssessment: AssessmentView | null = null;
    let sourceRevision = 1;
    for (let i = 0; i < c.turns.length; i++) {
      const turn = c.turns[i];
      input = {
        ...input,
        answers: [...input.answers],
        sources: [...input.sources],
      };
      const started = Date.now();
      let rawSyntheticResponse: string | undefined;
      let requestTemplateHash: string | undefined;
      try {
        if (turn.noteReplacement) {
          sourceRevision++;
          input.previous = null;
          input.answers = [];
          input.sources = input.sources
            .filter((s) => s.kind !== 'ANSWER')
            .map((s) =>
              s.id === 'note.body'
                ? {
                    ...s,
                    text: turn.noteReplacement!,
                    version: `note-${i + 1}`,
                  }
                : s,
            );
        }
        if (i > 0 && ['answer', 'unknown', 'skip'].includes(turn.action)) {
          const question = input.previous?.nextQuestion,
            gap = input.previous?.gaps.find((g) => g.id === question?.gapId);
          if (!question || !gap) throw Error('SCRIPTED_QUESTION_NOT_PRODUCED');
          const disposition =
            turn.action === 'answer'
              ? 'answered'
              : turn.action === 'unknown'
                ? 'unknown'
                : 'skipped';
          input.answers.push({
            id: `answer-${i}`,
            gapId: gap.id,
            target: gap.target,
            disposition,
            ...(disposition === 'answered' ? { answer: turn.answer } : {}),
            purpose: input.purpose,
            taskContextHash: input.previous!.taskContextHash,
          });
          input.sources.push({
            id: `answer.answer-${i}`,
            kind: 'ANSWER',
            label: 'Synthetic author clarification',
            text: disposition === 'answered' ? turn.answer! : disposition,
            version: `answer-${i}`,
            loadStatus: 'LOADED',
            includedInRequest: true,
          });
        }
        if (turn.action === 'correct') {
          input.correction = {
            targetId:
              input.previous?.claims[0]?.id ??
              input.previous?.gaps[0]?.id ??
              'synthetic-claim',
            text: turn.correctionText!,
          };
          input.answers.push({
            id: `correction-${i}`,
            gapId: input.correction.targetId,
            target: 'author correction',
            disposition: 'answered',
            answer: turn.correctionText!,
            purpose: input.purpose,
            taskContextHash: fingerprint(
              input.sources.filter((s) => s.kind === 'TASK'),
            ),
          });
          input.sources.push({
            id: `answer.correction-${i}`,
            kind: 'ANSWER',
            label: 'Synthetic author correction',
            text: turn.correctionText!,
            version: `correction-${i}`,
            loadStatus: 'LOADED',
            includedInRequest: true,
          });
        }
        if (turn.action === 'reset') {
          input = {
            ...input,
            purpose: turn.newPurpose!,
            previous: null,
            answers: [],
          };
          input.sources = input.sources.filter((s) => s.kind !== 'ANSWER');
          delete input.correction;
        }
        const messages = buildAssessmentMessages(input);
        requestTemplateHash = fingerprint(messages.slice(0, -1));
        const completion = await client.complete(
          messages,
          `assessment-${randomUUID()}`,
        );
        rawSyntheticResponse = completion.content
          .split(credentials.apiKey)
          .join('[REDACTED]');
        const parsedCompletion = parseAssessmentCompletion(
          input,
          completion.content,
          credentials.formattingRecovery === true,
        );
        const parsedOutput = parsedCompletion.result;
        output = parsedOutput;
        const grade = gradeAssessment(c, i, parsedOutput, input);
        activeAssessment = evaluationView(input, parsedOutput, sourceRevision);
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
          formattingRecovery: parsedCompletion.formattingRecovery,
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
          c.critical &&
          (!grade.automatedPass || !runtimeGrade.automatedPass)
        ) {
          stop = true;
          break;
        }
        input.previous = activeAssessment;
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
        if (/BUDGET/.test(errorCode) || consecutiveErrors >= 3 || c.critical)
          stop = true;
        output = null;
        break;
      }
    }
    if (
      !stop &&
      output?.noteAdequacy === 'ENOUGH_FOR_PURPOSE' &&
      activeAssessment?.allowedActions.includes('rewrite') &&
      !activeAssessment.nextQuestion
    ) {
      let rawEditorResponse: string | undefined;
      const editorStarted = Date.now();
      try {
        const text = (id: string) =>
          input.sources.find((s) => s.id === id)?.text ?? '';
        const editorInput = buildAssessmentEditorInput(
          {
            revision: sourceRevision,
            title: text('note.title'),
            body: text('note.body'),
          },
          {
            title: text('task.title'),
            description: text('task.description') || null,
            status: text('task.status'),
            steps: input.sources
              .filter((s) => s.id.startsWith('task.step.'))
              .map((s) => ({ text: s.text, done: false })),
          },
          activeAssessment,
        );
        const prepared = prepareAssessmentEditorRequest(editorInput);
        const completion = await editorClient.complete(
          prepared.messages,
          `assessment-editor-${randomUUID()}`,
        );
        rawEditorResponse = completion.content
          .split(credentials.apiKey)
          .join('[REDACTED]');
        const parsed = parseRewriteCompletion(
          prepared,
          completion.content,
          credentials.formattingRecovery === true,
        );
        assertAssessmentEditorProposal(editorInput, parsed.result);
        const editorOutput = parsed.result;
        rows.push({
          caseId: c.id,
          turn: c.turns.length,
          role: 'editor',
          elapsedMs: Date.now() - editorStarted,
          editorOutput,
          editorValidation: {
            runtimeProposalAccepted: true,
            formattingRecovery: parsed.formattingRecovery,
          },
          sources: structuredClone(input.sources),
          answers: structuredClone(input.answers),
        });
      } catch (e) {
        const code = budget.denialCode ?? safeCode(e);
        rows.push({
          caseId: c.id,
          turn: c.turns.length,
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
        if (/BUDGET/.test(code) || consecutiveErrors >= 3 || c.critical)
          stop = true;
      }
    }
  }
  const report = {
    ...base,
    model: options.model,
    promptVersion: ASSESSMENT_PROMPT_VERSION,
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
