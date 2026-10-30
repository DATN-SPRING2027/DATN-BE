import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAssessmentCampaign } from './assessment-domains';
import { validateReleaseAssessmentCorpus } from './assessment-quality-gate';
import type {
  AssessmentModelInput,
  AssessmentModelOutput,
  AssessmentAnswer,
  AssessmentPurpose,
  AssessmentSource,
  AssessmentView,
} from '../../src/services/capture/application/work-note-agent/work-note-assessment.types';
import type { AgentResult } from '../../src/services/capture/application/work-note-agent/work-note-agent.types';

export type AssessmentExpected = {
  taskContextStatus: AssessmentModelOutput['taskContextStatus'][];
  noteAdequacy: AssessmentModelOutput['noteAdequacy'][];
  question: 'required' | 'optional' | 'none';
  questionGapKinds: string[];
  expectedNeedCodes?: string[];
  questionTopicPatterns: string[];
  forbiddenAssertions: string[];
  minReportedClaims: number;
  requirements: 'grounded' | 'none';
  boundaryError?: boolean;
};
export type AssessmentTurn = {
  action: 'assess' | 'answer' | 'unknown' | 'skip' | 'correct' | 'reset';
  answer?: string;
  correctionText?: string;
  newPurpose?: AssessmentPurpose;
  carryAnswered?: boolean;
  noteReplacement?: string;
  expected: AssessmentExpected;
};
export type AssessmentScenario = {
  id: string;
  family: string;
  category: string;
  split: 'development' | 'validation' | 'holdout';
  synthetic: true;
  pilot: boolean;
  critical: boolean;
  purpose: AssessmentPurpose;
  sources: AssessmentSource[];
  stepDoneByIndex?: boolean[];
  turns: AssessmentTurn[];
  rubric: { accepted: string[]; prohibited: string[]; questionUtility: string };
};
export type AssessmentCorpus = {
  version: string;
  classification: 'synthetic-only';
  splitPolicy: string;
  scenarios: AssessmentScenario[];
};
export function loadAssessmentCorpus(): AssessmentCorpus {
  const corpus = JSON.parse(
    readFileSync(resolve(__dirname, 'cases-assessment-v4.json'), 'utf8'),
  ) as AssessmentCorpus;
  // Versioned, reviewable development-only errata. Original corpus and historical
  // reports remain immutable; no validation/holdout labels are tuned here.
  const errata = JSON.parse(
    readFileSync(resolve(__dirname, 'cases-assessment-v4-errata.json'), 'utf8'),
  ) as {
    version: string;
    baseVersion: string;
    changes: {
      caseId: string;
      turnIndex: number;
      expected: Partial<AssessmentExpected>;
      reason: string;
    }[];
  };
  if (errata.baseVersion !== corpus.version)
    throw Error('ASSESSMENT_ERRATA_BASE');
  for (const change of errata.changes) {
    const scenario = corpus.scenarios.find((s) => s.id === change.caseId);
    const turn = scenario?.turns[change.turnIndex];
    if (
      !scenario ||
      scenario.split !== 'development' ||
      !turn ||
      !change.reason
    )
      throw Error('ASSESSMENT_ERRATA_INVALID');
    turn.expected = { ...turn.expected, ...change.expected };
  }
  corpus.version = errata.version;
  const counts = { development: 0, validation: 0, holdout: 0 };
  const turns = { 1: 0, 2: 0, 3: 0 };
  const ids = new Set<string>();
  const families = new Map<string, string>();
  if (
    corpus.classification !== 'synthetic-only' ||
    corpus.scenarios.length !== 72
  )
    throw Error('ASSESSMENT_CORPUS_INVALID');
  for (const c of corpus.scenarios) {
    if (
      !c.synthetic ||
      ids.has(c.id) ||
      !Object.hasOwn(counts, c.split) ||
      !Object.hasOwn(turns, c.turns.length) ||
      !c.rubric.accepted.length ||
      !c.rubric.prohibited.length ||
      c.turns[0].action !== 'assess'
    )
      throw Error('ASSESSMENT_SCENARIO_INVALID');
    if (families.has(c.family) && families.get(c.family) !== c.split)
      throw Error('ASSESSMENT_FAMILY_LEAKAGE');
    families.set(c.family, c.split);
    ids.add(c.id);
    counts[c.split]++;
    turns[c.turns.length as 1 | 2 | 3]++;
    if (
      c.sources.some(
        (s) =>
          !['TASK', 'NOTE', 'ANSWER'].includes(s.kind) ||
          typeof s.text !== 'string',
      ) ||
      new Set(c.sources.map((s) => s.id)).size !== c.sources.length
    )
      throw Error('ASSESSMENT_SOURCE_INVALID');
    for (const t of c.turns) {
      if (
        !t.expected.taskContextStatus.length ||
        !t.expected.noteAdequacy.length ||
        !['required', 'optional', 'none'].includes(t.expected.question)
      )
        throw Error('ASSESSMENT_EXPECTATION_INVALID');
      for (const pattern of [
        ...t.expected.questionTopicPatterns,
        ...t.expected.forbiddenAssertions,
      ])
        new RegExp(pattern, 'iu');
    }
  }
  const pilot = corpus.scenarios.filter((c) => c.pilot);
  if (
    JSON.stringify(counts) !==
      JSON.stringify({ development: 36, validation: 12, holdout: 24 }) ||
    turns[1] !== 48 ||
    turns[2] !== 16 ||
    turns[3] !== 8 ||
    pilot.length !== 12 ||
    pilot.some((c) => c.split !== 'development') ||
    pilot.reduce((n, c) => n + c.turns.length + 1, 0) !== 29
  )
    throw Error('ASSESSMENT_SPLIT_CHANGED');
  return corpus;
}

