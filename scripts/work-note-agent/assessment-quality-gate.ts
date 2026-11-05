import { createHash } from 'node:crypto';
import type {
  AssessmentCorpus,
  AssessmentEvaluationRow,
  AssessmentScenario,
} from './assessment-evaluation';
import { ASSESSMENT_PURPOSES } from '../../src/services/capture/application/work-note-agent/work-note-assessment.types';

export const EVALUATOR_VERSION = 'assessment-quality-gate/2026-11-04.v4';

export const QUALITY_GATE_THRESHOLDS = Object.freeze({
  acceptedSourceReferenceValidity: 1.0,
  maxCriticalErrors: 0,
  adequacyMacroF1: 0.9,
  questionPrecision: 0.9,
  questionRecall: 0.9,
  answerUsageAccuracy: 0.95,
  firstPassFormatValidity: 0.98,
  editorAcceptance: 0.95,
});

export const LOW_SAMPLE_CLASS_THRESHOLD = 8;

export const RESUMABLE_TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  'XKIRO_HTTP_ERROR_401',
  'XKIRO_HTTP_ERROR_408',
  'XKIRO_HTTP_ERROR_429',
  'XKIRO_HTTP_ERROR_500',
  'XKIRO_HTTP_ERROR_502',
  'XKIRO_HTTP_ERROR_503',
  'XKIRO_HTTP_ERROR_504',
  'XKIRO_NETWORK_ERROR',
  'XKIRO_TIMEOUT',
]);

export type ConfusionCounts = {
  n: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
};

export type LayerGateMetrics = {
  layer: 'raw_model_output' | 'post_guard_runtime';
  evaluatedTurns: number;
  acceptedSourceReferences: {
    valid: number;
    total: number;
    rate: number;
    pass: boolean;
  };
  criticalErrors: {
    fabrication: number;
    polarityInversion: number;
    falseSufficient: number;
    total: number;
    pass: boolean;
  };
  adequacy: {
    perClass: Record<string, ConfusionCounts>;
    evaluatedClasses: string[];
    lowSampleClasses: string[];
    lowSampleWarning: boolean;
    macroF1: number;
    pass: boolean;
  };
  questions: {
    tp: number;
    fp: number;
    fn: number;
    tn: number;
    precision: number;
    recall: number;
    pass: boolean;
  };
  answerUse: {
    correct: number;
    total: number;
    rate: number;
    pass: boolean;
  };
  firstPassFormatValidity: {
    validFirstPass: number;
    attemptedTurns: number;
    rate: number;
    pass: boolean;
  };
  workflowCompletion: {
    successfulTurns: number;
    failedTurns: number;
    observedTurns: number;
    unexpectedTurns: number;
    expectedTurns: number;
    rate: number;
    pass: boolean;
  };
  automatedTechnicalPass: boolean;
};

export type QualityGateReport = {
  evaluatorVersion: string;
  thresholds: typeof QUALITY_GATE_THRESHOLDS;
  provisional: boolean;
  remainingCaseCount: number;
  excludedResumableTurns: number;
  editorAcceptance: {
    attempted: number;
    accepted: number;
    rate: number;
    pass: boolean;
  };
  rawModelOutput: LayerGateMetrics;
  postGuardRuntime: LayerGateMetrics;
  automatedGatePassed: boolean;
  reviewerSemanticAssessment: 'NOT_ESTABLISHED';
  releaseStatus:
    | 'PROVISIONAL_INCOMPLETE_STAGE'
    | 'AWAITING_BLINDED_HUMAN_REVIEW'
    | 'FAILED_AUTOMATED_GATE';
};

