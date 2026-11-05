import {
  parseReleaseCorpusVariant,
  partitionResumableStageScenarios,
} from '../../../../../scripts/work-note-agent/assessment-release-gate-run';
import { computeAssessmentQualityGate } from '../../../../../scripts/work-note-agent/assessment-quality-gate';
import {
  loadDevV26AssessmentCorpus,
  type AssessmentEvaluationRow,
} from '../../../../../scripts/work-note-agent/assessment-evaluation';
import {
  isValidAssessmentPhaseId,
  parseAssessmentRunOptions,
} from '../../../../../scripts/work-note-agent/assessment-run';

describe('Release evaluator integrity', () => {
  const corpus = loadDevV26AssessmentCorpus();
  const caseId = corpus.scenarios[0].id;

  it('does not count an unrelated scenario response as completion of an expected turn', () => {
    const rows: AssessmentEvaluationRow[] = [
      {
        caseId: 'unrelated-case',
        turn: 1,
        role: 'analysis',
        output: {
          purpose: 'PROGRESS',
          taskUnderstanding: {
            objective: 'Synthetic',
            scope: 'Synthetic',
            requirements: [],
            unknowns: [],
          },
          claims: [],
          coverage: [],
          gaps: [],
          noteAdequacy: 'ENOUGH_FOR_PURPOSE',
          taskContextStatus: 'CLEAR',
          nextQuestion: null,
        },
      },
    ];
    const metrics = computeAssessmentQualityGate(rows, corpus).postGuardRuntime;
    expect(metrics.workflowCompletion.successfulTurns).toBe(0);
    expect(metrics.workflowCompletion.unexpectedTurns).toBe(1);
  });

  it('keeps a missing scripted question out of model-format statistics but fails workflow completion', () => {
    const rows: AssessmentEvaluationRow[] = [
      {
        caseId,
        turn: 2,
        role: 'analysis',
        errorCode: 'SCRIPTED_QUESTION_NOT_PRODUCED',
      },
    ];
    const gate = computeAssessmentQualityGate(rows, corpus);
    expect(gate.postGuardRuntime.firstPassFormatValidity.attemptedTurns).toBe(
      0,
    );
    expect(gate.postGuardRuntime.workflowCompletion.failedTurns).toBe(1);
    expect(gate.postGuardRuntime.workflowCompletion.pass).toBe(false);
    expect(gate.automatedGatePassed).toBe(false);
  });

  it('counts malformed provider output as a format failure, but not an HTTP interruption', () => {
    const rows: AssessmentEvaluationRow[] = [
      {
        caseId,
        turn: 1,
        role: 'analysis',
        errorCode: 'INVALID_STRING',
        rawSyntheticResponse: '{}',
      },
      {
        caseId: corpus.scenarios[1].id,
        turn: 1,
        role: 'analysis',
        errorCode: 'XKIRO_HTTP_ERROR_429',
      },
    ];
    const gate = computeAssessmentQualityGate(rows, corpus);
    expect(gate.postGuardRuntime.firstPassFormatValidity.attemptedTurns).toBe(
      1,
    );
    expect(gate.postGuardRuntime.firstPassFormatValidity.validFirstPass).toBe(
      0,
    );
    expect(gate.postGuardRuntime.workflowCompletion.failedTurns).toBe(2);
  });
});

describe('Stage checkpoint turn completeness', () => {
  it('does not mark a multi-turn scenario complete after only its first response', () => {
    const rows: AssessmentEvaluationRow[] = [
      { caseId: 'case-a', role: 'analysis', turn: 1 },
    ];
    const part = partitionResumableStageScenarios(
      ['case-a'],
      rows,
      new Map([['case-a', 2]]),
    );
    expect(part.remainingCaseIds).toEqual(['case-a']);
  });
  it('rejects duplicated analysis turns instead of certifying a checkpoint', () => {
    const row: AssessmentEvaluationRow = {
      caseId: 'case-a',
      role: 'analysis',
      turn: 1,
    };
    expect(() =>
      partitionResumableStageScenarios(
        ['case-a'],
        [row, row],
        new Map([['case-a', 2]]),
      ),
    ).toThrow('DUPLICATE_ANALYSIS_TURN');
  });
  it('rejects unknown release corpus variants and validates phase IDs consistently across freeze and runner', () => {
    expect(parseReleaseCorpusVariant()).toBe('v5');
    expect(parseReleaseCorpusVariant('--corpus=v5')).toBe('v5');
    expect(parseReleaseCorpusVariant('--corpus=v6')).toBe('v6');
    expect(parseReleaseCorpusVariant('--corpus=v7')).toBe('v7');
    expect(() => parseReleaseCorpusVariant('--corpus=V7')).toThrow(
      'RELEASE_CORPUS_VARIANT_INVALID',
    );
    expect(() => parseReleaseCorpusVariant('--corpus=v8')).toThrow(
      'RELEASE_CORPUS_VARIANT_INVALID',
    );

    const validPhaseId = 'Plan_V4-release60_20261105';
    expect(isValidAssessmentPhaseId(validPhaseId)).toBe(true);
    expect(
      parseAssessmentRunOptions(['--phase-id', validPhaseId]).phaseId,
    ).toBe(validPhaseId);
  });
});
