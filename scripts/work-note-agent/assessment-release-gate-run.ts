import { evaluationArtifactFiles } from './assessment-artifact';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ASSESSMENT_PROMPT_VERSION } from '../../src/services/capture/application/work-note-agent/work-note-assessment.protocol';
import { ASSESSMENT_EDITOR_INSTRUCTION_VERSION } from '../../src/services/capture/application/work-note-agent/work-note-assessment-editor';
import {
  loadRelease60Corpus,
  loadRelease60V7Corpus,
  type AssessmentEvaluationRow,
} from './assessment-evaluation';
import {
  computeAssessmentQualityGate,
  makeBlindedReviewPack,
  RESUMABLE_TRANSPORT_ERROR_CODES,
} from './assessment-quality-gate';
import { runAssessmentEvaluation } from './assessment-run';

export type ReleaseCorpusVariant = 'v5' | 'v6' | 'v7';

const FROZEN_BASE_FILES = [
  'src/services/capture/application/work-note-agent/work-note-assessment.prompt.ts',
  'src/services/capture/application/work-note-agent/work-note-assessment.protocol.ts',
  'src/services/capture/application/work-note-agent/work-note-assessment.state.ts',
  'src/services/capture/application/work-note-agent/work-note-assessment.rubric.ts',
  'src/services/capture/application/work-note-agent/work-note-assessment.polarity.ts',
  'src/services/capture/application/work-note-agent/work-note-assessment.context.ts',
  'src/services/capture/application/work-note-agent/work-note-assessment-split.ts',
  'src/services/capture/application/work-note-agent/work-note-assessment-editor.ts',
  'src/services/capture/application/work-note-agent/work-note-assessment.pipeline.ts',
  'src/services/capture/application/work-note-agent/work-note-agent.ts',
  'src/services/capture/application/work-note-agent/work-note-agent.prompt.ts',
  'src/services/capture/application/work-note-agent/work-note-agent.protection.ts',
  'src/services/capture/application/work-note-agent/work-note-agent.completion.ts',
  'src/services/capture/application/work-note-agent/security/agent-input.masking.ts',
  'src/services/capture/application/work-note-agent/security/llm-security-gateway.ts',
  'src/services/capture/application/work-note-agent/security/output-security.validator.ts',
  'src/services/capture/application/work-note-agent/security/security.types.ts',
  'src/services/capture/application/work-note-agent/security/sensitive-data.detector.ts',
  'src/services/capture/application/work-note-agent/security/sensitive-data.masker.ts',
  'src/services/capture/application/work-note-agent/security/sensitive-data.rules.ts',
  'scripts/work-note-agent/assessment-quality-gate.ts',
] as const;

export function getFrozenFiles(
  corpusVariant: ReleaseCorpusVariant = 'v5',
  rootDir = process.cwd(),
): readonly string[] {
  const corpusRelPath =
    corpusVariant === 'v7'
      ? 'scripts/work-note-agent/cases-assessment-v7-release.json'
      : corpusVariant === 'v6'
        ? 'scripts/work-note-agent/cases-assessment-v6-release.json'
        : 'scripts/work-note-agent/cases-assessment-v5-release.json';
  return [
    ...new Set([
      ...FROZEN_BASE_FILES,
      ...evaluationArtifactFiles(rootDir),
      corpusRelPath,
    ]),
  ].sort();
}

