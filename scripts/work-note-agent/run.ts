import { readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse as parseEnv } from 'dotenv';
import { recoverEmptyContainers } from '../../src/services/capture/application/work-note-agent/work-note-agent.formatting';
import { prepareAgentRequest } from '../../src/services/capture/application/work-note-agent/work-note-agent';
import {
  FEW_SHOTS,
  OPERATION_POLICY,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
} from '../../src/services/capture/application/work-note-agent/work-note-agent.prompt';
import {
  WorkNoteXkiroClient,
  XkiroError,
  type XkiroCompletion,
} from '../../src/services/capture/infrastructure/ai/work-note-xkiro.client';
import {
  gradeCompletion,
  loadCorpus,
  percentile,
  type CaseGrade,
  type EvalSplit,
} from './evaluation';

type Options = {
  live: boolean;
  split: EvalSplit | 'all';
  model?: string;
  limit: number;
  runs: number;
  maxCalls: number;
  concurrency: number;
  maxTokens: number;
  timeoutMs: number;
  reasoning?: string;
  includeOutput: boolean;
  caseIds?: string[];
  corpus: 'baseline' | 'v2' | 'v3';
  recoverEmptyContainers: boolean;
};
export function parseOptions(args: readonly string[]): Options {
  const options: Options = {
    live: false,
    split: 'development',
    limit: 120,
    runs: 1,
    maxCalls: 5,
    concurrency: 1,
    maxTokens: 2048,
    timeoutMs: 30_000,
    includeOutput: false,
    corpus: 'baseline',
    recoverEmptyContainers: false,
  };
  const fields: Record<string, keyof Options> = {
    '--model': 'model',
    '--split': 'split',
    '--limit': 'limit',
    '--runs': 'runs',
    '--max-calls': 'maxCalls',
    '--concurrency': 'concurrency',
    '--max-tokens': 'maxTokens',
    '--timeout-ms': 'timeoutMs',
    '--reasoning': 'reasoning',
    '--case-ids': 'caseIds',
    '--corpus': 'corpus',
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--live') {
      options.live = true;
      continue;
    }
    if (flag === '--dry-run') {
      options.live = false;
      continue;
    }
    if (flag === '--include-output') {
      options.includeOutput = true;
      continue;
    }
    if (flag === '--recover-empty-containers') {
      options.recoverEmptyContainers = true;
      continue;
    }
    const key = fields[flag];
    const value = args[++i];
    if (!key || !value || value.startsWith('--'))
      throw new Error(
        'Invalid evaluation arguments. See scripts/work-note-agent/README.md.',
      );
    if (key === 'caseIds') options.caseIds = value.split(',');
    else if (
      [
        'limit',
        'runs',
        'maxCalls',
        'concurrency',
        'maxTokens',
        'timeoutMs',
      ].includes(key)
    )
      Object.assign(options, { [key]: Number(value) });
    else Object.assign(options, { [key]: value });
  }
  if (
    !['baseline', 'v2', 'v3'].includes(options.corpus) ||
    !['development', 'validation', 'holdout', 'all'].includes(options.split) ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 120 ||
    !Number.isSafeInteger(options.runs) ||
    options.runs < 1 ||
    options.runs > 3 ||
    !Number.isSafeInteger(options.maxCalls) ||
    options.maxCalls < 1 ||
    options.maxCalls > 360 ||
    !Number.isSafeInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > 3 ||
    !Number.isSafeInteger(options.maxTokens) ||
    options.maxTokens < 128 ||
    options.maxTokens > 16_384 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1000 ||
    options.timeoutMs > 90_000 ||
    (options.reasoning &&
      !['none', 'low', 'medium', 'high'].includes(options.reasoning))
  )
    throw new Error('Evaluation arguments exceed their bounded ranges.');
  return options;
}

