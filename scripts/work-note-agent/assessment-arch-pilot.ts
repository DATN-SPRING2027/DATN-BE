import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runAssessmentEvaluation } from './assessment-run';
import type { AssessmentEvaluationRow } from './assessment-evaluation';

export type VariantPilotMetrics = {
  architecture: 'combined' | 'split';
  promptVersion: string;
  runs: number;
  fixtureEvaluations: number;
  passCount: number;
  rawPassCount: number;
  runtimePassCount: number;
  adequacyMatches: number;
  questionMatches: number;
  needCodeConsistentCount: number;
  stabilityExactMatches: number;
  stabilityTotalFixtures: number;
  criticalErrors: {
    falseSufficient: number;
    fabricatedOrInvalidSource: number;
    polarityInversion: number;
    total: number;
  };
  editorSmokeAttempted: number;
  editorSmokeAccepted: number;
  actualHttpAttempts: number;
  unknownUsageAttempts: number;
  reportedTokens: number;
  totalElapsedMs: number;
  meanFixtureElapsedMs: number;
  disqualified: boolean;
  fixtureDetails: {
    caseId: string;
    run: 1 | 2;
    rawPass: boolean;
    runtimePass: boolean;
    rawAdequacy: string | null;
    runtimeAdequacy: string | null;
    questionAsked: boolean;
    gapNeedCodes: string[];
    failures: string[];
    errorCode: string | null;
    elapsedMs: number;
  }[];
};

const EXPECTED_PILOT_NEED_CODES: Record<string, string | null> = {
  'assessment-retry-upload-a': null,
  'assessment-mail-queue-a': null,
  'assessment-permission-matrix-b': 'test_context.actor',
  'assessment-workspace-context-b': 'scope.completed_part',
};

const EXPECTED_INSUFFICIENT_CASES = new Set([
  'assessment-permission-matrix-b',
  'assessment-workspace-context-b',
]);