export function validateReleaseAssessmentCorpus(
  corpus: AssessmentCorpus,
  regressionIdsAndFamilies?: {
    ids: ReadonlySet<string>;
    families: ReadonlySet<string>;
  },
  options?: {
    minContradictoryTurns?: number;
  },
): AssessmentCorpus {
  if (
    corpus.classification !== 'synthetic-only' ||
    corpus.scenarios.length !== 60
  ) {
    throw Error('RELEASE_CORPUS_SIZE_OR_CLASSIFICATION_INVALID');
  }
  const splitCounts = { validation: 0, holdout: 0 };
  const turnCounts = { 1: 0, 2: 0, 3: 0 };
  const ids = new Set<string>();
  const familySplits = new Map<string, string>();
  const familyCounts = new Map<string, number>();
  const purposesSeen = new Set<string>();
  const actionsSeen = new Set<string>();
  let contradictoryTurns = 0;

  for (const c of corpus.scenarios) {
    if (
      !c.synthetic ||
      ids.has(c.id) ||
      (c.split !== 'validation' && c.split !== 'holdout') ||
      !Object.hasOwn(turnCounts, c.turns.length) ||
      !c.rubric.accepted.length ||
      !c.rubric.prohibited.length ||
      c.turns[0]?.action !== 'assess' ||
      !ASSESSMENT_PURPOSES.includes(c.purpose)
    ) {
      throw Error(`RELEASE_SCENARIO_INVALID:${c.id}`);
    }
    if (
      regressionIdsAndFamilies &&
      (regressionIdsAndFamilies.ids.has(c.id) ||
        regressionIdsAndFamilies.families.has(c.family))
    ) {
      throw Error(`RELEASE_REGRESSION_OVERLAP:${c.id}:${c.family}`);
    }
    if (familySplits.has(c.family) && familySplits.get(c.family) !== c.split) {
      throw Error(`RELEASE_FAMILY_SPLIT_LEAKAGE:${c.family}`);
    }
    familySplits.set(c.family, c.split);
    familyCounts.set(c.family, (familyCounts.get(c.family) ?? 0) + 1);
    ids.add(c.id);
    splitCounts[c.split]++;
    turnCounts[c.turns.length as 1 | 2 | 3]++;
    purposesSeen.add(c.purpose);

    if (
      c.sources.some(
        (s) =>
          !['TASK', 'NOTE', 'ANSWER'].includes(s.kind) ||
          typeof s.text !== 'string',
      ) ||
      new Set(c.sources.map((s) => s.id)).size !== c.sources.length
    ) {
      throw Error(`RELEASE_SOURCE_INVALID:${c.id}`);
    }

    for (const t of c.turns) {
      actionsSeen.add(t.action);
      const adeq = t.expected.noteAdequacy;
      const isSingleSufficient =
        adeq.length === 1 && adeq[0] === 'ENOUGH_FOR_PURPOSE';
      const isSingleContradictory =
        adeq.length === 1 && adeq[0] === 'CONTRADICTORY';
      if (isSingleContradictory) contradictoryTurns++;
      const isDisjointInsufficient =
        adeq.length >= 1 &&
        adeq.length <= 2 &&
        new Set(adeq).size === adeq.length &&
        adeq.every(
          (label) => label === 'NEEDS_AUTHOR_INPUT' || label === 'UNDETERMINED',
        );
      if (
        !t.expected.taskContextStatus.length ||
        !(
          isSingleSufficient ||
          isSingleContradictory ||
          isDisjointInsufficient
        ) ||
        !['required', 'none'].includes(t.expected.question)
      ) {
        throw Error(`RELEASE_DISJOINT_LABEL_REQUIRED:${c.id}`);
      }
      if (isSingleContradictory && t.expected.question !== 'none') {
        throw Error(`RELEASE_CONTRADICTORY_MUST_STOP_QUESTIONS:${c.id}`);
      }
      for (const pattern of [
        ...t.expected.questionTopicPatterns,
        ...t.expected.forbiddenAssertions,
      ]) {
        new RegExp(pattern, 'iu');
      }
    }
  }

  if (
    splitCounts.validation !== 20 ||
    splitCounts.holdout !== 40 ||
    familyCounts.size !== 30 ||
    [...familyCounts.values()].some((count) => count !== 2) ||
    turnCounts[1] !== 40 ||
    turnCounts[2] !== 12 ||
    turnCounts[3] !== 8 ||
    purposesSeen.size !== ASSESSMENT_PURPOSES.length
  ) {
    throw Error('RELEASE_CORPUS_DISTRIBUTION_INVALID');
  }

  for (const requiredAction of [
    'answer',
    'unknown',
    'skip',
    'correct',
    'reset',
  ]) {
    if (!actionsSeen.has(requiredAction)) {
      throw Error(`RELEASE_CORPUS_MISSING_ACTION:${requiredAction}`);
    }
  }

  if (
    typeof options?.minContradictoryTurns === 'number' &&
    contradictoryTurns < options.minContradictoryTurns
  ) {
    throw Error(
      `RELEASE_CORPUS_INSUFFICIENT_CONTRADICTORY:${contradictoryTurns}<${options.minContradictoryTurns}`,
    );
  }

  return corpus;
}

