import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createAssessmentCampaign } from './assessment-domains';
import {
  gradeAssessment,
  type AssessmentEvaluationRow,
} from './assessment-evaluation';
import {
  parseAssessmentCompletion,
  assessmentHash,
  ASSESSMENT_PROMPT_VERSION,
} from '../../src/services/capture/application/work-note-agent/work-note-assessment.protocol';
import { assembleAssessment } from '../../src/services/capture/application/work-note-agent/work-note-assessment.state';
import type {
  AssessmentModelInput,
  AssessmentPurpose,
  AssessmentView,
} from '../../src/services/capture/application/work-note-agent/work-note-assessment.types';

/** Counterfactual parser/state replay only. Never calls a model, creates answers,
 * repairs bad quotes or pretends changed prompts produced the saved responses.
 */
export function replayAssessmentEvidence() {
  const directory = resolve(process.cwd(), '.worknote-agent-evals');
  const baselinePath = resolve(
    process.cwd(),
    'scripts/work-note-agent/assessment-cross-domain-results-2026-10-29.json',
  );
  const baselineBytes = readFileSync(baselinePath);
  const baseline = JSON.parse(baselineBytes.toString('utf8')) as {
    artifacts: { reports: { file: string; sha256: string; caseId: string }[] };
    scenarioCounts: { analysisScenarioPasses: number };
  };
  const scenarios = createAssessmentCampaign().scenarios;
  const rows: {
    caseId: string;
    turn: number;
    baselinePass: boolean;
    replayPass: boolean;
    baselineError?: string;
    replayError?: string;
    baselineAdequacy?: string;
    replayAdequacy?: string;
    failures: string[];
  }[] = [];
  let stateMismatches = 0;
  for (const artifact of baseline.artifacts.reports) {
    if (basename(artifact.file) !== artifact.file)
      throw Error('REPLAY_ARTIFACT_PATH_INVALID');
    const bytes = readFileSync(resolve(directory, artifact.file));
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
      throw Error('REPLAY_ARTIFACT_HASH_MISMATCH');
    const report = JSON.parse(bytes.toString('utf8')) as {
      rows: AssessmentEvaluationRow[];
    };
    const scenario = scenarios.find((s) => s.id === artifact.caseId);
    if (!scenario) throw Error('REPLAY_CASE_UNKNOWN');
    let previous: AssessmentView | null = null,
      purpose: AssessmentPurpose = scenario.purpose,
      sourceRevision = 1;
    for (const row of report.rows.filter(
      (r) => r.role === 'analysis' && !r.skipped,
    )) {
      const turn = scenario.turns[row.turn - 1];
      if (turn.action === 'reset' || turn.noteReplacement) previous = null;
      if (turn.action === 'reset') purpose = turn.newPurpose!;
      if (turn.noteReplacement) sourceRevision++;
      const input: AssessmentModelInput = {
        sources: row.sources ?? scenario.sources,
        answers: row.answers ?? [],
        previous,
        purpose,
      };
      if (turn.action === 'correct') {
        const answer = input.answers.at(-1);
        if (!answer?.answer) throw Error('REPLAY_CORRECTION_MISSING');
        input.correction = { targetId: answer.gapId, text: answer.answer };
      }
      const meta = {
        sourceRevision,
        taskContextHash: assessmentHash(
          input.sources.filter((s) => s.kind === 'TASK'),
        ),
        model: 'offline/replay',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      };
      const baselinePass =
        row.boundaryDenied === true ||
        !!(row.grade?.automatedPass && row.runtimeGrade?.automatedPass);
      if (!row.rawSyntheticResponse) {
        rows.push({
          caseId: row.caseId,
          turn: row.turn,
          baselinePass,
          replayPass: baselinePass,
          baselineError: row.errorCode,
          replayError: row.errorCode,
          failures: row.boundaryDenied ? [] : ['NO_REPLAYABLE_MODEL_RESPONSE'],
        });
      } else {
        try {
          const output = parseAssessmentCompletion(
            input,
            row.rawSyntheticResponse,
            !!row.formattingRecovery?.length,
          ).result;
          const view = assembleAssessment(input, output, meta);
          const rawGrade = gradeAssessment(
            scenario,
            row.turn - 1,
            output,
            input,
          );
          const runtimeGrade = gradeAssessment(
            scenario,
            row.turn - 1,
            {
              ...output,
              noteAdequacy: view.noteAdequacy,
              nextQuestion: view.nextQuestion ? output.nextQuestion : null,
            },
            input,
            view,
          );
          rows.push({
            caseId: row.caseId,
            turn: row.turn,
            baselinePass,
            replayPass: rawGrade.automatedPass && runtimeGrade.automatedPass,
            baselineError: row.errorCode,
            baselineAdequacy: row.runtimeState?.noteAdequacy,
            replayAdequacy: view.noteAdequacy,
            failures: [
              ...new Set([...rawGrade.failures, ...runtimeGrade.failures]),
            ],
          });
        } catch (error) {
          const message =
            error instanceof Error && /^[A-Z_]+$/u.test(error.message)
              ? error.message
              : 'REPLAY_PROTOCOL_REJECTED';
          rows.push({
            caseId: row.caseId,
            turn: row.turn,
            baselinePass,
            replayPass: false,
            baselineError: row.errorCode,
            replayError: message,
            failures: [message],
          });
        }
      }
      // Reconstruct the ORIGINAL state from its saved parsed result, not from the
      // new parse. Later recorded answers were written for that original state.
      if (row.output) {
        previous = assembleAssessment(input, row.output, meta);
        if (
          row.runtimeState &&
          JSON.stringify({
            state: previous.state,
            noteAdequacy: previous.noteAdequacy,
            counters: previous.counters,
          }) !== JSON.stringify(row.runtimeState)
        )
          stateMismatches++;
      }
    }
  }
  const casePasses = (field: 'baselinePass' | 'replayPass') =>
    scenarios.filter((c) => {
      const selected = rows.filter((r) => r.caseId === c.id);
      return (
        selected.length === c.turns.length && selected.every((r) => r[field])
      );
    }).length;
  const result = {
    classification: 'OFFLINE_RECORDED_OUTPUT_REPLAY_NOT_NEW_MODEL_EVALUATION',
    recordedPromptVersion: 'task-note-assessment/2026-10-29.v12',
    replayProtocolVersion: ASSESSMENT_PROMPT_VERSION,
    questionGenerationEvaluated: false,
    implementationHashes: Object.fromEntries(
      [
        'work-note-assessment.protocol.ts',
        'work-note-assessment.polarity.ts',
        'work-note-assessment.state.ts',
      ].map((file) => [
        file,
        createHash('sha256')
          .update(
            readFileSync(
              resolve(
                process.cwd(),
                'src/services/capture/application/work-note-agent',
                file,
              ),
            ),
          )
          .digest('hex'),
      ]),
    ),
    baselineSummarySha256: createHash('sha256')
      .update(baselineBytes)
      .digest('hex'),
    networkCalls: 0,
    originalStateMismatches: stateMismatches,
    observedSteps: rows.length,
    baselineStepPasses: rows.filter((r) => r.baselinePass).length,
    replayStepPasses: rows.filter((r) => r.replayPass).length,
    baselineScenarioPasses: casePasses('baselinePass'),
    replayScenarioPasses: casePasses('replayPass'),
    improved: rows.filter((r) => !r.baselinePass && r.replayPass),
    regressed: rows.filter((r) => r.baselinePass && !r.replayPass),
    rows,
    releaseGate: 'NOT_PASSED',
    reviewerSemanticAssessment: 'NOT_ESTABLISHED',
    limitations: [
      'Prompts were not rerun; question-generation quality cannot be inferred from replay',
      'Original conversation state is held fixed; no new answers or missing turns are fabricated',
      'These observed cases are regression data, not an unseen validation set',
    ],
  };
  if (
    stateMismatches ||
    result.baselineScenarioPasses !==
      baseline.scenarioCounts.analysisScenarioPasses
  )
    throw Error('REPLAY_BASELINE_RECONSTRUCTION_MISMATCH');
  return result;
}
if (require.main === module) {
  const result = replayAssessmentEvidence();
  const target = resolve(
    process.cwd(),
    `.worknote-agent-evals/optimization-v13-replay-${Date.now()}-${randomUUID().slice(0, 8)}.json`,
  );
  if (existsSync(target)) throw Error('REPLAY_REPORT_ALREADY_EXISTS');
  writeFileSync(target, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(
    JSON.stringify({
      observedSteps: result.observedSteps,
      baselineSteps: result.baselineStepPasses,
      replaySteps: result.replayStepPasses,
      baselineScenarios: result.baselineScenarioPasses,
      replayScenarios: result.replayScenarioPasses,
      improved: result.improved,
      regressed: result.regressed,
      stateMismatches: result.originalStateMismatches,
      artifact: target,
    }),
  );
}