/**
 * Plan v3 §6: Reclassifies all 80 previously observed cases (72 v4 + 8 domain challenge)
 * strictly as REGRESSION (never reused as independent holdout), applying contract-consistent
 * regression errata where CONTRADICTORY turns stop automatic questions.
 */
export function loadRegression80Corpus(): AssessmentCorpus {
  const campaign = structuredClone(createAssessmentCampaign());
  const byId = new Map(campaign.scenarios.map((s) => [s.id, s]));

  const invoiceB = byId.get('assessment-invoice-rounding-b');
  if (invoiceB?.turns[0]) {
    invoiceB.turns[0].expected.question = 'none';
  }

  const scopeB = byId.get('assessment-task-scope-b');
  if (scopeB?.turns[0]) {
    scopeB.turns[0].expected.question = 'none';
  }
  if (scopeB?.turns[2] && scopeB.turns[2].action === 'reset') {
    scopeB.turns[2].carryAnswered = true;
  }

  const multilangB = byId.get('assessment-multilang-negation-b');
  if (multilangB?.turns[0]) {
    multilangB.turns[0].expected.question = 'none';
  }
  if (multilangB?.turns[1] && multilangB.turns[1].action === 'answer') {
    multilangB.turns[1] = {
      ...multilangB.turns[1],
      action: 'correct',
      correctionText: multilangB.turns[1].answer,
      expected: {
        ...multilangB.turns[1].expected,
        question: 'none',
      },
    };
  }

  if (campaign.scenarios.length !== 80) {
    throw Error('REGRESSION_80_CORPUS_INVALID');
  }

  return {
    version: 'task-note-assessment-regression80/2026-10-29.v1',
    classification: 'synthetic-only',
    splitPolicy:
      'Plan v3 §6 regression corpus: all 80 previously observed synthetic cases reclassified strictly as regression, never reused as independent holdout.',
    scenarios: campaign.scenarios,
  };
}

/**
 * Plan v3 §6: Loads and validates the frozen 60-case unseen release corpus
 * (30 disjoint task families x 2 contrastive variants; 20 validation + 40 holdout;
 * 40x1-turn + 12x2-turn + 8x3-turn = 88 analysis turns + up to 60 Editor calls = 148 baseline ceiling).
 */
export function loadRelease60Corpus(
  filePath = resolve(__dirname, 'cases-assessment-v5-release.json'),
): AssessmentCorpus {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as AssessmentCorpus;
  const regression = loadRegression80Corpus();
  const regressionIds = new Set(regression.scenarios.map((s) => s.id));
  const regressionFamilies = new Set(regression.scenarios.map((s) => s.family));
  return validateReleaseAssessmentCorpus(raw, {
    ids: regressionIds,
    families: regressionFamilies,
  });
}

export type AssessmentGrade = {
  automatedPass: boolean;
  failures: string[];
  semanticAcceptance: 'NOT_ESTABLISHED';
  manualReview: 'required';
};
const matches = (text: string, patterns: string[]) =>
  patterns.some((p) => new RegExp(p, 'iu').test(text));