export function validateHistoryAssessmentCorpus(
  corpus: AssessmentCorpus,
): AssessmentCorpus {
  if (
    corpus.classification !== 'synthetic-only' ||
    corpus.scenarios.length === 0
  ) {
    throw Error('HISTORY_CORPUS_CLASSIFICATION_OR_SIZE_INVALID');
  }
  const ids = new Set<string>();
  const familySplits = new Map<string, string>();
  for (const c of corpus.scenarios) {
    if (
      !c.synthetic ||
      ids.has(c.id) ||
      !['development', 'validation', 'holdout'].includes(c.split) ||
      c.turns.length < 1 ||
      c.turns.length > 3 ||
      !c.rubric.accepted.length ||
      !c.rubric.prohibited.length ||
      c.turns[0]?.action !== 'assess' ||
      !ASSESSMENT_PURPOSES.includes(c.purpose)
    ) {
      throw Error(`HISTORY_SCENARIO_INVALID:${c.id}`);
    }
    if (familySplits.has(c.family) && familySplits.get(c.family) !== c.split) {
      throw Error(`HISTORY_FAMILY_SPLIT_LEAKAGE:${c.family}`);
    }
    familySplits.set(c.family, c.split);
    ids.add(c.id);
    const hasHistorySource = c.sources.some(
      (s) => s.kind === 'HISTORY' && Boolean(s.history),
    );
    if (
      !hasHistorySource ||
      c.sources.some(
        (s) =>
          !['TASK', 'NOTE', 'ANSWER', 'HISTORY'].includes(s.kind) ||
          typeof s.text !== 'string' ||
          (s.kind === 'HISTORY' && !s.history),
      ) ||
      new Set(c.sources.map((s) => s.id)).size !== c.sources.length
    ) {
      throw Error(`HISTORY_SOURCE_INVALID:${c.id}`);
    }
    for (const t of c.turns) {
      const adeq = t.expected.noteAdequacy;
      const isSingleSufficient =
        adeq.length === 1 && adeq[0] === 'ENOUGH_FOR_PURPOSE';
      const isSingleContradictory =
        adeq.length === 1 && adeq[0] === 'CONTRADICTORY';
      const isDisjointInsufficient =
        adeq.length >= 1 &&
        adeq.length <= 2 &&
        new Set(adeq).size === adeq.length &&
        adeq.every(
          (label) => label === 'NEEDS_AUTHOR_INPUT' || label === 'UNDETERMINED',
        );
      if (
        !t.expected.taskContextStatus.length ||
        !(
          isSingleSufficient ||
          isSingleContradictory ||
          isDisjointInsufficient
        ) ||
        !['required', 'none'].includes(t.expected.question)
      ) {
        throw Error(`HISTORY_DISJOINT_LABEL_REQUIRED:${c.id}`);
      }
      if (isSingleContradictory && t.expected.question !== 'none') {
        throw Error(`HISTORY_CONTRADICTORY_MUST_STOP_QUESTIONS:${c.id}`);
      }
      for (const pattern of [
        ...t.expected.questionTopicPatterns,
        ...t.expected.forbiddenAssertions,
      ]) {
        new RegExp(pattern, 'iu');
      }
    }
  }
  return corpus;
}

export function validateDevelopmentAssessmentCorpus(
  corpus: AssessmentCorpus,
): AssessmentCorpus {
  if (
    corpus.classification !== 'synthetic-only' ||
    corpus.scenarios.length === 0
  ) {
    throw Error('DEV_CORPUS_CLASSIFICATION_OR_SIZE_INVALID');
  }
  const ids = new Set<string>();
  for (const c of corpus.scenarios) {
    if (
      !c.synthetic ||
      ids.has(c.id) ||
      c.split !== 'development' ||
      c.turns.length < 1 ||
      c.turns.length > 3 ||
      !c.rubric.accepted.length ||
      !c.rubric.prohibited.length ||
      c.turns[0]?.action !== 'assess' ||
      !ASSESSMENT_PURPOSES.includes(c.purpose)
    ) {
      throw Error(`DEV_SCENARIO_INVALID:${c.id}`);
    }
    ids.add(c.id);
    if (
      c.sources.some(
        (s) =>
          !['TASK', 'NOTE', 'ANSWER', 'HISTORY'].includes(s.kind) ||
          typeof s.text !== 'string',
      ) ||
      new Set(c.sources.map((s) => s.id)).size !== c.sources.length
    ) {
      throw Error(`DEV_SOURCE_INVALID:${c.id}`);
    }
    for (const t of c.turns) {
      for (const pattern of [
        ...t.expected.questionTopicPatterns,
        ...t.expected.forbiddenAssertions,
      ]) {
        new RegExp(pattern, 'iu');
      }
    }
  }
  return corpus;
}

function canonicalAdequacyBucket(label: string): string {
  if (label === 'ENOUGH_FOR_PURPOSE') return 'SUFFICIENT';
  if (label === 'CONTRADICTORY') return 'CONTRADICTORY';
  if (label === 'NEEDS_AUTHOR_INPUT' || label === 'UNDETERMINED') {
    return 'INSUFFICIENT';
  }
  return label;
}

function safeRate(
  numerator: number,
  denominator: number,
  emptyValue = 1,
): number {
  return denominator === 0 ? emptyValue : numerator / denominator;
}

