import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadRelease60Corpus,
  gradeAssessment,
  type AssessmentEvaluationRow,
  type AssessmentScenario,
} from './assessment-evaluation';
import {
  computeAssessmentQualityGate,
  type QualityGateReport,
} from './assessment-quality-gate';
import {
  parseAssessmentCompletion,
  ASSESSMENT_PROMPT_VERSION,
} from '../../src/services/capture/application/work-note-agent/work-note-assessment.protocol';
import { assembleAssessment } from '../../src/services/capture/application/work-note-agent/work-note-assessment.state';
import {
  computeAssessmentTaskHash,
  extractSnapshotsFromSources,
} from '../../src/services/capture/application/work-note-agent/work-note-assessment.pipeline';
import {
  ASSESSMENT_EDITOR_INSTRUCTION_VERSION,
  assertAssessmentEditorProposal,
  buildAssessmentEditorInput,
  prepareAssessmentEditorRequest,
} from '../../src/services/capture/application/work-note-agent/work-note-assessment-editor';
import { parseRewriteCompletion } from '../../src/services/capture/application/work-note-agent/work-note-agent.completion';
import { AgentValidationError } from '../../src/services/capture/application/work-note-agent/work-note-agent.types';
import type {
  AssessmentModelInput,
  AssessmentPurpose,
  AssessmentView,
} from '../../src/services/capture/application/work-note-agent/work-note-assessment.types';
import type { DraftSnapshot } from '../../src/services/capture/application/work-note-agent/work-note-agent.types';

export type ReleaseReplayDiffSummary = {
  phaseId: string;
  replayProtocolVersion: string;
  replayEditorVersion: string;
  analysisTurnsReplayed: number;
  claimsPromotedToFull: number;
  claimsDemotedFromFull: number;
  coveragesPromotedToSupported: number;
  coveragesDemotedFromSupported: number;
  adequacyChanges: {
    caseId: string;
    turn: number;
    layer: 'raw' | 'runtime';
    before: string;
    after: string;
  }[];
  editorAttempted: number;
  editorAcceptedBefore: number;
  editorAcceptedAfter: number;
  editorChanges: {
    caseId: string;
    beforeAccepted: boolean;
    afterAccepted: boolean;
    beforeError?: string;
    afterError?: string;
  }[];
  criticalErrorsBefore: { raw: number; runtime: number };
  criticalErrorsAfter: { raw: number; runtime: number };
  criticalErrorsIncreased: boolean;
  validation20Gate: QualityGateReport;
  holdout40Gate: QualityGateReport;
  combined60Gate: QualityGateReport;
};

function reconstructRawEditorResponse(
  row: AssessmentEvaluationRow,
  preparedFragments: readonly { marker: string; text: string }[],
): string {
  if (row.rawSyntheticResponse) return row.rawSyntheticResponse;
  const out = row.editorOutput;
  if (!out) throw new Error(`MISSING_EDITOR_RECORD:${row.caseId}`);
  let replacementText = out.suggestion?.replacementText ?? null;
  if (replacementText !== null && preparedFragments.length > 0) {
    let cursor = 0;
    let encoded = '';
    for (const frag of preparedFragments) {
      const idx = replacementText.indexOf(frag.text, cursor);
      if (idx < 0) {
        throw new Error(
          `CANNOT_RECONSTRUCT_EDITOR_FRAGMENT:${row.caseId}:${frag.marker}`,
        );
      }
      encoded += replacementText.slice(cursor, idx) + frag.marker;
      cursor = idx + frag.text.length;
    }
    replacementText = encoded + replacementText.slice(cursor);
  }
  return JSON.stringify({
    status: out.status,
    message: out.message,
    suggestion: out.suggestion
      ? {
          replacementText,
          suggestedTitle: out.suggestion.suggestedTitle,
          changeSummary: out.suggestion.changeSummary,
        }
      : null,
    questions: out.questions,
    uncertainties: out.uncertainties,
  });
}