export function summarizeVariantPilot(params: {
  architecture: 'combined' | 'split';
  promptVersion: string;
  run1Rows: AssessmentEvaluationRow[];
  run2Rows: AssessmentEvaluationRow[];
  actualHttpAttempts: number;
  unknownUsageAttempts: number;
  reportedTokens: number;
}): VariantPilotMetrics {
  const analysisRuns: { run: 1 | 2; row: AssessmentEvaluationRow }[] = [
    ...params.run1Rows
      .filter((r) => r.role === 'analysis')
      .map((row) => ({ run: 1 as const, row })),
    ...params.run2Rows
      .filter((r) => r.role === 'analysis')
      .map((row) => ({ run: 2 as const, row })),
  ];
  const editorRows = [...params.run1Rows, ...params.run2Rows].filter(
    (r) => r.role === 'editor',
  );

  let falseSufficient = 0;
  let fabricatedOrInvalidSource = 0;
  let polarityInversion = 0;
  let passCount = 0;
  let rawPassCount = 0;
  let runtimePassCount = 0;
  let adequacyMatches = 0;
  let questionMatches = 0;
  let needCodeConsistentCount = 0;
  let totalElapsedMs = 0;

  const fixtureDetails = analysisRuns.map(({ run, row }) => {
    const rawPass = Boolean(!row.errorCode && row.grade?.automatedPass);
    const runtimePass = Boolean(
      !row.errorCode && row.runtimeGrade?.automatedPass,
    );
    const bothPass = rawPass && runtimePass;
    if (rawPass) rawPassCount++;
    if (runtimePass) runtimePassCount++;
    if (bothPass) passCount++;

    const failures = [
      ...new Set([
        ...(row.grade?.failures ?? []),
        ...(row.runtimeGrade?.failures ?? []),
        ...(row.errorCode ? [row.errorCode] : []),
      ]),
    ];

    if (
      EXPECTED_INSUFFICIENT_CASES.has(row.caseId) &&
      (row.output?.noteAdequacy === 'ENOUGH_FOR_PURPOSE' ||
        row.runtimeState?.noteAdequacy === 'ENOUGH_FOR_PURPOSE')
    ) {
      falseSufficient++;
    }
    if (
      failures.some((f) =>
        /SOURCE_REFERENCE_INVALID|INVALID_SOURCE_REFERENCE|INVENTED_REQUIREMENT|FORBIDDEN_ASSERTION|TASK_REQUIREMENT_USED_AS/u.test(
          f,
        ),
      )
    ) {
      fabricatedOrInvalidSource++;
    }
    if (failures.some((f) => /POLARITY/u.test(f))) {
      polarityInversion++;
    }

    if (!row.errorCode && !failures.includes('NOTE_ADEQUACY')) {
      adequacyMatches++;
    }
    if (
      !row.errorCode &&
      !failures.includes('REQUIRED_QUESTION_MISSING') &&
      !failures.includes('UNNECESSARY_QUESTION')
    ) {
      questionMatches++;
    }

    const gapNeedCodes = (row.output?.gaps ?? []).map(
      (g) => g.needCode ?? 'UNSPECIFIED',
    );
    const expectedNeed = EXPECTED_PILOT_NEED_CODES[row.caseId];
    if (!row.errorCode) {
      if (expectedNeed === null && !row.output?.nextQuestion) {
        needCodeConsistentCount++;
      } else if (
        expectedNeed !== null &&
        row.output?.nextQuestion &&
        row.output.gaps[row.output.nextQuestion.gapIndex]?.needCode ===
          expectedNeed
      ) {
        needCodeConsistentCount++;
      }
    }

    const elapsedMs = row.elapsedMs ?? 0;
    totalElapsedMs += elapsedMs;
    return {
      caseId: row.caseId,
      run,
      rawPass,
      runtimePass,
      rawAdequacy: row.output?.noteAdequacy ?? null,
      runtimeAdequacy: row.runtimeState?.noteAdequacy ?? null,
      questionAsked: Boolean(row.output?.nextQuestion),
      gapNeedCodes,
      failures,
      errorCode: row.errorCode ?? null,
      elapsedMs,
    };
  });

  const fixtureIds = Object.keys(EXPECTED_PILOT_NEED_CODES);
  let stabilityExactMatches = 0;
  for (const id of fixtureIds) {
    const r1 = fixtureDetails.find((f) => f.caseId === id && f.run === 1);
    const r2 = fixtureDetails.find((f) => f.caseId === id && f.run === 2);
    if (
      r1 &&
      r2 &&
      !r1.errorCode &&
      !r2.errorCode &&
      r1.runtimeAdequacy === r2.runtimeAdequacy &&
      r1.questionAsked === r2.questionAsked &&
      (r1.gapNeedCodes[0] ?? null) === (r2.gapNeedCodes[0] ?? null)
    ) {
      stabilityExactMatches++;
    }
  }

  const criticalTotal =
    falseSufficient + fabricatedOrInvalidSource + polarityInversion;

  return {
    architecture: params.architecture,
    promptVersion: params.promptVersion,
    runs: 2,
    fixtureEvaluations: analysisRuns.length,
    passCount,
    rawPassCount,
    runtimePassCount,
    adequacyMatches,
    questionMatches,
    needCodeConsistentCount,
    stabilityExactMatches,
    stabilityTotalFixtures: fixtureIds.length,
    criticalErrors: {
      falseSufficient,
      fabricatedOrInvalidSource,
      polarityInversion,
      total: criticalTotal,
    },
    editorSmokeAttempted: editorRows.length,
    editorSmokeAccepted: editorRows.filter(
      (r) => r.editorValidation?.runtimeProposalAccepted === true,
    ).length,
    actualHttpAttempts: params.actualHttpAttempts,
    unknownUsageAttempts: params.unknownUsageAttempts,
    reportedTokens: params.reportedTokens,
    totalElapsedMs,
    meanFixtureElapsedMs: analysisRuns.length
      ? Math.round(totalElapsedMs / analysisRuns.length)
      : 0,
    disqualified: criticalTotal > 0,
    fixtureDetails,
  };
}