function computeLayerMetrics(
  layer: 'raw_model_output' | 'post_guard_runtime',
  rows: readonly AssessmentEvaluationRow[],
  scenariosById: ReadonlyMap<string, AssessmentScenario>,
): LayerGateMetrics {
  const analysisRows = rows.filter((r) => r.role === 'analysis' && !r.skipped);
  const nonBoundaryRows = analysisRows.filter((r) => !r.boundaryDenied);

  // Provider/transport and scripted dependency failures are workflow errors,
  // not evidence of a malformed model response. Parsed outputs retain the
  // legacy raw_model_output label; evaluatorVersion makes this explicit.
  const modelRows = nonBoundaryRows.filter(
    (r) =>
      Boolean(r.output || r.rawSyntheticResponse) ||
      (Boolean(r.errorCode) &&
        !/^(?:XKIRO_|SCRIPTED_|RESPONSE_CACHE_|HTTP_JOURNAL_|.*BUDGET)/u.test(
          r.errorCode!,
        )),
  );
  const observed = new Set(nonBoundaryRows.map((r) => `${r.caseId}:${r.turn}`));
  const expectedKeys = new Set(
    [...scenariosById.values()].flatMap((scenario) =>
      scenario.turns.flatMap((turn, index) =>
        turn.expected.boundaryError ? [] : [`${scenario.id}:${index + 1}`],
      ),
    ),
  );
  const unexpectedTurns = nonBoundaryRows.filter(
    (r) => !expectedKeys.has(`${r.caseId}:${r.turn}`),
  ).length;
  const successful = new Set(
    nonBoundaryRows
      .filter(
        (r) =>
          !r.errorCode && r.output && expectedKeys.has(`${r.caseId}:${r.turn}`),
      )
      .map((r) => `${r.caseId}:${r.turn}`),
  );
  const expectedTurns = [...scenariosById.values()].reduce(
    (n, scenario) =>
      n + scenario.turns.filter((t) => !t.expected.boundaryError).length,
    0,
  );
  const workflowCompletion = {
    successfulTurns: successful.size,
    failedTurns: nonBoundaryRows.filter((r) =>
      Boolean(
        r.errorCode || !r.output || !expectedKeys.has(`${r.caseId}:${r.turn}`),
      ),
    ).length,
    observedTurns: observed.size,
    unexpectedTurns,
    expectedTurns,
    rate: safeRate(successful.size, expectedTurns, 0),
    pass:
      expectedTurns > 0 &&
      unexpectedTurns === 0 &&
      successful.size === expectedTurns &&
      nonBoundaryRows.length === expectedTurns,
  };
  let validFirstPass = 0;
  let validRefs = 0;
  let totalRefs = 0;
  let fabrication = 0;
  let polarityInversion = 0;
  let falseSufficient = 0;

  const adequacyPairs: { expected: string; predicted: string }[] = [];
  let qTp = 0;
  let qFp = 0;
  let qFn = 0;
  let qTn = 0;

  let answerUseCorrect = 0;
  let answerUseTotal = 0;

  for (const row of nonBoundaryRows) {
    const scenario = scenariosById.get(row.caseId);
    const turn = scenario?.turns[row.turn - 1];
    if (!scenario || !turn) continue;

    const firstPassOk =
      !row.errorCode &&
      Boolean(row.output) &&
      (row.formattingRecovery?.length ?? 0) === 0;
    if (firstPassOk) {
      validFirstPass++;
    }

    const expectedAdequacy = turn.expected.noteAdequacy[0];
    const activeGrade =
      layer === 'raw_model_output' ? row.grade : row.runtimeGrade;
    const failures = new Set([
      ...(activeGrade?.failures ?? []),
      ...(row.errorCode ? [row.errorCode] : []),
    ]);

    if (row.errorCode || !row.output) {
      if (
        row.errorCode &&
        /INVALID_SOURCE_REFERENCE|INVENTED_REQUIREMENT|CLAIM_ORIGIN_MISMATCH|REQUIREMENT_IS_NOT_RESULT/u.test(
          row.errorCode,
        )
      ) {
        fabrication++;
      }
      if (row.errorCode && /POLARITY/u.test(row.errorCode)) {
        polarityInversion++;
      }
      adequacyPairs.push({
        expected: canonicalAdequacyBucket(expectedAdequacy),
        predicted: '__ERROR__',
      });
      if (turn.expected.question === 'required') qFn++;
      else qTn++;
      if (row.turn >= 2) answerUseTotal++;
      continue;
    }

    // Source reference validity on accepted output
    const sourceMap = new Map(
      (row.sources ?? scenario.sources).map((s) => [s.id, s]),
    );
    const refs = [
      ...row.output.taskUnderstanding.requirements.flatMap((r) => r.sourceRefs),
      ...row.output.claims.flatMap((c) => c.sourceRefs),
      ...row.output.coverage.flatMap((c) => c.sourceRefs),
      ...row.output.gaps.flatMap((g) => g.sourceRefs),
    ];
    for (const ref of refs) {
      totalRefs++;
      const src = sourceMap.get(ref.sourceId);
      if (
        src &&
        src.loadStatus === 'LOADED' &&
        src.includedInRequest &&
        ref.quote.trim().length > 0 &&
        src.text.includes(ref.quote)
      ) {
        validRefs++;
      }
    }

    // Critical errors
    if (
      [...failures].some((f) =>
        /SOURCE_REFERENCE_INVALID|INVENTED_REQUIREMENT|FORBIDDEN_ASSERTION|REQUIREMENT_FROM_NON_TASK_SOURCE|REQUIREMENT_FROM_STATUS|TASK_REQUIREMENT_USED_AS/u.test(
          f,
        ),
      )
    ) {
      fabrication++;
    }
    if ([...failures].some((f) => /POLARITY/u.test(f))) {
      polarityInversion++;
    }

    const predictedAdequacy =
      layer === 'raw_model_output'
        ? row.output.noteAdequacy
        : (row.runtimeState?.noteAdequacy ?? row.output.noteAdequacy);

    if (
      !turn.expected.noteAdequacy.includes('ENOUGH_FOR_PURPOSE') &&
      predictedAdequacy === 'ENOUGH_FOR_PURPOSE'
    ) {
      falseSufficient++;
    }

    // Adequacy macro-F1 across the 3 disjoint semantic adequacy buckets
    // (SUFFICIENT, INSUFFICIENT, CONTRADICTORY), while still penalizing any
    // disallowed subtype (e.g. UNDETERMINED when only NEEDS_AUTHOR_INPUT is allowed).
    const expectedBucket = canonicalAdequacyBucket(expectedAdequacy);
    const allowedMatch = turn.expected.noteAdequacy.includes(
      predictedAdequacy as typeof row.output.noteAdequacy,
    );
    const predictedBucket = allowedMatch
      ? expectedBucket
      : canonicalAdequacyBucket(predictedAdequacy) === expectedBucket
        ? '__DISALLOWED_SUBTYPE__'
        : canonicalAdequacyBucket(predictedAdequacy);
    adequacyPairs.push({
      expected: expectedBucket,
      predicted: predictedBucket,
    });

    // Question precision & recall
    const hasQuestion =
      layer === 'raw_model_output'
        ? row.output.nextQuestion !== null
        : row.output.nextQuestion !== null &&
          row.runtimeState?.state === 'waiting_for_answer';
    const questionQualityOk =
      !failures.has('QUESTION_GAP_KIND') &&
      !failures.has('QUESTION_NEED_CODE') &&
      !failures.has('QUESTION_RELEVANCE') &&
      !failures.has('RESOLVED_OR_DECLINED_GAP_REPEATED');

    if (turn.expected.question === 'required') {
      if (hasQuestion && questionQualityOk) {
        qTp++;
      } else if (hasQuestion && !questionQualityOk) {
        // Asking the wrong/irrelevant question counts as both a false positive question and a missed required question
        qFp++;
        qFn++;
      } else {
        qFn++;
      }
    } else if (turn.expected.question === 'none') {
      if (hasQuestion) qFp++;
      else qTn++;
    } else {
      // 'optional' in legacy regression corpus
      if (hasQuestion && !questionQualityOk) qFp++;
      else qTn++;
    }

    // Multi-turn answer usage accuracy
    if (row.turn >= 2) {
      answerUseTotal++;
      const repeatedDeclined = failures.has(
        'RESOLVED_OR_DECLINED_GAP_REPEATED',
      );
      const unnecessaryFollowup =
        ['unknown', 'skip'].includes(turn.action) && hasQuestion;
      const missedGroundedFact =
        (turn.action === 'answer' || turn.action === 'correct') &&
        (failures.has('REPORTED_FACTS_OMITTED') ||
          failures.has('NOTE_ADEQUACY'));
      const resetFailed =
        turn.action === 'reset' && failures.has('NOTE_ADEQUACY');
      if (
        !repeatedDeclined &&
        !unnecessaryFollowup &&
        !missedGroundedFact &&
        !resetFailed
      ) {
        answerUseCorrect++;
      }
    }
  }

  const classes = [...new Set(adequacyPairs.map((p) => p.expected))].sort();
  const perClass: Record<string, ConfusionCounts> = {};
  for (const cls of classes) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const pair of adequacyPairs) {
      if (pair.expected === cls && pair.predicted === cls) tp++;
      else if (pair.expected !== cls && pair.predicted === cls) fp++;
      else if (pair.expected === cls && pair.predicted !== cls) fn++;
    }
    const n = tp + fn;
    const precision = safeRate(tp, tp + fp, 0);
    const recall = safeRate(tp, tp + fn, 0);
    const f1 =
      precision + recall === 0
        ? 0
        : (2 * precision * recall) / (precision + recall);
    perClass[cls] = { n, tp, fp, fn, precision, recall, f1 };
  }
  const lowSampleClasses = classes.filter(
    (cls) => perClass[cls].n < LOW_SAMPLE_CLASS_THRESHOLD,
  );
  const lowSampleWarning = lowSampleClasses.length > 0;
  const macroF1 = classes.length
    ? classes.reduce((sum, cls) => sum + perClass[cls].f1, 0) / classes.length
    : 0;

  const refRate = safeRate(validRefs, totalRefs, 1);
  const criticalTotal = fabrication + polarityInversion + falseSufficient;
  const qPrecision = safeRate(qTp, qTp + qFp, 1);
  const qRecall = safeRate(qTp, qTp + qFn, 1);
  const answerRate = safeRate(answerUseCorrect, answerUseTotal, 1);
  const formatRate = safeRate(validFirstPass, modelRows.length, 0);

  const acceptedSourceReferences = {
    valid: validRefs,
    total: totalRefs,
    rate: refRate,
    pass: refRate >= QUALITY_GATE_THRESHOLDS.acceptedSourceReferenceValidity,
  };
  const criticalErrors = {
    fabrication,
    polarityInversion,
    falseSufficient,
    total: criticalTotal,
    pass: criticalTotal <= QUALITY_GATE_THRESHOLDS.maxCriticalErrors,
  };
  const adequacy = {
    perClass,
    evaluatedClasses: classes,
    lowSampleClasses,
    lowSampleWarning,
    macroF1,
    pass: macroF1 >= QUALITY_GATE_THRESHOLDS.adequacyMacroF1,
  };
  const questions = {
    tp: qTp,
    fp: qFp,
    fn: qFn,
    tn: qTn,
    precision: qPrecision,
    recall: qRecall,
    pass:
      qPrecision >= QUALITY_GATE_THRESHOLDS.questionPrecision &&
      qRecall >= QUALITY_GATE_THRESHOLDS.questionRecall,
  };
  const answerUse = {
    correct: answerUseCorrect,
    total: answerUseTotal,
    rate: answerRate,
    pass: answerRate >= QUALITY_GATE_THRESHOLDS.answerUsageAccuracy,
  };
  const firstPassFormatValidity = {
    validFirstPass,
    attemptedTurns: modelRows.length,
    rate: formatRate,
    pass: formatRate >= QUALITY_GATE_THRESHOLDS.firstPassFormatValidity,
  };

  return {
    layer,
    evaluatedTurns: nonBoundaryRows.length,
    acceptedSourceReferences,
    criticalErrors,
    adequacy,
    questions,
    answerUse,
    firstPassFormatValidity,
    workflowCompletion,
    automatedTechnicalPass:
      acceptedSourceReferences.pass &&
      criticalErrors.pass &&
      adequacy.pass &&
      questions.pass &&
      answerUse.pass &&
      firstPassFormatValidity.pass,
  };
}