export function replaySplitRows(
  scenarios: readonly AssessmentScenario[],
  savedRows: readonly AssessmentEvaluationRow[],
): {
  replayedRows: AssessmentEvaluationRow[];
  claimsPromotedToFull: number;
  claimsDemotedFromFull: number;
  coveragesPromotedToSupported: number;
  coveragesDemotedFromSupported: number;
  adequacyChanges: ReleaseReplayDiffSummary['adequacyChanges'];
  editorAcceptedBefore: number;
  editorAcceptedAfter: number;
  editorAttempted: number;
  editorChanges: ReleaseReplayDiffSummary['editorChanges'];
} {
  const byCase = new Map<string, AssessmentEvaluationRow[]>();
  for (const r of savedRows) {
    const list = byCase.get(r.caseId) ?? [];
    list.push(r);
    byCase.set(r.caseId, list);
  }

  const replayedRows: AssessmentEvaluationRow[] = [];
  let claimsPromotedToFull = 0;
  let claimsDemotedFromFull = 0;
  let coveragesPromotedToSupported = 0;
  let coveragesDemotedFromSupported = 0;
  const adequacyChanges: ReleaseReplayDiffSummary['adequacyChanges'] = [];
  let editorAttempted = 0;
  let editorAcceptedBefore = 0;
  let editorAcceptedAfter = 0;
  const editorChanges: ReleaseReplayDiffSummary['editorChanges'] = [];

  for (const scenario of scenarios) {
    const caseRows = byCase.get(scenario.id) ?? [];
    const extracted = extractSnapshotsFromSources(scenario.sources, {
      revision: 1,
      stepDoneByIndex: scenario.stepDoneByIndex,
    });
    const currentTaskHash = computeAssessmentTaskHash({
      taskContext: extracted.taskContext,
      taskContextVersion: extracted.taskContextVersion,
      taskContextInvalid: false,
    });
    let originalPrevious: AssessmentView | null = null;
    let replayedLastView: AssessmentView | null = null;
    let purpose: AssessmentPurpose = scenario.purpose;
    let sourceRevision = extracted.note.revision;
    let noteBody = extracted.note.contentMarkdown;
    const noteTitle = extracted.note.title;

    for (const row of caseRows) {
      if (row.role === 'analysis') {
        const turn = scenario.turns[row.turn - 1];
        if (!turn) continue;
        if (turn.action === 'reset' || turn.noteReplacement) {
          originalPrevious = null;
        }
        if (turn.action === 'reset' && turn.newPurpose) {
          purpose = turn.newPurpose;
        }
        if (turn.noteReplacement) {
          sourceRevision++;
          noteBody = turn.noteReplacement;
        }
        const sources = row.sources ?? scenario.sources;
        const answers = row.answers ?? [];
        const input: AssessmentModelInput = {
          sources,
          answers,
          previous: originalPrevious,
          purpose,
        };
        if (turn.action === 'correct') {
          const lastAns = answers.at(-1);
          if (lastAns?.answer) {
            input.correction = {
              targetId: lastAns.gapId,
              text: lastAns.answer,
            };
          }
        }
        const meta = {
          sourceRevision,
          taskContextHash: currentTaskHash,
          model: 'offline/replay',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        };

        if (!row.rawSyntheticResponse) {
          replayedRows.push(structuredClone(row));
        } else {
          try {
            const parsed = parseAssessmentCompletion(
              input,
              row.rawSyntheticResponse,
              Boolean(row.formattingRecovery?.length),
            );
            const output = parsed.result;
            const view = assembleAssessment(input, output, meta);
            replayedLastView = view;

            if (row.output) {
              const len = Math.min(
                row.output.claims.length,
                output.claims.length,
              );
              for (let idx = 0; idx < len; idx++) {
                const beforeRel = row.output.claims[idx].supportRelation;
                const afterRel = output.claims[idx].supportRelation;
                if (beforeRel !== 'FULL' && afterRel === 'FULL')
                  claimsPromotedToFull++;
                if (beforeRel === 'FULL' && afterRel !== 'FULL')
                  claimsDemotedFromFull++;
              }
              const covLen = Math.min(
                row.output.coverage.length,
                output.coverage.length,
              );
              for (let idx = 0; idx < covLen; idx++) {
                const b = row.output.coverage[idx].status;
                const a = output.coverage[idx].status;
                if (b !== 'SUPPORTED' && a === 'SUPPORTED')
                  coveragesPromotedToSupported++;
                if (b === 'SUPPORTED' && a !== 'SUPPORTED')
                  coveragesDemotedFromSupported++;
              }
              if (row.output.noteAdequacy !== output.noteAdequacy) {
                adequacyChanges.push({
                  caseId: scenario.id,
                  turn: row.turn,
                  layer: 'raw',
                  before: row.output.noteAdequacy,
                  after: output.noteAdequacy,
                });
              }
            }
            if (
              row.runtimeState?.noteAdequacy &&
              row.runtimeState.noteAdequacy !== view.noteAdequacy
            ) {
              adequacyChanges.push({
                caseId: scenario.id,
                turn: row.turn,
                layer: 'runtime',
                before: row.runtimeState.noteAdequacy,
                after: view.noteAdequacy,
              });
            }

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
            replayedRows.push({
              ...row,
              formattingRecovery: parsed.formattingRecovery,
              output,
              runtimeState: {
                state: view.state,
                noteAdequacy: view.noteAdequacy,
                counters: view.counters,
              },
              grade: rawGrade,
              runtimeGrade,
              errorCode: undefined,
            });
          } catch (err) {
            const code =
              err instanceof Error && /^[A-Z0-9_]+$/u.test(err.message)
                ? err.message
                : 'REPLAY_PROTOCOL_REJECTED';
            replayedRows.push({
              ...row,
              output: undefined,
              grade: undefined,
              runtimeGrade: undefined,
              errorCode: code,
            });
          }
        }

        if (row.output) {
          originalPrevious = assembleAssessment(input, row.output, meta);
        }
      } else if (row.role === 'editor') {
        editorAttempted++;
        const beforeAccepted = Boolean(
          row.editorValidation?.runtimeProposalAccepted && !row.errorCode,
        );
        if (beforeAccepted) editorAcceptedBefore++;

        const assessmentForEditor = originalPrevious ?? replayedLastView;
        if (!assessmentForEditor) {
          replayedRows.push(structuredClone(row));
          if (beforeAccepted) editorAcceptedAfter++;
          continue;
        }
        const draftSnapshot: DraftSnapshot = {
          revision: sourceRevision,
          title: noteTitle,
          body: noteBody,
        };
        const editorInput = buildAssessmentEditorInput(
          draftSnapshot,
          extracted.taskContext,
          assessmentForEditor,
        );
        try {
          const prepared = prepareAssessmentEditorRequest(editorInput);
          const rawEditor = reconstructRawEditorResponse(
            row,
            prepared.fragments,
          );
          const parsed = parseRewriteCompletion(
            prepared,
            rawEditor,
            Boolean(row.editorValidation?.formattingRecovery?.length),
          );
          assertAssessmentEditorProposal(editorInput, parsed.result);
          editorAcceptedAfter++;
          if (!beforeAccepted) {
            editorChanges.push({
              caseId: scenario.id,
              beforeAccepted,
              afterAccepted: true,
              beforeError: row.errorCode,
            });
          }
          replayedRows.push({
            ...row,
            editorOutput: parsed.result,
            editorValidation: {
              runtimeProposalAccepted: true,
              formattingRecovery: parsed.formattingRecovery,
            },
            errorCode: undefined,
          });
        } catch (err) {
          const afterError =
            err instanceof AgentValidationError
              ? `REWRITE_${err.code}`
              : err instanceof Error
                ? err.message
                : 'REWRITE_UNKNOWN_ERROR';
          if (beforeAccepted || row.errorCode !== afterError) {
            editorChanges.push({
              caseId: scenario.id,
              beforeAccepted,
              afterAccepted: false,
              beforeError: row.errorCode,
              afterError,
            });
          }
          replayedRows.push({
            ...row,
            editorOutput: undefined,
            editorValidation: undefined,
            errorCode: afterError,
          });
        }
      }
    }
  }

  return {
    replayedRows,
    claimsPromotedToFull,
    claimsDemotedFromFull,
    coveragesPromotedToSupported,
    coveragesDemotedFromSupported,
    adequacyChanges,
    editorAcceptedBefore,
    editorAcceptedAfter,
    editorAttempted,
    editorChanges,
  };
}