type Row = {
  caseId: string;
  category: string;
  split: EvalSplit;
  repeat: number;
  errorCode?: string;
  httpStatus?: number | null;
  grade?: Omit<CaseGrade, 'result'>;
  completion?: Omit<XkiroCompletion, 'content'>;
  output?: CaseGrade['result'];
  syntheticResponse?: string;
  elapsedMs?: number;
  skipped?: boolean;
  formattingRecovery?: {
    addedFields: readonly string[];
    grade: Omit<CaseGrade, 'result'>;
    output?: CaseGrade['result'];
  };
};
function summarize(rows: readonly Row[]) {
  const completed = rows.filter((r) => r.grade);
  const latency = rows.flatMap((r) =>
    r.completion ? [r.completion.elapsedMs] : [],
  );
  const accepted = completed.filter((r) => r.grade!.boundaryAccepted).length;
  const passed = completed.filter((r) => r.grade!.automatedPass).length;
  const syntax = completed.filter((r) => r.grade!.syntaxValid).length;
  const groups = Object.fromEntries(
    [...new Set(rows.map((r) => r.category))].map((category) => {
      const subset = rows.filter((r) => r.category === category);
      return [
        category,
        {
          planned: subset.length,
          completed: subset.filter((r) => r.grade).length,
          automatedPass: subset.filter((r) => r.grade?.automatedPass).length,
        },
      ];
    }),
  );
  return {
    planned: rows.length,
    completed: completed.length,
    providerErrors: rows.filter((r) => r.errorCode).length,
    skipped: rows.filter((r) => r.skipped).length,
    syntaxValid: syntax,
    boundaryAccepted: accepted,
    automatedPass: passed,
    formattingRecoveryAttempted: rows.filter((r) => r.formattingRecovery)
      .length,
    boundaryAcceptedAfterFormattingRecovery: rows.filter(
      (r) =>
        r.grade?.boundaryAccepted ||
        r.formattingRecovery?.grade.boundaryAccepted,
    ).length,
    automatedPassAfterFormattingRecovery: rows.filter(
      (r) =>
        r.grade?.automatedPass || r.formattingRecovery?.grade.automatedPass,
    ).length,
    automatedPassRate: completed.length ? passed / completed.length : null,
    successfulLatencyMs: {
      p50: percentile(latency, 0.5),
      p95: percentile(latency, 0.95),
    },
    attemptedLatencyMs: {
      p50: percentile(
        rows.flatMap((r) => (r.elapsedMs === undefined ? [] : [r.elapsedMs])),
        0.5,
      ),
      p95: percentile(
        rows.flatMap((r) => (r.elapsedMs === undefined ? [] : [r.elapsedMs])),
        0.95,
      ),
    },
    tokens: {
      prompt: rows.reduce(
        (sum, r) => sum + (r.completion?.promptTokens ?? 0),
        0,
      ),
      completion: rows.reduce(
        (sum, r) => sum + (r.completion?.completionTokens ?? 0),
        0,
      ),
      unknownUsage: rows.filter(
        (r) =>
          r.errorCode ||
          r.completion?.promptTokens === null ||
          r.completion?.completionTokens === null,
      ).length,
    },
    manualReview: 'required',
    semanticAcceptance: 'NOT_ESTABLISHED',
    groups,
  };
}