export function computeAssessmentQualityGate(
  rows: readonly AssessmentEvaluationRow[],
  corpus: AssessmentCorpus,
  options?: {
    remainingCaseIds?: readonly string[];
    resumableErrorCodes?: ReadonlySet<string>;
    strictRelease?: boolean;
  },
): QualityGateReport {
  const scenariosById = new Map(corpus.scenarios.map((s) => [s.id, s]));
  const remainingSet = new Set(options?.remainingCaseIds ?? []);
  const provisional = remainingSet.size > 0;
  const resumableCodes =
    options?.resumableErrorCodes ?? RESUMABLE_TRANSPORT_ERROR_CODES;

  let excludedResumableTurns = 0;
  const effectiveRows = provisional
    ? rows.filter((row) => {
        if (row.role !== 'analysis') return true;
        if (
          row.skipped === true ||
          remainingSet.has(row.caseId) ||
          (typeof row.errorCode === 'string' &&
            resumableCodes.has(row.errorCode))
        ) {
          if (!row.skipped) excludedResumableTurns++;
          return false;
        }
        return true;
      })
    : rows;

  const rawModelOutput = computeLayerMetrics(
    'raw_model_output',
    effectiveRows,
    scenariosById,
  );
  const postGuardRuntime = computeLayerMetrics(
    'post_guard_runtime',
    effectiveRows,
    scenariosById,
  );
  const editors = effectiveRows.filter(
    (r) => r.role === 'editor' && !r.skipped,
  );
  const acceptedEditors = editors.filter(
    (r) => !r.errorCode && r.editorValidation?.runtimeProposalAccepted === true,
  ).length;
  const editorRate = safeRate(acceptedEditors, editors.length, 0);
  const editorAcceptance = {
    attempted: editors.length,
    accepted: acceptedEditors,
    rate: editorRate,
    pass:
      editors.length > 0 &&
      editorRate >= QUALITY_GATE_THRESHOLDS.editorAcceptance,
  };
  const automatedGatePassed =
    !provisional &&
    postGuardRuntime.automatedTechnicalPass &&
    (!options?.strictRelease ||
      (editorAcceptance.pass &&
        postGuardRuntime.workflowCompletion.pass &&
        ['CONTRADICTORY', 'INSUFFICIENT', 'SUFFICIENT'].every(
          (c) =>
            (postGuardRuntime.adequacy.perClass[c]?.n ?? 0) >=
            LOW_SAMPLE_CLASS_THRESHOLD,
        )));
  return {
    evaluatorVersion: EVALUATOR_VERSION,
    thresholds: QUALITY_GATE_THRESHOLDS,
    provisional,
    remainingCaseCount: remainingSet.size,
    excludedResumableTurns,
    editorAcceptance,
    rawModelOutput,
    postGuardRuntime,
    automatedGatePassed,
    reviewerSemanticAssessment: 'NOT_ESTABLISHED',
    releaseStatus: provisional
      ? 'PROVISIONAL_INCOMPLETE_STAGE'
      : automatedGatePassed
        ? 'AWAITING_BLINDED_HUMAN_REVIEW'
        : 'FAILED_AUTOMATED_GATE',
  };
}