export function replayRelease60Phase(
  phaseId = 'plan-v3-release60-v25-20261103',
  rootDir = process.cwd(),
  corpusPath?: string,
): ReleaseReplayDiffSummary {
  const evalDir = resolve(rootDir, '.worknote-agent-evals');
  const valPath = resolve(evalDir, `${phaseId}.validation-rows.json`);
  const holdPath = resolve(evalDir, `${phaseId}.holdout-rows.json`);
  if (!existsSync(valPath) || !existsSync(holdPath)) {
    throw new Error(`RELEASE_REPLAY_ARTIFACTS_MISSING:${phaseId}`);
  }
  const corpus = loadRelease60Corpus(corpusPath);
  const valSaved = JSON.parse(readFileSync(valPath, 'utf8')) as {
    rows: AssessmentEvaluationRow[];
    gate: QualityGateReport;
  };
  const holdSaved = JSON.parse(readFileSync(holdPath, 'utf8')) as {
    rows: AssessmentEvaluationRow[];
    gate: QualityGateReport;
  };

  const valScenarios = corpus.scenarios.filter((s) => s.split === 'validation');
  const holdScenarios = corpus.scenarios.filter((s) => s.split === 'holdout');

  const baselineCombinedGate = computeAssessmentQualityGate(
    [...valSaved.rows, ...holdSaved.rows],
    corpus,
  );

  const valReplay = replaySplitRows(valScenarios, valSaved.rows);
  const holdReplay = replaySplitRows(holdScenarios, holdSaved.rows);

  const validation20Gate = computeAssessmentQualityGate(
    valReplay.replayedRows,
    { ...corpus, scenarios: valScenarios },
  );
  const holdout40Gate = computeAssessmentQualityGate(holdReplay.replayedRows, {
    ...corpus,
    scenarios: holdScenarios,
  });
  const combined60Gate = computeAssessmentQualityGate(
    [...valReplay.replayedRows, ...holdReplay.replayedRows],
    corpus,
  );

  const criticalErrorsBefore = {
    raw: baselineCombinedGate.rawModelOutput.criticalErrors.total,
    runtime: baselineCombinedGate.postGuardRuntime.criticalErrors.total,
  };
  const criticalErrorsAfter = {
    raw: combined60Gate.rawModelOutput.criticalErrors.total,
    runtime: combined60Gate.postGuardRuntime.criticalErrors.total,
  };

  return {
    phaseId,
    replayProtocolVersion: ASSESSMENT_PROMPT_VERSION,
    replayEditorVersion: ASSESSMENT_EDITOR_INSTRUCTION_VERSION,
    analysisTurnsReplayed:
      validation20Gate.rawModelOutput.evaluatedTurns +
      holdout40Gate.rawModelOutput.evaluatedTurns,
    claimsPromotedToFull:
      valReplay.claimsPromotedToFull + holdReplay.claimsPromotedToFull,
    claimsDemotedFromFull:
      valReplay.claimsDemotedFromFull + holdReplay.claimsDemotedFromFull,
    coveragesPromotedToSupported:
      valReplay.coveragesPromotedToSupported +
      holdReplay.coveragesPromotedToSupported,
    coveragesDemotedFromSupported:
      valReplay.coveragesDemotedFromSupported +
      holdReplay.coveragesDemotedFromSupported,
    adequacyChanges: [
      ...valReplay.adequacyChanges,
      ...holdReplay.adequacyChanges,
    ],
    editorAttempted: valReplay.editorAttempted + holdReplay.editorAttempted,
    editorAcceptedBefore:
      valReplay.editorAcceptedBefore + holdReplay.editorAcceptedBefore,
    editorAcceptedAfter:
      valReplay.editorAcceptedAfter + holdReplay.editorAcceptedAfter,
    editorChanges: [...valReplay.editorChanges, ...holdReplay.editorChanges],
    criticalErrorsBefore,
    criticalErrorsAfter,
    criticalErrorsIncreased:
      criticalErrorsAfter.raw > criticalErrorsBefore.raw ||
      criticalErrorsAfter.runtime > criticalErrorsBefore.runtime,
    validation20Gate,
    holdout40Gate,
    combined60Gate,
  };
}