export function gradeAssessment(
  c: AssessmentScenario,
  turnIndex: number,
  output: AssessmentModelOutput,
  input?: AssessmentModelInput,
  runtime?: Pick<AssessmentView, 'state' | 'allowedActions'> &
    Partial<Pick<AssessmentView, 'gaps' | 'nextQuestion'>>,
): AssessmentGrade {
  const expected = c.turns[turnIndex].expected;
  const sources = new Map((input?.sources ?? c.sources).map((s) => [s.id, s]));
  const failures: string[] = [];
  if (
    runtime &&
    output.noteAdequacy === 'ENOUGH_FOR_PURPOSE' &&
    !runtime.allowedActions.includes('rewrite')
  )
    failures.push('RUNTIME_REWRITE_UNAVAILABLE');
  if (
    runtime &&
    output.noteAdequacy === 'ENOUGH_FOR_PURPOSE' &&
    runtime.gaps?.some(
      (g) => g.impact === 'BLOCKING' && g.status !== 'answered',
    )
  )
    failures.push('RUNTIME_BLOCKING_GAP_WITH_ENOUGH');
  if (runtime?.nextQuestion && runtime.gaps) {
    const targetGap = runtime.gaps.find(
      (g) => g.id === runtime.nextQuestion!.gapId,
    );
    if (
      !targetGap ||
      targetGap.impact !== 'BLOCKING' ||
      targetGap.status !== 'open'
    )
      failures.push('RUNTIME_QUESTION_TARGET_INVALID');
  }
  if (
    runtime &&
    output.noteAdequacy === 'CONTRADICTORY' &&
    runtime.state !== 'contradiction'
  )
    failures.push('RUNTIME_CONTRADICTION_LOST');
  if (!expected.taskContextStatus.includes(output.taskContextStatus))
    failures.push('TASK_CONTEXT_STATUS');
  if (!expected.noteAdequacy.includes(output.noteAdequacy))
    failures.push('NOTE_ADEQUACY');
  if (expected.question === 'required' && !output.nextQuestion)
    failures.push('REQUIRED_QUESTION_MISSING');
  if (expected.question === 'none' && output.nextQuestion)
    failures.push('UNNECESSARY_QUESTION');
  if (
    expected.requirements === 'none' &&
    output.taskUnderstanding.requirements.length
  )
    failures.push('INVENTED_REQUIREMENT');
  if (
    output.claims.filter((claim) => claim.originKind === 'AUTHOR_REPORT')
      .length < expected.minReportedClaims
  )
    failures.push('REPORTED_FACTS_OMITTED');
  for (const requirement of output.taskUnderstanding.requirements) {
    if (
      !requirement.sourceRefs.length ||
      requirement.sourceRefs.some(
        (ref) => sources.get(ref.sourceId)?.kind !== 'TASK',
      )
    )
      failures.push('REQUIREMENT_FROM_NON_TASK_SOURCE');
    if (requirement.sourceRefs.some((ref) => ref.sourceId === 'task.status'))
      failures.push('REQUIREMENT_FROM_STATUS');
  }
  for (const claim of output.claims) {
    if (
      claim.originKind === 'AUTHOR_REPORT' &&
      claim.sourceRefs.some((ref) => sources.get(ref.sourceId)?.kind === 'TASK')
    )
      failures.push('TASK_REQUIREMENT_USED_AS_AUTHOR_RESULT');
  }
  for (const coverage of output.coverage) {
    if (
      coverage.status === 'SUPPORTED' &&
      (!coverage.sourceRefs.length ||
        coverage.sourceRefs.some(
          (ref) => sources.get(ref.sourceId)?.kind === 'TASK',
        ))
    )
      failures.push('TASK_REQUIREMENT_USED_AS_COMPLETION_EVIDENCE');
  }
  const refs = [
    ...output.taskUnderstanding.requirements.flatMap((r) => r.sourceRefs),
    ...output.claims.flatMap((r) => r.sourceRefs),
    ...output.coverage.flatMap((r) => r.sourceRefs),
    ...output.gaps.flatMap((r) => r.sourceRefs),
  ];
  for (const ref of refs) {
    const source = sources.get(ref.sourceId);
    if (
      !source ||
      source.loadStatus !== 'LOADED' ||
      !source.includedInRequest ||
      !ref.quote.trim() ||
      !source.text.includes(ref.quote)
    )
      failures.push('SOURCE_REFERENCE_INVALID');
  }
  const taskSourceTexts = [...sources.values()]
    .filter(
      (s) =>
        s.kind === 'TASK' && s.loadStatus === 'LOADED' && s.includedInRequest,
    )
    .map((s) => s.text);
  const hasUnquotedForbiddenAssertion = expected.forbiddenAssertions.some(
    (pattern) => {
      const rx = new RegExp(pattern, 'iu');
      const inObjectiveOrScope =
        (rx.test(output.taskUnderstanding.objective) ||
          rx.test(output.taskUnderstanding.scope)) &&
        !taskSourceTexts.some((t) => rx.test(t));
      if (inObjectiveOrScope) return true;
      return output.claims.some((claim) => {
        if (!rx.test(claim.text)) return false;
        const citedTexts = claim.sourceRefs
          .map((ref) => sources.get(ref.sourceId))
          .filter(
            (s): s is AssessmentSource =>
              !!s && s.loadStatus === 'LOADED' && s.includedInRequest,
          )
          .map((s) => s.text);
        return !citedTexts.some((t) => rx.test(t));
      });
    },
  );
  if (hasUnquotedForbiddenAssertion) failures.push('FORBIDDEN_ASSERTION');
  if (output.nextQuestion) {
    const gap = output.gaps[output.nextQuestion.gapIndex];
    if (!gap || !expected.questionGapKinds.includes(gap.kind))
      failures.push('QUESTION_GAP_KIND');
    if (
      expected.expectedNeedCodes?.length &&
      (!gap?.needCode || !expected.expectedNeedCodes.includes(gap.needCode))
    )
      failures.push('QUESTION_NEED_CODE');
    if (
      expected.questionTopicPatterns.length &&
      !matches(
        `${output.nextQuestion.text} ${gap?.target ?? ''}`,
        expected.questionTopicPatterns,
      )
    )
      failures.push('QUESTION_RELEVANCE');
    if (
      input?.answers.some(
        (a) =>
          a.target === gap?.target &&
          ['answered', 'unknown', 'skipped'].includes(a.disposition),
      )
    )
      failures.push('RESOLVED_OR_DECLINED_GAP_REPEATED');
  }
  return {
    automatedPass: failures.length === 0,
    failures: [...new Set(failures)],
    semanticAcceptance: 'NOT_ESTABLISHED',
    manualReview: 'required',
  };
}

