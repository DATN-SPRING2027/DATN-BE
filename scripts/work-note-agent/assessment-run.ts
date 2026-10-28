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
import {
  AgentValidationError,
  prepareAgentRequest,
  parseAgentResult,
} from '../../src/services/capture/application/work-note-agent/work-note-agent';
import {
  buildAssessmentMessages,
  parseAssessmentOutput,
  assertAssessmentFidelity,
  ASSESSMENT_PROMPT_VERSION,
} from '../../src/services/capture/application/work-note-agent/work-note-assessment.protocol';
import {
  loadAssessmentCorpus,
  gradeAssessment,
  makeAssessmentWorksheet,
  type AssessmentEvaluationRow,
} from './assessment-evaluation';

export class AssessmentAttemptBudget {
  private actualHttpAttempts = 0;
  private reportedTokens = 0;
  private unknownUsageAttempts = 0;
  private chargedTokens = 0;
  denialCode: 'HTTP_ATTEMPT_BUDGET' | 'TOKEN_RESERVATION_BUDGET' | null = null;
  readonly fetch: typeof fetch;
  constructor(
    private readonly maxAttempts: number,
    private readonly maxAccountedTokens: number,
    fetcher: typeof fetch = fetch,
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
      this.actualHttpAttempts++;
      this.chargedTokens += reservation;
      let response: Response;
      try {
        response = await fetcher(url, init);
      } catch {
        this.unknownUsageAttempts++;
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
};
export function parseAssessmentRunOptions(
  args: readonly string[],
): AssessmentRunOptions {
  const o: AssessmentRunOptions = {
    live: false,
    batch: 'pilot',
    split: 'development',
    maxAttempts: 29,
    maxTokens: 4096,
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
  if (o.live && !o.model) throw Error('ASSESSMENT_MODEL_REQUIRED');
  return o;
}

type Dependencies = {
  readCredentials?: () => Promise<{ apiKey: string }>;
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

// This is a synthetic model-protocol transcript adapter, not an IAM/API/E2E fixture.
// Production state-machine behavior remains covered by the application tests.
function evaluationView(
  input: AssessmentModelInput,
  output: AssessmentModelOutput,
  turn: number,
): AssessmentView {
  const now = new Date().toISOString();
  const gaps = output.gaps.map((g) => ({
    ...g,
    id: fingerprint([g.kind, g.target]).slice(0, 24),
    status: 'open' as const,
  }));
  return {
    schemaVersion: 'task-note-assessment/v1',
    id: 'synthetic-assessment',
    revision: turn,
    sourceRevision: 1,
    taskContextHash: fingerprint(
      input.sources.filter((s) => s.kind === 'TASK'),
    ),
    answerLedgerHash: fingerprint(input.answers),
    purpose: output.purpose,
    state: output.nextQuestion
      ? 'waiting_for_answer'
      : output.noteAdequacy === 'ENOUGH_FOR_PURPOSE'
        ? 'ready_to_edit'
        : 'missing_context',
    contextManifest: {
      acquisitionStatus: 'LOADED',
      sources: input.sources,
      sourceCatalogVersion: '1',
    },
    taskUnderstanding: {
      ...output.taskUnderstanding,
      requirements: output.taskUnderstanding.requirements.map((r, i) => ({
        ...r,
        id: `requirement-${i}`,
      })),
    },
    claims: output.claims.map((c, i) => ({
      ...c,
      id: `claim-${i}`,
      verificationStatus: 'NOT_INDEPENDENTLY_VERIFIED',
    })),
    coverage: output.coverage.map((c) => ({
      requirementId: `requirement-${c.requirementIndex}`,
      status: c.status,
      sourceRefs: c.sourceRefs,
    })),
    gaps,
    nextQuestion: output.nextQuestion
      ? {
          id: `question-${turn}`,
          gapId: gaps[output.nextQuestion.gapIndex]?.id ?? '',
          text: output.nextQuestion.text,
          reason: output.nextQuestion.reason,
          options: output.nextQuestion.options,
        }
      : null,
    taskContextStatus: output.taskContextStatus,
    noteAdequacy: output.noteAdequacy,
    counters: { questionCount: turn, noProgress: 0 },
    allowedActions: [],
    answers: input.answers,
    authorValidated: false,
    reviewerSemanticAssessment: 'NOT_ESTABLISHED',
    signals: {
      proposalApplied: false,
      authorValidated: false,
      saved: false,
      reviewerSemanticAssessment: 'NOT_ESTABLISHED',
    },
    createdAt: now,
    expiresAt: now,
    trace: [],
    promptVersion: 'evaluation-protocol-adapter',
    model: 'evaluation/synthetic',
  };
}

export async function runAssessmentEvaluation(
  args: readonly string[],
  dependencies: Dependencies = {},
) {
  const options = parseAssessmentRunOptions(args),
    corpus = loadAssessmentCorpus();
  const scenarios = corpus.scenarios.filter((c) =>
    options.batch === 'pilot'
      ? c.pilot
      : options.split === 'all' || c.split === options.split,
  );
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
        sources: corpus.scenarios[0].sources,
        purpose: corpus.scenarios[0].purpose,
        previous: null,
        answers: [],
      })[0],
    ),
  };
  if (!options.live) return { ...base, rows: [] as AssessmentEvaluationRow[] };
  const readCredentials =
    dependencies.readCredentials ??
    (async () => ({
      apiKey: parseEnv(await readFile(resolve(process.cwd(), '.env'), 'utf8'))
        .XKIRO_API_KEY,
    }));
  const credentials = await readCredentials();
  if (!credentials.apiKey?.trim())
    throw Error('ASSESSMENT_CREDENTIALS_UNAVAILABLE');
  const budget = new AssessmentAttemptBudget(
    options.maxAttempts,
    options.maxTotalTokens,
    dependencies.fetcher,
  );
  const client = new WorkNoteXkiroClient(
    {
      apiKey: credentials.apiKey,
      model: options.model!,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
      retries: 0,
      jsonMode: true,
      temperature: 0.1,
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
    for (let i = 0; i < c.turns.length; i++) {
      const turn = c.turns[i];
      const started = Date.now();
      let rawSyntheticResponse: string | undefined;
      try {
        if (turn.noteReplacement)
          input.sources = input.sources.map((s) =>
            s.id === 'note.body'
              ? { ...s, text: turn.noteReplacement!, version: `note-${i + 1}` }
              : s,
          );
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
          gap.status = disposition;
          if (turn.answer)
            input.sources.push({
              id: `answer.${i}`,
              kind: 'ANSWER',
              label: 'Synthetic author clarification',
              text: turn.answer,
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
          input.sources.push({
            id: `answer.correction.${i}`,
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
        const completion = await client.complete(
          messages,
          `assessment-${randomUUID()}`,
        );
        rawSyntheticResponse = completion.content
          .split(credentials.apiKey)
          .join('[REDACTED]');
        const parsedOutput = parseAssessmentOutput(input, completion.content);
        output = parsedOutput;
        const grade = gradeAssessment(c, i, parsedOutput, input);
        rows.push({
          caseId: c.id,
          turn: i + 1,
          role: 'analysis',
          output: parsedOutput,
          grade,
          sources: structuredClone(input.sources),
          answers: structuredClone(input.answers),
          elapsedMs: Date.now() - started,
        });
        consecutiveErrors = 0;
        if (c.critical && !grade.automatedPass) {
          stop = true;
          break;
        }
        input.previous = evaluationView(input, parsedOutput, i + 1);
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
      !output.nextQuestion
    ) {
      try {
        const text = (id: string) =>
          input.sources.find((s) => s.id === id)?.text ?? '';
        const prepared = prepareAgentRequest({
          operation: 'restructure',
          scope: 'whole_note',
          instruction: `Biên tập rõ ràng bằng dữ kiện tác giả cung cấp cho mục đích ${output.purpose}; giữ điều chưa biết, không xác nhận Task hoàn thành.`,
          workflow: 'TASK_NOTE',
          draft: {
            revision: 1,
            title: text('note.title'),
            body: text('note.body'),
          },
          task: {
            title: text('task.title'),
            description: text('task.description') || null,
            status: text('task.status'),
            steps: input.sources
              .filter((s) => s.id.startsWith('task.step.'))
              .map((s) => ({ text: s.text, done: false })),
          },
          history: [],
          clarifications: [
            ...input.answers.map((a) => ({
              id: a.id,
              question: a.target,
              state:
                a.disposition === 'answered'
                  ? ('answered' as const)
                  : ('skipped' as const),
              ...(a.answer ? { answer: a.answer } : {}),
            })),
            ...(input.correction
              ? [
                  {
                    id: 'synthetic-correction',
                    question: 'Author correction of earlier text',
                    state: 'answered' as const,
                    answer: input.correction.text,
                  },
                ]
              : []),
          ],
        });
        const completion = await client.complete(
          prepared.messages,
          `assessment-editor-${randomUUID()}`,
        );
        const editorOutput = parseAgentResult(prepared, completion.content);
        if (editorOutput.suggestion?.replacementText)
          assertAssessmentFidelity(
            text('note.body'),
            editorOutput.suggestion.replacementText,
          );
        rows.push({
          caseId: c.id,
          turn: c.turns.length,
          role: 'editor',
          editorOutput,
          sources: structuredClone(input.sources),
          answers: structuredClone(input.answers),
        });
      } catch (e) {
        const code = budget.denialCode ?? safeCode(e);
        rows.push({
          caseId: c.id,
          turn: c.turns.length,
          role: 'editor',
          errorCode: code,
        });
        if (/BUDGET/.test(code)) stop = true;
      }
    }
  }
  const report = {
    ...base,
    model: options.model,
    promptVersion: ASSESSMENT_PROMPT_VERSION,
    createdAt: new Date().toISOString(),
    budget: budget.snapshot(),
    rows,
    manualReview: 'required',
    runtimeCoverage: 'SYNTHETIC_MODEL_PROTOCOL_NOT_APPLICATION_E2E',
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
      sanitize(makeAssessmentWorksheet(rows)),
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
          semanticAcceptance: report.semanticAcceptance,
          ...('budget' in report ? { budget: report.budget } : {}),
          rows: report.rows.map((r) => ({
            caseId: r.caseId,
            turn: r.turn,
            role: r.role,
            errorCode: r.errorCode,
            skipped: r.skipped,
            grade: r.grade,
          })),
        }),
      ),
    )
    .catch(() => {
      console.error('ASSESSMENT_EVALUATION_FAILED');
      process.exitCode = 1;
    });
}