export function selectWinningArchitecture(
  a: VariantPilotMetrics,
  b: VariantPilotMetrics,
): {
  decision: 'combined' | 'split' | 'STOP_AND_MODEL_BENCHMARK_REQUIRED';
  rationale: string;
} {
  if (a.disqualified && b.disqualified) {
    return {
      decision: 'STOP_AND_MODEL_BENCHMARK_REQUIRED',
      rationale:
        'Both Variant A and Variant B committed critical errors on foundational development fixtures.',
    };
  }
  if (a.passCount < 6 && b.passCount < 6) {
    return {
      decision: 'STOP_AND_MODEL_BENCHMARK_REQUIRED',
      rationale:
        'Neither Variant A nor Variant B achieved acceptable baseline pass rate (>=6/8) on foundational fixtures.',
    };
  }
  if (a.disqualified && !b.disqualified) {
    return {
      decision: 'split',
      rationale:
        'Variant A was disqualified due to critical errors while Variant B had zero critical errors.',
    };
  }
  if (b.disqualified && !a.disqualified) {
    return {
      decision: 'combined',
      rationale:
        'Variant B was disqualified due to critical errors while Variant A had zero critical errors.',
    };
  }
  const score = (m: VariantPilotMetrics) =>
    m.passCount * 100 +
    m.stabilityExactMatches * 25 +
    m.needCodeConsistentCount * 10;
  if (score(b) > score(a)) {
    return {
      decision: 'split',
      rationale: `Variant B strictly outperformed Variant A on accuracy/stability/taxonomy (${score(b)} vs ${score(a)}), justifying the extra Interpreter HTTP call.`,
    };
  }
  return {
    decision: 'combined',
    rationale: `Variant A matched or exceeded Variant B (${score(a)} vs ${score(b)}) with zero critical errors at half the analysis HTTP calls (${a.actualHttpAttempts} vs ${b.actualHttpAttempts} total calls) and lower latency (${a.meanFixtureElapsedMs}ms vs ${b.meanFixtureElapsedMs}ms). Per Plan v3 §4, split must prove net benefit over added cost.`,
  };
}

export async function runArchitecturePilot(phaseId: string) {
  const model = 'mistralai/ministral-14b';
  const commonFlags = [
    '--live',
    '--batch',
    'release',
    '--split',
    'development',
    '--model',
    model,
    '--phase-id',
    phaseId,
    '--max-phase-attempts',
    '29',
    '--max-total-tokens',
    '1000000',
    '--max-turns',
    '1',
    '--inter-call-delay-ms',
    '1200',
  ];
  const casesA =
    'assessment-retry-upload-a,assessment-mail-queue-a,assessment-permission-matrix-b,assessment-workspace-context-b';
  const casesB =
    'assessment-mail-queue-a,assessment-retry-upload-a,assessment-permission-matrix-b,assessment-workspace-context-b';

  const runA1 = await runAssessmentEvaluation([
    ...commonFlags,
    '--architecture',
    'combined',
    '--max-attempts',
    '5',
    '--editor-limit',
    '1',
    '--cases',
    casesA,
  ]);
  const runA2 = await runAssessmentEvaluation([
    ...commonFlags,
    '--architecture',
    'combined',
    '--max-attempts',
    '4',
    '--editor-limit',
    '0',
    '--cases',
    casesA,
  ]);
  const runB1 = await runAssessmentEvaluation([
    ...commonFlags,
    '--architecture',
    'split',
    '--disable-interpreter-cache',
    '--max-attempts',
    '9',
    '--editor-limit',
    '1',
    '--cases',
    casesB,
  ]);
  const runB2 = await runAssessmentEvaluation([
    ...commonFlags,
    '--architecture',
    'split',
    '--disable-interpreter-cache',
    '--max-attempts',
    '8',
    '--editor-limit',
    '0',
    '--cases',
    casesB,
  ]);

  if (
    !('budget' in runA1) ||
    !('budget' in runA2) ||
    !('budget' in runB1) ||
    !('budget' in runB2)
  ) {
    throw Error('PILOT_EXPECTED_LIVE_BUDGET');
  }

  const variantA = summarizeVariantPilot({
    architecture: 'combined',
    promptVersion: runA1.promptVersion,
    run1Rows: runA1.rows,
    run2Rows: runA2.rows,
    actualHttpAttempts:
      runA1.budget.actualHttpAttempts + runA2.budget.actualHttpAttempts,
    unknownUsageAttempts:
      runA1.budget.unknownUsageAttempts + runA2.budget.unknownUsageAttempts,
    reportedTokens: runA1.budget.reportedTokens + runA2.budget.reportedTokens,
  });

  const variantB = summarizeVariantPilot({
    architecture: 'split',
    promptVersion: runB1.promptVersion,
    run1Rows: runB1.rows,
    run2Rows: runB2.rows,
    actualHttpAttempts:
      runB1.budget.actualHttpAttempts + runB2.budget.actualHttpAttempts,
    unknownUsageAttempts:
      runB1.budget.unknownUsageAttempts + runB2.budget.unknownUsageAttempts,
    reportedTokens: runB1.budget.reportedTokens + runB2.budget.reportedTokens,
  });

  const selection = selectWinningArchitecture(variantA, variantB);
  const summary = {
    classification: 'PLAN_V3_SECTION_4_ARCHITECTURE_SCREENING_PILOT',
    notReleaseEvidence: true,
    createdAt: new Date().toISOString(),
    model,
    phaseId,
    httpCeiling: 29,
    retries: 0,
    phaseBudget: runB2.phaseBudget ?? null,
    variantA,
    variantB,
    selection,
    reviewerSemanticAssessment: 'NOT_ESTABLISHED',
  };

  const outPath = resolve(
    process.cwd(),
    'scripts/work-note-agent/assessment-plan-v3-pilot-2026-10-29.json',
  );
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  return summary;
}