export type AssessmentEvaluationRow = {
  caseId: string;
  turn: number;
  role?: 'analysis' | 'editor';
  output?: AssessmentModelOutput;
  grade?: AssessmentGrade;
  runtimeGrade?: AssessmentGrade;
  errorCode?: string;
  skipped?: boolean;
  elapsedMs?: number;
  boundaryDenied?: boolean;
  editorOutput?: AgentResult;
  formattingRecovery?: readonly string[];
  runtimeState?: {
    state: string;
    noteAdequacy: string;
    counters: { questionCount: number; noProgress: number };
  };
  editorValidation?: {
    runtimeProposalAccepted: boolean;
    formattingRecovery: readonly string[];
  };
  sources?: AssessmentSource[];
  answers?: AssessmentAnswer[];
  rawSyntheticResponse?: string;
  requestTemplateHash?: string;
};
export function makeAssessmentWorksheet(
  rows: AssessmentEvaluationRow[],
  corpus = loadAssessmentCorpus(),
) {
  const seen = new Set<string>();
  return {
    classification: 'synthetic-assessment-human-review-worksheet',
    semanticAcceptance: 'NOT_ESTABLISHED',
    instructions:
      'Review source, purpose, every claim and question. A valid reference is not entailment. Save/Apply/author acceptance are separate signals, never semantic passes. Do not mark provider failures reviewed.',
    items: rows
      .filter((r) => r.role !== 'editor')
      .map((r) => {
        const c = corpus.scenarios.find((c) => c.id === r.caseId),
          key = `${r.caseId}/${r.turn}`;
        if (!c || r.turn < 1 || r.turn > c.turns.length || seen.has(key))
          throw Error('ASSESSMENT_REVIEW_ROW_INVALID');
        seen.add(key);
        return {
          caseId: c.id,
          family: c.family,
          turn: r.turn,
          split: c.split,
          critical: c.critical,
          availability: r.skipped
            ? 'NOT_ATTEMPTED'
            : r.boundaryDenied
              ? 'EXPECTED_TECHNICAL_CONTEXT_DENIAL'
              : r.errorCode
                ? 'PROVIDER_OR_PROTOCOL_FAILURE'
                : 'COMPLETED',
          source: r.sources ?? c.sources,
          answers: r.answers ?? [],
          scriptedTurn: c.turns[r.turn - 1],
          rubric: c.rubric,
          output: r.output ?? null,
          rawSyntheticResponse: r.rawSyntheticResponse ?? null,
          ratings: {
            taskUnderstanding: null,
            purposeAdequacy: null,
            sourceValidity: null,
            claimSupport: null,
            questionNecessity: null,
            questionUsefulness: null,
            answerUse: null,
            uncertaintyPreservation: null,
          },
          signals: {
            saved: false,
            proposalAccepted: false,
            authorValidated: false,
            independentSemanticAcceptance: 'NOT_ESTABLISHED',
          },
          reviewer: null,
          reviewedAt: null,
          notes: null,
        };
      }),
    editorItems: rows
      .filter((r) => r.role === 'editor')
      .map((r) => ({
        caseId: r.caseId,
        source:
          r.sources ?? corpus.scenarios.find((c) => c.id === r.caseId)?.sources,
        answers: r.answers ?? [],
        proposal: r.editorOutput ?? null,
        errorCode: r.errorCode ?? null,
        ratings: {
          sourceFidelity: null,
          uncertaintyPreservation: null,
          answerUse: null,
        },
        reviewer: null,
        reviewedAt: null,
      })),
  };
}