export type BlindedTranscriptItem = {
  blindTranscriptId: string;
  turnCount: number;
  purpose: string;
  rubric: AssessmentScenario['rubric'];
  turns: {
    turn: number;
    action: string;
    sources: AssessmentScenario['sources'];
    answers: AssessmentEvaluationRow['answers'];
    modelOutput: AssessmentEvaluationRow['output'] | null;
    runtimeState: AssessmentEvaluationRow['runtimeState'] | null;
  }[];
  editorProposal: AssessmentEvaluationRow['editorOutput'] | null;
  ratings: {
    taskUnderstanding: 'PASS' | 'FAIL' | null;
    purposeAdequacy: 'PASS' | 'FAIL' | null;
    claimSupportAndPolarity: 'PASS' | 'FAIL' | null;
    questionNecessityAndUtility: 'PASS' | 'FAIL' | null;
    answerUseAndUncertaintyPreservation: 'PASS' | 'FAIL' | null;
  };
  reviewerId: string | null;
  reviewedAt: string | null;
  notes: string | null;
};

export type BlindedReviewKeyEntry = {
  blindTranscriptId: string;
  variantLabel: string;
  reportId: string;
  caseId: string;
  split: string;
  family: string;
};

export function makeBlindedReviewPack(
  runs: readonly {
    variantLabel: string;
    reportId: string;
    rows: readonly AssessmentEvaluationRow[];
  }[],
  corpus: AssessmentCorpus,
  salt = 'plan-v3-blinded-review',
): {
  blindedWorksheet: {
    classification: 'BLINDED_HUMAN_TRANSCRIPT_REVIEW_WORKSHEET';
    semanticAcceptance: 'NOT_ESTABLISHED';
    instructions: string;
    items: BlindedTranscriptItem[];
  };
  sealedKey: {
    classification: 'SEALED_BLINDED_REVIEW_KEY_DO_NOT_SHARE_WITH_REVIEWERS';
    entries: BlindedReviewKeyEntry[];
  };
} {
  const scenariosById = new Map(corpus.scenarios.map((s) => [s.id, s]));
  const rawEntries = runs.flatMap((run) => {
    const caseIds = [...new Set(run.rows.map((r) => r.caseId))];
    return caseIds.map((caseId) => {
      const scenario = scenariosById.get(caseId);
      if (!scenario) throw Error(`BLIND_UNKNOWN_CASE:${caseId}`);
      const caseRows = run.rows.filter(
        (r) => r.caseId === caseId && !r.skipped,
      );
      const orderDigest = createHash('sha256')
        .update(`${salt}:${run.variantLabel}:${run.reportId}:${caseId}`)
        .digest('hex');
      return {
        orderDigest,
        variantLabel: run.variantLabel,
        reportId: run.reportId,
        scenario,
        caseRows,
      };
    });
  });

  rawEntries.sort((a, b) => a.orderDigest.localeCompare(b.orderDigest));

  const items: BlindedTranscriptItem[] = [];
  const keyEntries: BlindedReviewKeyEntry[] = [];

  rawEntries.forEach((entry, idx) => {
    const blindTranscriptId = `blind-${String(idx + 1).padStart(4, '0')}`;
    const analysisRows = entry.caseRows
      .filter((r) => r.role === 'analysis')
      .sort((a, b) => a.turn - b.turn);
    const editorRow = entry.caseRows.find((r) => r.role === 'editor');

    items.push({
      blindTranscriptId,
      turnCount: analysisRows.length,
      purpose: entry.scenario.purpose,
      rubric: entry.scenario.rubric,
      turns: analysisRows.map((r) => ({
        turn: r.turn,
        action: entry.scenario.turns[r.turn - 1]?.action ?? 'assess',
        sources: r.sources ?? entry.scenario.sources,
        answers: r.answers ?? [],
        modelOutput: r.output ?? null,
        runtimeState: r.runtimeState ?? null,
      })),
      editorProposal: editorRow?.editorOutput ?? null,
      ratings: {
        taskUnderstanding: null,
        purposeAdequacy: null,
        claimSupportAndPolarity: null,
        questionNecessityAndUtility: null,
        answerUseAndUncertaintyPreservation: null,
      },
      reviewerId: null,
      reviewedAt: null,
      notes: null,
    });

    keyEntries.push({
      blindTranscriptId,
      variantLabel: entry.variantLabel,
      reportId: entry.reportId,
      caseId: entry.scenario.id,
      split: entry.scenario.split,
      family: entry.scenario.family,
    });
  });

  return {
    blindedWorksheet: {
      classification: 'BLINDED_HUMAN_TRANSCRIPT_REVIEW_WORKSHEET',
      semanticAcceptance: 'NOT_ESTABLISHED',
      instructions:
        'Grade each transcript strictly against the Task sources, author note/answers, and purpose rubric without knowing which model/prompt/architecture produced it. Silence, Save, Apply, or LLM-judge hints do not establish semantic acceptance.',
      items,
    },
    sealedKey: {
      classification: 'SEALED_BLINDED_REVIEW_KEY_DO_NOT_SHARE_WITH_REVIEWERS',
      entries: keyEntries,
    },
  };
}