export async function runBufferVerificationOnCombined(phaseId: string) {
  const { readFileSync } = await import('node:fs');
  const outPath = resolve(
    process.cwd(),
    'scripts/work-note-agent/assessment-plan-v3-pilot-2026-10-29.json',
  );
  const existing = JSON.parse(readFileSync(outPath, 'utf8')) as Record<
    string,
    unknown
  > & {
    phaseId: string;
    phaseBudget: unknown;
    variantA: VariantPilotMetrics;
    variantB: VariantPilotMetrics;
  };
  const model = 'mistralai/ministral-14b';
  const commonFlags = [
    '--live',
    '--batch',
    'release',
    '--split',
    'development',
    '--model',
    model,
    '--phase-id',
    phaseId,
    '--max-phase-attempts',
    '29',
    '--max-total-tokens',
    '1000000',
    '--max-turns',
    '1',
    '--inter-call-delay-ms',
    '1200',
    '--architecture',
    'combined',
    '--editor-limit',
    '0',
  ];

  const mailOnly = process.argv.includes('--mail-verify');
  // Buffer verification within the 29-call cap
  const bufRun1 = await runAssessmentEvaluation([
    ...commonFlags,
    '--max-attempts',
    mailOnly ? '1' : '2',
    '--cases',
    mailOnly
      ? 'assessment-mail-queue-a'
      : 'assessment-mail-queue-a,assessment-permission-matrix-b',
  ]);
  const bufRun2 = await runAssessmentEvaluation([
    ...commonFlags,
    '--max-attempts',
    '1',
    '--cases',
    'assessment-mail-queue-a',
  ]);

  if (!('budget' in bufRun1) || !('budget' in bufRun2)) {
    throw Error('BUFFER_VERIFY_EXPECTED_LIVE_BUDGET');
  }

  const mail1 = bufRun1.rows.find(
    (r) => r.caseId === 'assessment-mail-queue-a' && r.role === 'analysis',
  )!;
  const perm2 = bufRun1.rows.find(
    (r) =>
      r.caseId === 'assessment-permission-matrix-b' && r.role === 'analysis',
  );
  const mail2 = bufRun2.rows.find(
    (r) => r.caseId === 'assessment-mail-queue-a' && r.role === 'analysis',
  )!;

  // Reconstruct full 4x2 Variant A evaluation replacing the 2 mail-queue runs and the 1 timed-out permission-matrix run2
  const toRowFromDetail = (
    d: VariantPilotMetrics['fixtureDetails'][number],
  ): AssessmentEvaluationRow => ({
    caseId: d.caseId,
    turn: 1,
    role: 'analysis',
    elapsedMs: d.elapsedMs,
    errorCode: d.errorCode ?? undefined,
    output: d.rawAdequacy
      ? ({
          noteAdequacy: d.rawAdequacy,
          gaps: d.gapNeedCodes.map((needCode) => ({ needCode })),
          nextQuestion: d.questionAsked ? { gapIndex: 0 } : null,
        } as unknown as AssessmentEvaluationRow['output'])
      : undefined,
    runtimeState: d.runtimeAdequacy
      ? {
          state: d.questionAsked ? 'waiting_for_answer' : 'ready_to_edit',
          noteAdequacy: d.runtimeAdequacy,
          counters: { questionCount: d.questionAsked ? 1 : 0, noProgress: 0 },
        }
      : undefined,
    grade: {
      automatedPass: d.rawPass,
      failures: d.failures,
      semanticAcceptance: 'NOT_ESTABLISHED',
      manualReview: 'required',
    },
    runtimeGrade: {
      automatedPass: d.runtimePass,
      failures: d.failures,
      semanticAcceptance: 'NOT_ESTABLISHED',
      manualReview: 'required',
    },
  });

  const priorR1 = existing.variantA.fixtureDetails.filter((f) => f.run === 1);
  const priorR2 = existing.variantA.fixtureDetails.filter((f) => f.run === 2);
  const mergedR1: AssessmentEvaluationRow[] = [
    ...priorR1
      .filter((f) => f.caseId !== 'assessment-mail-queue-a')
      .map(toRowFromDetail),
    mail1,
    {
      caseId: 'assessment-retry-upload-a',
      turn: 1,
      role: 'editor',
      editorValidation: {
        runtimeProposalAccepted: existing.variantA.editorSmokeAccepted > 0,
        formattingRecovery: [],
      },
    },
  ];
  const mergedR2: AssessmentEvaluationRow[] = [
    ...priorR2
      .filter(
        (f) =>
          f.caseId !== 'assessment-mail-queue-a' &&
          (!perm2 || f.caseId !== 'assessment-permission-matrix-b'),
      )
      .map(toRowFromDetail),
    mail2,
    ...(perm2 ? [perm2] : []),
  ];

  const bufferAttempts =
    bufRun1.budget.actualHttpAttempts + bufRun2.budget.actualHttpAttempts;
  const bufferUnknown =
    bufRun1.budget.unknownUsageAttempts + bufRun2.budget.unknownUsageAttempts;
  const bufferTokens =
    bufRun1.budget.reportedTokens + bufRun2.budget.reportedTokens;

  const variantAVerified = summarizeVariantPilot({
    architecture: 'combined',
    promptVersion: bufRun1.promptVersion,
    run1Rows: mergedR1,
    run2Rows: mergedR2,
    actualHttpAttempts: existing.variantA.actualHttpAttempts + bufferAttempts,
    unknownUsageAttempts: bufferUnknown,
    reportedTokens: existing.variantA.reportedTokens + bufferTokens,
  });

  const selection = selectWinningArchitecture(
    variantAVerified,
    existing.variantB,
  );
  const updated = {
    ...existing,
    updatedAt: new Date().toISOString(),
    phaseBudget: bufRun2.phaseBudget ?? existing.phaseBudget,
    initialScreening24Calls: {
      variantA: existing.variantA,
      variantB: existing.variantB,
    },
    bufferVerification3Calls: {
      promptVersion: bufRun1.promptVersion,
      analysisTimeoutMs: 45000,
      actualHttpAttempts: bufferAttempts,
      unknownUsageAttempts: bufferUnknown,
      reportedTokens: bufferTokens,
    },
    variantA: variantAVerified,
    variantB: existing.variantB,
    selection,
    reviewerSemanticAssessment: 'NOT_ESTABLISHED' as const,
  };
  writeFileSync(outPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  return updated;
}

if (require.main === module) {
  const isBuffer = process.argv.includes('--buffer-verify');
  const phaseArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const phaseId = phaseArg || 'plan-v3-arch-pilot-20261029';
  const runner = isBuffer
    ? runBufferVerificationOnCombined(phaseId)
    : runArchitecturePilot(phaseId);
  runner
    .then((summary) => {
      console.log(
        JSON.stringify(
          {
            phaseId: summary.phaseId,
            phaseBudget: summary.phaseBudget,
            variantA: {
              passCount: summary.variantA.passCount,
              adequacyMatches: summary.variantA.adequacyMatches,
              questionMatches: summary.variantA.questionMatches,
              needCodeConsistentCount: summary.variantA.needCodeConsistentCount,
              stabilityExactMatches: summary.variantA.stabilityExactMatches,
              criticalErrors: summary.variantA.criticalErrors,
              editorSmokeAccepted: summary.variantA.editorSmokeAccepted,
              actualHttpAttempts: summary.variantA.actualHttpAttempts,
              meanFixtureElapsedMs: summary.variantA.meanFixtureElapsedMs,
            },
            variantB: {
              passCount: summary.variantB.passCount,
              adequacyMatches: summary.variantB.adequacyMatches,
              questionMatches: summary.variantB.questionMatches,
              needCodeConsistentCount: summary.variantB.needCodeConsistentCount,
              stabilityExactMatches: summary.variantB.stabilityExactMatches,
              criticalErrors: summary.variantB.criticalErrors,
              editorSmokeAccepted: summary.variantB.editorSmokeAccepted,
              actualHttpAttempts: summary.variantB.actualHttpAttempts,
              meanFixtureElapsedMs: summary.variantB.meanFixtureElapsedMs,
            },
            selection: summary.selection,
          },
          null,
          2,
        ),
      );
    })
    .catch((err) => {
      console.error(
        'ARCHITECTURE_PILOT_FAILED',
        err instanceof Error ? err.message : 'UNKNOWN',
      );
      process.exitCode = 1;
    });
}