if (require.main === module) {
  const phaseId = process.argv[2] ?? 'plan-v3-release60-v25-20261103';
  const summary = replayRelease60Phase(phaseId);
  process.stdout.write(
    `${JSON.stringify(
      {
        phaseId: summary.phaseId,
        analysisTurnsReplayed: summary.analysisTurnsReplayed,
        claimsPromotedToFull: summary.claimsPromotedToFull,
        claimsDemotedFromFull: summary.claimsDemotedFromFull,
        coveragesPromotedToSupported: summary.coveragesPromotedToSupported,
        adequacyChanges: summary.adequacyChanges,
        editor: {
          attempted: summary.editorAttempted,
          acceptedBefore: summary.editorAcceptedBefore,
          acceptedAfter: summary.editorAcceptedAfter,
          changes: summary.editorChanges,
        },
        criticalErrorsBefore: summary.criticalErrorsBefore,
        criticalErrorsAfter: summary.criticalErrorsAfter,
        criticalErrorsIncreased: summary.criticalErrorsIncreased,
        validation20MacroF1: {
          raw: summary.validation20Gate.rawModelOutput.adequacy.macroF1,
          runtime: summary.validation20Gate.postGuardRuntime.adequacy.macroF1,
        },
        holdout40: {
          rawMacroF1: summary.holdout40Gate.rawModelOutput.adequacy.macroF1,
          runtimeMacroF1:
            summary.holdout40Gate.postGuardRuntime.adequacy.macroF1,
          rawFalseSufficient:
            summary.holdout40Gate.rawModelOutput.criticalErrors.falseSufficient,
          runtimeFalseSufficient:
            summary.holdout40Gate.postGuardRuntime.criticalErrors
              .falseSufficient,
          rawAnswerUse: summary.holdout40Gate.rawModelOutput.answerUse,
          runtimeAnswerUse: summary.holdout40Gate.postGuardRuntime.answerUse,
          questions: summary.holdout40Gate.postGuardRuntime.questions,
          format: summary.holdout40Gate.rawModelOutput.firstPassFormatValidity,
        },
        combined60Passed: summary.combined60Gate.automatedGatePassed,
      },
      null,
      2,
    )}\n`,
  );
}