export type AdjudicationInput = {
  blindTranscriptId: string;
  adjudicatorId: string;
  finalDecision: 'PASS' | 'FAIL';
  rationale: string;
};

export function adjudicateBlindedReviews(params: {
  reviewerA: readonly BlindedTranscriptItem[];
  reviewerB: readonly BlindedTranscriptItem[];
  adjudications?: readonly AdjudicationInput[];
}): {
  totalItems: number;
  completedPairs: number;
  agreementCount: number;
  disagreementIds: string[];
  unresolvedDisagreementIds: string[];
  semanticPassCount: number;
  reviewerSemanticAssessment: 'ESTABLISHED_BY_HUMAN_REVIEW' | 'NOT_ESTABLISHED';
} {
  const byIdB = new Map(
    params.reviewerB.map((item) => [item.blindTranscriptId, item]),
  );
  const adjById = new Map(
    (params.adjudications ?? []).map((a) => [a.blindTranscriptId, a]),
  );

  const itemOverall = (item: BlindedTranscriptItem): 'PASS' | 'FAIL' | null => {
    if (!item.reviewerId || item.reviewerId.startsWith('model:')) return null;
    const vals = Object.values(item.ratings);
    if (vals.some((v) => v === null)) return null;
    return vals.every((v) => v === 'PASS') ? 'PASS' : 'FAIL';
  };

  let completedPairs = 0;
  let agreementCount = 0;
  let semanticPassCount = 0;
  const disagreementIds: string[] = [];
  const unresolvedDisagreementIds: string[] = [];

  for (const a of params.reviewerA) {
    const b = byIdB.get(a.blindTranscriptId);
    if (!b || a.reviewerId === b.reviewerId) continue;
    const decA = itemOverall(a);
    const decB = itemOverall(b);
    if (!decA || !decB) continue;
    completedPairs++;
    if (decA === decB) {
      agreementCount++;
      if (decA === 'PASS') semanticPassCount++;
    } else {
      disagreementIds.push(a.blindTranscriptId);
      const adj = adjById.get(a.blindTranscriptId);
      if (
        !adj ||
        !adj.adjudicatorId ||
        adj.adjudicatorId.startsWith('model:') ||
        !adj.rationale.trim()
      ) {
        unresolvedDisagreementIds.push(a.blindTranscriptId);
      } else if (adj.finalDecision === 'PASS') {
        semanticPassCount++;
      }
    }
  }

  const allEstablished =
    params.reviewerA.length > 0 &&
    completedPairs === params.reviewerA.length &&
    unresolvedDisagreementIds.length === 0;

  return {
    totalItems: params.reviewerA.length,
    completedPairs,
    agreementCount,
    disagreementIds,
    unresolvedDisagreementIds,
    semanticPassCount,
    reviewerSemanticAssessment: allEstablished
      ? 'ESTABLISHED_BY_HUMAN_REVIEW'
      : 'NOT_ESTABLISHED',
  };
}