export function buildFreezeManifest(
  rootDir = process.cwd(),
  corpusVariant: ReleaseCorpusVariant = 'v5',
) {
  const fileHashes: Record<string, string> = {};
  for (const relPath of getFrozenFiles(corpusVariant, rootDir)) {
    const normalized = readFileSync(resolve(rootDir, relPath), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    fileHashes[relPath] = createHash('sha256').update(normalized).digest('hex');
  }
  const payload = {
    model: 'mistralai/ministral-14b',
    architecture: 'combined' as const,
    promptVersion: ASSESSMENT_PROMPT_VERSION,
    editorInstructionVersion: ASSESSMENT_EDITOR_INSTRUCTION_VERSION,
    corpusVariant,
    retries: 0,
    fileHashes,
  };
  const manifestHash = createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
  return {
    ...payload,
    manifestHash,
  };
}

export function partitionResumableStageScenarios(
  scenarioIds: readonly string[],
  existingRows: readonly AssessmentEvaluationRow[],
  expectedTurnCounts?: ReadonlyMap<string, number>,
): {
  completedRowsByCase: Map<string, AssessmentEvaluationRow[]>;
  remainingCaseIds: string[];
} {
  const byCase = new Map<string, AssessmentEvaluationRow[]>();
  for (const row of existingRows) {
    const list = byCase.get(row.caseId) ?? [];
    list.push(row);
    byCase.set(row.caseId, list);
  }
  const completedRowsByCase = new Map<string, AssessmentEvaluationRow[]>();
  const remainingCaseIds: string[] = [];
  for (const id of scenarioIds) {
    const rows = byCase.get(id);
    const analysis = rows?.filter((r) => r.role === 'analysis') ?? [];
    const turns = new Set(analysis.map((r) => r.turn));
    if (expectedTurnCounts && turns.size !== analysis.length)
      throw Error('DUPLICATE_ANALYSIS_TURN');
    const expected = expectedTurnCounts?.get(id);
    const terminalFailure = analysis.some(
      (r) => r.errorCode && !RESUMABLE_TRANSPORT_ERROR_CODES.has(r.errorCode),
    );
    const incomplete =
      expected !== undefined &&
      !terminalFailure &&
      (turns.size !== expected ||
        [...turns].some((turn) => turn < 1 || turn > expected));
    if (
      !rows ||
      rows.length === 0 ||
      incomplete ||
      rows.some(
        (r) =>
          r.skipped === true ||
          (typeof r.errorCode === 'string' &&
            RESUMABLE_TRANSPORT_ERROR_CODES.has(r.errorCode)),
      )
    ) {
      remainingCaseIds.push(id);
    } else {
      completedRowsByCase.set(id, rows);
    }
  }
  return { completedRowsByCase, remainingCaseIds };
}

export function mergeResumedStageRows(
  scenarioIds: readonly string[],
  completedRowsByCase: ReadonlyMap<string, readonly AssessmentEvaluationRow[]>,
  freshRows: readonly AssessmentEvaluationRow[],
): AssessmentEvaluationRow[] {
  const freshByCase = new Map<string, AssessmentEvaluationRow[]>();
  for (const row of freshRows) {
    const list = freshByCase.get(row.caseId) ?? [];
    list.push(row);
    freshByCase.set(row.caseId, list);
  }
  const merged: AssessmentEvaluationRow[] = [];
  for (const id of scenarioIds) {
    const kept = completedRowsByCase.get(id);
    if (kept) {
      merged.push(...kept);
    } else {
      const next = freshByCase.get(id);
      if (next) merged.push(...next);
    }
  }
  return merged;
}

export async function runReleaseGateStage(
  stage: 'freeze' | 'validation' | 'holdout',
  phaseId = 'plan-v3-release60-20261029',
  onlyCaseIds?: readonly string[],
  corpusVariant: ReleaseCorpusVariant = 'v5',
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/u.test(phaseId))
    throw Error('RELEASE_PHASE_ID_INVALID');
  const rootDir = process.cwd();
  const evalDir = resolve(rootDir, '.worknote-agent-evals');
  mkdirSync(evalDir, { recursive: true });

  const manifestPath = resolve(evalDir, `${phaseId}.freeze-manifest.json`);
  const valRowsPath = resolve(evalDir, `${phaseId}.validation-rows.json`);
  const holdRowsPath = resolve(evalDir, `${phaseId}.holdout-rows.json`);
  const summaryOutPath =
    phaseId === 'plan-v3-release60-20261029'
      ? resolve(
          rootDir,
          'scripts/work-note-agent/assessment-plan-v3-release-gate-2026-10-29.json',
        )
      : resolve(
          rootDir,
          `scripts/work-note-agent/assessment-${phaseId}-release-gate.json`,
        );

  const currentManifest = buildFreezeManifest(rootDir, corpusVariant);

  if (stage === 'freeze') {
    if (existsSync(manifestPath))
      throw Error('IMMUTABLE_FREEZE_ALREADY_EXISTS');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          frozenAt: new Date().toISOString(),
          ...currentManifest,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    return { stage, manifestPath, manifest: currentManifest };
  }

  if (!existsSync(manifestPath)) {
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          frozenAt: new Date().toISOString(),
          ...currentManifest,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  } else {
    const locked = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      manifestHash: string;
    };
    if (locked.manifestHash !== currentManifest.manifestHash) {
      throw Error(
        `FREEZE_MANIFEST_DRIFT_DETECTED: locked=${locked.manifestHash} current=${currentManifest.manifestHash}`,
      );
    }
  }

  const corpusPath =
    corpusVariant === 'v6'
      ? resolve(
          rootDir,
          'scripts/work-note-agent/cases-assessment-v6-release.json',
        )
      : undefined;
  const corpus =
    corpusVariant === 'v7'
      ? loadRelease60V7Corpus()
      : loadRelease60Corpus(corpusPath);
  const expectedTurnCounts = new Map(
    corpus.scenarios.map((c) => [c.id, c.turns.length]),
  );
  if (stage === 'holdout') {
    if (!existsSync(valRowsPath))
      throw Error('HOLDOUT_REQUIRES_VALIDATION_PASS');
    const saved = JSON.parse(readFileSync(valRowsPath, 'utf8')) as {
      manifestHash: string;
      rows: AssessmentEvaluationRow[];
    };
    if (
      saved.manifestHash !== currentManifest.manifestHash ||
      !computeAssessmentQualityGate(
        saved.rows,
        {
          ...corpus,
          scenarios: corpus.scenarios.filter((s) => s.split === 'validation'),
        },
        { strictRelease: true },
      ).automatedGatePassed
    )
      throw Error('HOLDOUT_REQUIRES_VALIDATION_PASS');
  }
  const stageScenarios = corpus.scenarios.filter((s) => s.split === stage);
  const stageScenarioIds = stageScenarios.map((s) => s.id);
  const stageCorpus = {
    ...corpus,
    scenarios: stageScenarios,
  };
  const targetRowsPath = stage === 'validation' ? valRowsPath : holdRowsPath;

  let existingRows: AssessmentEvaluationRow[] = [];
  let latestBudget: Record<string, unknown> | null = null;
  let latestPhaseBudget: Record<string, unknown> | null = null;
  if (existsSync(targetRowsPath)) {
    const priorSaved = JSON.parse(readFileSync(targetRowsPath, 'utf8')) as {
      manifestHash: string;
      budget?: Record<string, unknown>;
      phaseBudget?: Record<string, unknown> | null;
      rows: AssessmentEvaluationRow[];
    };
    if (priorSaved.manifestHash !== currentManifest.manifestHash) {
      throw Error(
        `STAGE_CHECKPOINT_MANIFEST_MISMATCH: saved=${priorSaved.manifestHash} current=${currentManifest.manifestHash}`,
      );
    }
    existingRows = priorSaved.rows ?? [];
    latestBudget = priorSaved.budget ?? null;
    latestPhaseBudget = priorSaved.phaseBudget ?? null;
  }

  const { completedRowsByCase, remainingCaseIds } =
    partitionResumableStageScenarios(
      stageScenarioIds,
      existingRows,
      expectedTurnCounts,
    );
  const targetCaseIds =
    onlyCaseIds && onlyCaseIds.length > 0
      ? remainingCaseIds.filter((id) => onlyCaseIds.includes(id))
      : remainingCaseIds;

  let mergedRows = existingRows;
  if (targetCaseIds.length > 0) {
    const splitMaxAttempts = stage === 'validation' ? 50 : 98;
    const corpusArg =
      corpusVariant === 'v7'
        ? 'release60-v7'
        : corpusVariant === 'v6'
          ? 'release60-v6'
          : 'release60';
    const result = await runAssessmentEvaluation([
      '--live',
      '--corpus',
      corpusArg,
      '--batch',
      'release',
      '--split',
      stage,
      '--cases',
      targetCaseIds.join(','),
      '--architecture',
      'combined',
      '--model',
      'mistralai/ministral-14b',
      '--phase-id',
      phaseId,
      '--max-attempts',
      String(splitMaxAttempts),
      '--max-phase-attempts',
      '148',
      '--max-total-tokens',
      '3000000',
      '--inter-call-delay-ms',
      '3500',
      '--no-fail-fast',
    ]);

    if (!('budget' in result)) {
      throw Error('EXPECTED_LIVE_EVALUATION_RESULT');
    }
    latestBudget = result.budget;
    latestPhaseBudget =
      (result.phaseBudget as unknown as Record<string, unknown> | undefined) ??
      null;
    mergedRows = mergeResumedStageRows(
      stageScenarioIds,
      completedRowsByCase,
      result.rows,
    );
  }

  const postPartition = partitionResumableStageScenarios(
    stageScenarioIds,
    mergedRows,
    expectedTurnCounts,
  );
  const stageGate = computeAssessmentQualityGate(mergedRows, stageCorpus, {
    remainingCaseIds: postPartition.remainingCaseIds,
    strictRelease: true,
  });

  writeFileSync(
    targetRowsPath,
    JSON.stringify(
      {
        stage,
        completedAt: new Date().toISOString(),
        manifestHash: currentManifest.manifestHash,
        completedScenarios: postPartition.completedRowsByCase.size,
        totalScenarios: stageScenarioIds.length,
        remainingCaseIds: postPartition.remainingCaseIds,
        budget: latestBudget,
        phaseBudget: latestPhaseBudget,
        editorAttemptedCount: mergedRows.filter(
          (r) => r.role === 'editor' && !r.skipped,
        ).length,
        editorAcceptedCount: mergedRows.filter(
          (r) =>
            r.role === 'editor' &&
            r.editorValidation?.runtimeProposalAccepted === true,
        ).length,
        gate: stageGate,
        rows: mergedRows,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  // If both validation and holdout have been 100% completed under the exact same manifestHash,
  // assemble the complete 60-case release report + blinded review pack.
  if (existsSync(valRowsPath) && existsSync(holdRowsPath)) {
    const valSaved = JSON.parse(readFileSync(valRowsPath, 'utf8')) as {
      manifestHash: string;
      remainingCaseIds?: string[];
      budget: Record<string, unknown>;
      editorAttemptedCount: number;
      editorAcceptedCount: number;
      gate: ReturnType<typeof computeAssessmentQualityGate>;
      rows: AssessmentEvaluationRow[];
    };
    const holdSaved = JSON.parse(readFileSync(holdRowsPath, 'utf8')) as {
      manifestHash: string;
      remainingCaseIds?: string[];
      budget: Record<string, unknown>;
      phaseBudget: Record<string, unknown> | null;
      editorAttemptedCount: number;
      editorAcceptedCount: number;
      gate: ReturnType<typeof computeAssessmentQualityGate>;
      rows: AssessmentEvaluationRow[];
    };
    if (
      valSaved.manifestHash !== currentManifest.manifestHash ||
      holdSaved.manifestHash !== currentManifest.manifestHash
    ) {
      throw Error('VALIDATION_HOLDOUT_MANIFEST_MISMATCH');
    }
    const valCheck = partitionResumableStageScenarios(
      corpus.scenarios.filter((s) => s.split === 'validation').map((s) => s.id),
      valSaved.rows,
      expectedTurnCounts,
    );
    const holdCheck = partitionResumableStageScenarios(
      corpus.scenarios.filter((s) => s.split === 'holdout').map((s) => s.id),
      holdSaved.rows,
      expectedTurnCounts,
    );
    if (
      valCheck.remainingCaseIds.length === 0 &&
      holdCheck.remainingCaseIds.length === 0
    ) {
      const allRows = [...valSaved.rows, ...holdSaved.rows];
      const combinedGate = computeAssessmentQualityGate(allRows, corpus, {
        strictRelease: true,
      });

      const blindedPack = makeBlindedReviewPack(
        [
          {
            variantLabel: `combined-${currentManifest.promptVersion}`,
            reportId: phaseId,
            rows: allRows,
          },
        ],
        corpus,
        `plan-v3-${phaseId}`,
      );
      const worksheetPath = resolve(
        evalDir,
        `${phaseId}.blinded-worksheet.json`,
      );
      const sealedKeyPath = resolve(evalDir, `${phaseId}.sealed-key.json`);
      writeFileSync(
        worksheetPath,
        JSON.stringify(blindedPack.blindedWorksheet, null, 2) + '\n',
        'utf8',
      );
      writeFileSync(
        sealedKeyPath,
        JSON.stringify(blindedPack.sealedKey, null, 2) + '\n',
        'utf8',
      );

      const releaseSummary = {
        classification: 'PLAN_V3_SECTIONS_6_7_FROZEN_RELEASE60_EVALUATION',
        createdAt: new Date().toISOString(),
        phaseId,
        freezeManifest: currentManifest,
        corpusVersion: corpus.version,
        scenarioCounts: {
          total: 60,
          validation: 20,
          holdout: 40,
          analysisTurns: 88,
          editorCeiling: 60,
          httpCeiling: 148,
        },
        phaseBudget: holdSaved.phaseBudget,
        editorSummary: {
          attempted:
            valSaved.editorAttemptedCount + holdSaved.editorAttemptedCount,
          accepted:
            valSaved.editorAcceptedCount + holdSaved.editorAcceptedCount,
        },
        validation20Gate: valSaved.gate,
        holdout40Gate: holdSaved.gate,
        release60Gate: combinedGate,
        blindedReviewArtifacts: {
          worksheetFile: `.worknote-agent-evals/${phaseId}.blinded-worksheet.json`,
          sealedKeyFile: `.worknote-agent-evals/${phaseId}.sealed-key.json`,
          transcriptCount: blindedPack.blindedWorksheet.items.length,
          reviewerSemanticAssessment: 'NOT_ESTABLISHED' as const,
        },
      };
      writeFileSync(
        summaryOutPath,
        JSON.stringify(releaseSummary, null, 2) + '\n',
        'utf8',
      );
      return {
        stage,
        manifestHash: currentManifest.manifestHash,
        completedScenarios: postPartition.completedRowsByCase.size,
        totalScenarios: stageScenarioIds.length,
        remainingCaseIds: postPartition.remainingCaseIds,
        phaseBudget: holdSaved.phaseBudget,
        stageGate,
        release60Gate: combinedGate,
        editorSummary: releaseSummary.editorSummary,
      };
    }
  }

  return {
    stage,
    manifestHash: currentManifest.manifestHash,
    completedScenarios: postPartition.completedRowsByCase.size,
    totalScenarios: stageScenarioIds.length,
    remainingCaseIds: postPartition.remainingCaseIds,
    budget: latestBudget,
    phaseBudget: latestPhaseBudget,
    editorSummary: {
      attempted: mergedRows.filter((r) => r.role === 'editor' && !r.skipped)
        .length,
      accepted: mergedRows.filter(
        (r) =>
          r.role === 'editor' &&
          r.editorValidation?.runtimeProposalAccepted === true,
      ).length,
    },
    stageGate,
  };
}

if (require.main === module) {
  const stageArg = (process.argv[2] ?? 'freeze') as
    'freeze' | 'validation' | 'holdout';
  const phaseIdArg = process.argv[3] ?? 'plan-v3-release60-20261029';
  const casesFlag = process.argv
    .slice(4)
    .find((arg) => arg.startsWith('--cases='));
  const corpusFlag = process.argv
    .slice(4)
    .find((arg) => arg.startsWith('--corpus='));
  const corpusVariant: ReleaseCorpusVariant =
    corpusFlag === '--corpus=v7'
      ? 'v7'
      : corpusFlag === '--corpus=v6'
        ? 'v6'
        : 'v5';
  const onlyCases = casesFlag
    ? casesFlag
        .slice('--cases='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  if (!['freeze', 'validation', 'holdout'].includes(stageArg)) {
    console.error(
      'Usage: assessment-release-gate-run.ts <freeze|validation|holdout> [phaseId] [--cases=id1,id2] [--corpus=v5|v6]',
    );
    process.exit(1);
  }
  runReleaseGateStage(stageArg, phaseIdArg, onlyCases, corpusVariant)
    .then((out) => {
      console.log(JSON.stringify(out, null, 2));
    })
    .catch((err) => {
      console.error(
        'RELEASE_GATE_RUN_FAILED',
        err instanceof Error ? err.message : 'UNKNOWN',
      );
      process.exitCode = 1;
    });
}