export async function run(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  const corpus = loadCorpus(options.corpus);
  const promptTemplateHash = createHash('sha256')
    .update(JSON.stringify({ SYSTEM_PROMPT, OPERATION_POLICY, FEW_SHOTS }))
    .digest('hex');
  const corpusHash = createHash('sha256')
    .update(JSON.stringify(corpus))
    .digest('hex');
  const selected = corpus.cases
    .filter(
      (c) =>
        (options.split === 'all' || c.split === options.split) &&
        (!options.caseIds || options.caseIds.includes(c.id)),
    )
    .slice(0, options.limit);
  if (
    !selected.length ||
    (options.caseIds &&
      options.caseIds.some((id) => !selected.some((c) => c.id === id)))
  )
    throw new Error(
      'No matching cases, or a case ID does not match the split/limit.',
    );
  const jobs = selected.flatMap((c) =>
    Array.from({ length: options.runs }, (_, i) => ({
      testCase: c,
      repeat: i + 1,
    })),
  );
  if (options.live && jobs.length > options.maxCalls)
    throw new Error(
      'Planned calls exceed --max-calls; set an explicit evaluation budget.',
    );
  const prepared = new Map(
    selected.map((c) => [c.id, prepareAgentRequest(c.input)]),
  );
  if (!options.live) {
    console.log(
      JSON.stringify(
        {
          mode: 'dry-run',
          networkCalls: 0,
          promptVersion: PROMPT_VERSION,
          corpusVersion: corpus.version,
          cases: selected.length,
          plannedCalls: jobs.length,
          split: options.split,
          categories: [...new Set(selected.map((c) => c.category))],
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const repoRoot = resolve(__dirname, '../..');
  const localEnv: Record<string, string> = await readFile(
    resolve(repoRoot, '.env'),
    'utf8',
  )
    .then(parseEnv)
    .catch(() => ({}));
  const key = process.env.XKIRO_API_KEY ?? localEnv.XKIRO_API_KEY;
  const model =
    options.model ?? process.env.XKIRO_MODEL ?? localEnv.XKIRO_MODEL;
  if (!key?.trim())
    throw new Error(
      'Set XKIRO_API_KEY in the BE .env or process environment; never pass keys as CLI arguments.',
    );
  if (!model || !/^[\w.-]+\/[\w.:-]+$/.test(model))
    throw new Error('Choose --model vendor/model or set XKIRO_MODEL.');
  // Public metadata only; the credential is never sent on this discovery request.
  const catalogResponse = await fetch('https://api.xkiro.com/v1/models', {
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  if (!catalogResponse.ok)
    throw new Error('Could not read the public xKiro catalog.');
  const catalog = (await catalogResponse.json()) as {
    data?: {
      id: string;
      access_tier?: string;
      pricing?: { input: number; output: number };
      reasoning_efforts?: { levels?: string[] };
    }[];
  };
  const metadata = catalog.data?.find((m) => m.id === model);
  if (!metadata) throw new Error('Chosen model is not in the public catalog.');
  if (
    options.reasoning &&
    options.reasoning !== 'none' &&
    !metadata.reasoning_efforts?.levels?.includes(options.reasoning)
  )
    throw new Error(
      'Requested reasoning level is not declared by this model; select a supported level or omit it.',
    );
  const client = new WorkNoteXkiroClient({
    apiKey: key,
    model,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    retries: 1,
    jsonMode: true,
    ...(options.reasoning
      ? { reasoningEffort: options.reasoning }
      : { temperature: 0.1 }),
  });
  const runId = randomUUID();
  const rows: Row[] = new Array<Row>(jobs.length);
  let cursor = 0;
  let fatal = false;
  let consecutiveProviderErrors = 0;
  async function worker(): Promise<void> {
    while (cursor < jobs.length) {
      const index = cursor++;
      const { testCase, repeat } = jobs[index];
      const row: Row = {
        caseId: testCase.id,
        category: testCase.category,
        split: testCase.split,
        repeat,
      };
      rows[index] = row;
      if (fatal) {
        row.skipped = true;
        continue;
      }
      const trialStarted = Date.now();
      try {
        const request = prepared.get(testCase.id)!;
        // A new opaque body identity per independent trial bypasses response replay;
        // the client serializes once and preserves these exact bytes on retries.
        const completion = await client.complete(
          request.messages,
          `eval-${runId}-${testCase.id}-${repeat}`,
        );
        const { content, ...safeCompletion } = completion;
        row.completion = safeCompletion;
        const { result, ...grade } = gradeCompletion(
          testCase,
          request,
          content,
        );
        row.grade = grade;
        if (!grade.boundaryAccepted && options.recoverEmptyContainers) {
          const recovered = recoverEmptyContainers(content);
          if (recovered) {
            const { result: recoveredResult, ...recoveredGrade } =
              gradeCompletion(testCase, request, recovered.json);
            row.formattingRecovery = {
              addedFields: recovered.addedFields,
              grade: recoveredGrade,
              ...(options.includeOutput ? { output: recoveredResult } : {}),
            };
          }
        }
        if (options.includeOutput) {
          row.output = result;
          row.syntheticResponse = content
            .replaceAll(key, '[REDACTED]')
            .slice(0, 12000);
        }
        consecutiveProviderErrors = 0;
      } catch (error) {
        row.errorCode =
          error instanceof XkiroError ? error.code : 'EVALUATION_ERROR';
        row.httpStatus = error instanceof XkiroError ? error.status : null;
        consecutiveProviderErrors++;
        if (
          [401, 402, 403, 404].includes(row.httpStatus ?? 0) ||
          consecutiveProviderErrors >= 3
        )
          fatal = true;
      }
      row.elapsedMs = Date.now() - trialStarted;
      console.log(
        JSON.stringify({
          completed: index + 1,
          total: jobs.length,
          caseId: testCase.id,
          automatedPass: row.grade?.automatedPass ?? false,
          ...(row.errorCode
            ? { errorCode: row.errorCode, httpStatus: row.httpStatus }
            : {}),
        }),
      );
    }
  }
  await Promise.all(Array.from({ length: options.concurrency }, worker));
  const summary = summarize(rows);
  const estimate = metadata.pricing
    ? (summary.tokens.prompt * metadata.pricing.input) / 1_000_000 +
      (summary.tokens.completion * metadata.pricing.output) / 1_000_000
    : null;
  const report = {
    classification: 'synthetic-only',
    runId,
    createdAt: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    corpusVersion: corpus.version,
    promptTemplateHash,
    corpusHash,
    model,
    catalogSnapshot: metadata,
    configuration: {
      split: options.split,
      cases: selected.length,
      runs: options.runs,
      concurrency: options.concurrency,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
      reasoning: options.reasoning ?? 'not-explicitly-selected',
      jsonModeRequested: true,
      repairCalls: 0,
      formattingRecovery: options.recoverEmptyContainers
        ? 'explicit-empty-containers-only'
        : 'disabled',
    },
    summary,
    listPriceEstimateUsd: estimate,
    costCaveat:
      'Estimate only; cache discounts, failed attempts and provider billing may differ. Unknown usage is reported separately.',
    limitation:
      'Automated rules and boundary checks do not establish semantic correctness, absence of hallucination, or production readiness. Human review required. No real WorkNote or runtime API was used.',
    rows,
  };
  const outDir = resolve(repoRoot, '.worknote-agent-evals');
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(
    outDir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}_${model.replace(/[^\w.-]/g, '_')}_${options.split}_${runId.slice(0, 8)}.json`,
  );
  await writeFile(outPath, JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify(
      { report: outPath, summary, listPriceEstimateUsd: estimate },
      null,
      2,
    ),
  );
  return summary.automatedPass === jobs.length ? 0 : 1;
}

if (require.main === module) {
  void run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // Never emit request bodies, provider errors or configuration objects.
      console.error(
        error instanceof XkiroError
          ? error.code
          : error instanceof Error && !/key|token|secret/i.test(error.message)
            ? error.message
            : 'Evaluation configuration or execution failed. See the README.',
      );
      process.exitCode = 2;
    });
}
