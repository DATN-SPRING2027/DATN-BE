import { randomUUID } from 'node:crypto';
import { hasNoNewInformation } from './work-note-assessment.context';
import {
  assessmentHash,
  ASSESSMENT_PROMPT_VERSION,
} from './work-note-assessment.protocol';
import {
  classifyGapNeedCode,
  extractGapNeedCode,
  isAssessmentNeedCode,
  type AssessmentNeedCode,
} from './work-note-assessment.rubric';
import type {
  AssessmentModelInput,
  AssessmentModelOutput,
  AssessmentPurpose,
  AssessmentView,
  AssessmentGap,
  SourceRef,
} from './work-note-assessment.types';
const norm = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
function targetKey(s: string) {
  const n = norm(s)
    .replace(/\bmoi truong\b|\benv\b/g, 'environment')
    .replace(/\bkiem thu\b|\btests?\b/g, 'testing')
    .replace(/\bket qua\b/g, 'result');
  const tokens = n
    .split(' ')
    .filter(
      (word) =>
        !/^(which|what|where|the|a|an|of|for|in|on|did|you|was|used|use|da|dung|de|nao|gi|la|cua|cho|khi)$/.test(
          word,
        ),
    );
  // Keep entities such as authentication/billing; only generic environment
  // wording ignores the redundant testing qualifier.
  return [
    ...new Set(
      tokens.filter(
        (w) => !(tokens.includes('environment') && w === 'testing'),
      ),
    ),
  ]
    .sort()
    .join(' ');
}
const anchorKey = (refs: SourceRef[]) =>
  refs
    .filter((r) => !r.sourceId.startsWith('answer.'))
    .map((r) => `${r.sourceId}:${norm(r.quote)}`)
    .sort();
type GapLike = Pick<
  AssessmentGap,
  'kind' | 'owner' | 'target' | 'sourceRefs'
> & {
  needCode?: string;
};
const resolveNeed = (
  g: GapLike,
  purpose?: AssessmentPurpose,
): AssessmentNeedCode =>
  classifyGapNeedCode(
    {
      kind: g.kind,
      owner: g.owner,
      target: g.target,
      ...(isAssessmentNeedCode(g.needCode) ? { needCode: g.needCode } : {}),
    },
    purpose,
  );
const gapKey = (g: GapLike, purpose?: AssessmentPurpose) => {
  const need = resolveNeed(g, purpose);
  const digest = assessmentHash([
    g.owner,
    need,
    targetKey(g.target),
    anchorKey(g.sourceRefs),
  ]).slice(0, 16);
  return `${need}-${digest}`;
};
const legacySignature = (
  g: Pick<AssessmentGap, 'owner' | 'target' | 'sourceRefs'>,
) =>
  assessmentHash([g.owner, targetKey(g.target), anchorKey(g.sourceRefs)]).slice(
    0,
    24,
  );
const gapMatchesId = (
  g: Pick<AssessmentGap, 'id' | 'owner' | 'target' | 'sourceRefs'>,
  candidateId?: string,
) =>
  !!candidateId &&
  (g.id === candidateId || `gap-${legacySignature(g)}` === candidateId);
const contentWords = (s: string) =>
  new Set(
    norm(s)
      .split(' ')
      .filter(
        (w) =>
          w.length > 2 &&
          !/^(the|and|for|that|this|was|were|with|have|has|been|not|toi|roi|cua|cho|mot|cac|nhung|kiem|thu|test|tests|testing|result|environment)$/.test(
            w,
          ),
      ),
  );
const replyWordsOf = (s: string) =>
  new Set(
    norm(s)
      .split(' ')
      .filter(
        (w) =>
          w.length > 2 &&
          !/^(the|and|for|that|this|was|were|with|have|has|been|not|toi|roi|cua|cho|mot|cac|nhung)$/.test(
            w,
          ),
      ),
  );
const NEED_ANSWER_CUES: Record<AssessmentNeedCode, string> = {
  'task.criteria': 'tieu chi pham vi muc tieu requirement criteria scope',
  'purpose.intent': 'muc dich ghi chu progress incident decision qa handover',
  'scope.completed_part': 'phan hang muc module api man hinh component',
  'implementation.mechanism': 'cau hinh config nguon data api ham service',
  'decision.choice': 'chon phuong an dung su dung option approach',
  'decision.rationale': 'ly do rang buoc tranh giam tang latency chi phi',
  'incident.symptom': 'loi error status timeout crash hien tuong',
  'test_context.actor':
    'actor vai tro tai khoan user admin member leader tac gia ngoai project account role',
  'test_context.scenario':
    'environment moi truong local staging production prod browser file input case',
  'test_result.behavior':
    'ket qua pass fail passed failed thanh cong tu choi tra loi status behavior',
  'handover.next_steps':
    'tiep tuc van hanh chay lenh config theo doi buoc tiep nhan',
  'contradiction.conflict': 'nham sua lai thuc te dung',
};
const overlaps = (a: Set<string>, b: Set<string>) =>
  [...a].some((w) => b.has(w));
function disjointNoteQuotes(aRefs: SourceRef[], bRefs: SourceRef[]): boolean {
  const aNotes = aRefs
    .filter((r) => r.sourceId.startsWith('note.'))
    .map((r) => norm(r.quote))
    .filter(Boolean);
  const bNotes = bRefs
    .filter((r) => r.sourceId.startsWith('note.'))
    .map((r) => norm(r.quote))
    .filter(Boolean);
  if (!aNotes.length || !bNotes.length) return false;
  return !aNotes.some((qa) =>
    bNotes.some(
      (qb) =>
        qa.includes(qb) ||
        qb.includes(qa) ||
        overlaps(contentWords(qa), contentWords(qb)),
    ),
  );
}
const coverageRank = (status: string) =>
  status === 'SUPPORTED' ? 2 : status === 'PARTIAL' ? 1 : 0;
export function assessmentActions(v: AssessmentView): string[] {
  const a = ['correct', 'reset', 'feedback', 'manual'];
  if (!['stale', 'error', 'analyzing'].includes(v.state))
    a.push('validate_author');
  if (v.state === 'waiting_for_answer' && v.nextQuestion) a.push('reply');
  if (
    ![
      'stale',
      'contradiction',
      'analyzing',
      'error',
      'waiting_for_answer',
    ].includes(v.state)
  )
    a.push('rewrite');
  return a;
}
export function staleAssessment(
  v: AssessmentView,
  reason = 'SOURCE_CHANGED',
): AssessmentView {
  const n = {
    ...v,
    state: 'stale' as const,
    nextQuestion: null,
    authorValidated: false,
    signals: { ...v.signals, authorValidated: false },
    trace: [
      ...v.trace,
      { phase: 'stale', reasonCode: reason, at: new Date().toISOString() },
    ].slice(-40),
  };
  n.allowedActions = assessmentActions(n);
  return n;
}
export function assembleAssessment(
  input: AssessmentModelInput,
  out: AssessmentModelOutput,
  meta: {
    sourceRevision: number;
    taskContextHash: string;
    model: string;
    expiresAt: string;
    promptVersion?: string;
  },
): AssessmentView {
  const prior = input.previous,
    now = new Date().toISOString();
  const requirements = out.taskUnderstanding.requirements.map((r) => ({
    ...r,
    id: `req-${assessmentHash(r.sourceRefs).slice(0, 24)}`,
  }));
  const claims = out.claims.map((c) => ({
    ...c,
    id: `claim-${assessmentHash([c.text, c.sourceRefs]).slice(0, 24)}`,
    verificationStatus:
      c.originKind === 'AUTHOR_REPORT'
        ? ('AUTHOR_REPORTED' as const)
        : ('NOT_INDEPENDENTLY_VERIFIED' as const),
  }));
  const correctionAnswer =
    input.correction &&
    input.answers.find(
      (a) =>
        a.gapId === input.correction!.targetId &&
        a.answer === input.correction!.text &&
        a.purpose === out.purpose &&
        a.taskContextHash === meta.taskContextHash &&
        !hasNoNewInformation(a) &&
        !prior?.answers.some((p) => p.id === a.id),
    );
  const correctionGrounded =
    !!correctionAnswer &&
    claims.some(
      (c) =>
        c.originKind === 'AUTHOR_REPORT' &&
        c.supportRelation === 'FULL' &&
        c.sourceRefs.some(
          (r) =>
            r.sourceId === `answer.${correctionAnswer.id}` &&
            input.sources.some(
              (s) =>
                s.id === r.sourceId &&
                s.kind === 'ANSWER' &&
                s.loadStatus === 'LOADED' &&
                s.includedInRequest &&
                s.text === correctionAnswer.answer &&
                s.text.includes(r.quote),
            ),
        ),
    );
  const completeCorrection =
    correctionGrounded &&
    (out.purpose === 'COMPLETION'
      ? out.taskContextStatus === 'CLEAR' &&
        requirements.length > 0 &&
        out.coverage.length === requirements.length &&
        out.coverage.every((c) => c.status === 'SUPPORTED') &&
        out.coverage.some((c) =>
          c.sourceRefs.some(
            (r) => r.sourceId === `answer.${correctionAnswer.id}`,
          ),
        )
      : out.noteAdequacy === 'ENOUGH_FOR_PURPOSE' &&
        !out.gaps.some((g) => g.impact === 'BLOCKING'));
  const gaps: AssessmentGap[] = out.gaps.map((g) => {
    // Classification is not identity. Preserve old IDs across prompt versions,
    // kind changes, and re-anchored needCodes on the same author statement.
    const currentNeed = resolveNeed(g, out.purpose);
    const currentKey = gapKey(g, out.purpose);
    const currentLegacy = legacySignature(g);
    const matchedPrior = prior?.gaps.find(
      (p) =>
        gapKey(p, prior.purpose) === currentKey ||
        legacySignature(p) === currentLegacy,
    );
    const declinedSibling = !matchedPrior
      ? prior?.gaps.find((p) => {
          const priorNeed =
            extractGapNeedCode(p.id) ?? resolveNeed(p, prior.purpose);
          if (p.owner !== g.owner || priorNeed !== currentNeed) return false;
          if (disjointNoteQuotes(p.sourceRefs, g.sourceRefs)) return false;
          const priorAns = [...input.answers]
            .reverse()
            .find((a) => gapMatchesId(p, a.gapId));
          return (
            p.status === 'unknown' ||
            p.status === 'skipped' ||
            (!!priorAns &&
              (priorAns.disposition === 'unknown' ||
                priorAns.disposition === 'skipped' ||
                hasNoNewInformation(priorAns)))
          );
        })
      : undefined;
    const id = matchedPrior?.id ?? declinedSibling?.id ?? `gap-${currentKey}`;
    const answer = [...input.answers]
      .reverse()
      .find(
        (a) =>
          a.gapId === id ||
          a.gapId === `gap-${currentLegacy}` ||
          (!!matchedPrior && gapMatchesId(matchedPrior, a.gapId)) ||
          (!!declinedSibling && gapMatchesId(declinedSibling, a.gapId)),
      );
    const priorGap = prior?.gaps.find((p) => p.id === id);
    const status: AssessmentGap['status'] =
      answer && hasNoNewInformation(answer) && answer.disposition !== 'skipped'
        ? 'unknown'
        : answer?.disposition === 'skipped'
          ? 'skipped'
          : priorGap?.status === 'answered'
            ? 'answered'
            : priorGap?.status === 'unknown' && !correctionGrounded
              ? 'unknown'
              : priorGap?.status === 'skipped' && !correctionGrounded
                ? 'skipped'
                : 'open';
    return {
      id,
      kind: g.kind,
      target: g.target,
      impact: g.impact,
      owner: g.owner,
      status,
      sourceRefs: g.sourceRefs,
    };
  });
  for (const g of prior?.gaps ?? []) {
    if (gaps.some((x) => x.id === g.id)) continue;
    const a = [...input.answers]
      .reverse()
      .find((x) => gapMatchesId(g, x.gapId));
    if (a)
      gaps.push({
        ...g,
        status:
          correctionGrounded &&
          g.owner === 'NOTE_AUTHOR' &&
          out.noteAdequacy === 'ENOUGH_FOR_PURPOSE' &&
          (gapMatchesId(g, input.correction?.targetId) || completeCorrection)
            ? 'answered'
            : a.disposition === 'skipped'
              ? 'skipped'
              : hasNoNewInformation(a)
                ? 'unknown'
                : 'answered',
      });
    else if (g.status !== 'open')
      gaps.push({
        ...g,
        status:
          correctionGrounded &&
          g.owner === 'NOTE_AUTHOR' &&
          out.noteAdequacy === 'ENOUGH_FOR_PURPOSE' &&
          completeCorrection
            ? 'answered'
            : g.status,
      });
  }
  const coverage = out.coverage.map((c) => ({
    requirementId: requirements[c.requirementIndex].id,
    status: c.status,
    sourceRefs: c.sourceRefs,
  }));
  const priorFacts = new Set(
    prior?.claims
      .filter(
        (c) => c.originKind === 'AUTHOR_REPORT' && c.supportRelation === 'FULL',
      )
      .map((c) => norm(c.text)) ?? [],
  );
  // This is a conservative novelty/relevance guard, not a semantic verifier.
  // New relevant replies or explicitly targeted, grounded corrections can reset the loop.
  const relevantReplies = input.answers.filter((a) => {
    const gap = prior?.gaps.find(
      (g) => gapMatchesId(g, a.gapId) && g.status === 'open',
    );
    const text = norm(a.answer ?? '');
    if (
      a.disposition !== 'answered' ||
      hasNoNewInformation(a) ||
      a.purpose !== prior?.purpose ||
      a.taskContextHash !== meta.taskContextHash ||
      !text ||
      replyWordsOf(text).size < 2 ||
      prior?.answers.some((p) => p.id === a.id || norm(p.answer ?? '') === text)
    )
      return false;
    const targetedCorrection =
      input.correction &&
      a.gapId === input.correction.targetId &&
      a.answer === input.correction.text &&
      (prior?.claims.some((x) => x.id === input.correction!.targetId) ||
        prior?.gaps.some((x) => gapMatchesId(x, input.correction!.targetId)));
    if (targetedCorrection) return true;
    if (!gap) return false;
    const gapNeed =
      extractGapNeedCode(gap.id) ?? resolveNeed(gap, prior?.purpose);
    const context = replyWordsOf(
      [
        gap.target,
        NEED_ANSWER_CUES[gapNeed],
        prior?.nextQuestion?.gapId === gap.id ? prior.nextQuestion.text : '',
        ...gap.sourceRefs.map((r) => r.quote),
        ...prior.taskUnderstanding.requirements.map((r) => r.text),
      ].join(' '),
    );
    const replyWords = replyWordsOf(text);
    return !context.size || overlaps(context, replyWords);
  });
  const replyGrounds = (refs: SourceRef[]) =>
    refs.some((r) =>
      relevantReplies.some((a) => {
        if (r.sourceId !== `answer.${a.id}`) return false;
        return input.sources.some(
          (s) =>
            s.id === r.sourceId &&
            s.kind === 'ANSWER' &&
            s.loadStatus === 'LOADED' &&
            s.includedInRequest &&
            s.text === a.answer &&
            s.text.includes(r.quote),
        );
      }),
    );
  const newFacts = claims.some(
    (c) =>
      c.originKind === 'AUTHOR_REPORT' &&
      c.supportRelation === 'FULL' &&
      !priorFacts.has(norm(c.text)) &&
      replyGrounds(c.sourceRefs) &&
      relevantReplies.some((a) =>
        overlaps(replyWordsOf(c.text), replyWordsOf(a.answer ?? '')),
      ),
  );
  // Hash-only trace metadata records observed coverage high water without
  // introducing persistent contract fields or retaining answer text in trace.
  const coverageTrace: AssessmentView['trace'] = [];
  const coverageImprovements = coverage.map((c) => {
    const requirement = requirements.find((r) => r.id === c.requirementId)!;
    const key = assessmentHash(anchorKey(requirement.sourceRefs)).slice(0, 24);
    const prefix = `COVERAGE_HIGH_WATER:${key}:`;
    const priorRequirement = prior?.taskUnderstanding.requirements.find(
      (r) => assessmentHash(anchorKey(r.sourceRefs)).slice(0, 24) === key,
    );
    const oldRank = Math.max(
      0,
      ...(prior?.trace ?? [])
        .filter((t) => t.reasonCode.startsWith(prefix))
        .map((t) => Number(t.reasonCode.slice(prefix.length))),
      ...(prior?.coverage ?? [])
        .filter((p) => p.requirementId === priorRequirement?.id)
        .map((p) => coverageRank(p.status)),
    );
    const rank = coverageRank(c.status);
    if (rank > oldRank)
      coverageTrace.push({
        phase: 'coverage',
        reasonCode: `${prefix}${rank}`,
        at: now,
      });
    return !!prior && rank > oldRank && replyGrounds(c.sourceRefs);
  });
  const coverageImproved = coverageImprovements.some(Boolean);
  const noProgress = prior
    ? newFacts || coverageImproved
      ? 0
      : prior.counters.noProgress + 1
    : 0;
  const unresolved = gaps.some(
    (g) => g.impact === 'BLOCKING' && g.status !== 'answered',
  );
  const rawHasBlocking = out.gaps.some((g) => g.impact === 'BLOCKING');
  const rawInconsistentEnough =
    out.noteAdequacy === 'ENOUGH_FOR_PURPOSE' &&
    (rawHasBlocking || out.nextQuestion !== null);
  let noteAdequacy = out.noteAdequacy;
  const fullyGrounded =
    claims.some(
      (c) => c.originKind === 'AUTHOR_REPORT' && c.supportRelation === 'FULL',
    ) && claims.every((c) => c.supportRelation === 'FULL');
  if (rawInconsistentEnough) {
    // Plan v3 §5: inconsistent model output falls back to UNDETERMINED with
    // manual editing rather than fabricating adequacy or asking a contradictory question.
    noteAdequacy = 'UNDETERMINED';
  } else if (
    noteAdequacy === 'ENOUGH_FOR_PURPOSE' &&
    (!fullyGrounded || unresolved)
  ) {
    noteAdequacy = 'UNDETERMINED';
  }
  if (
    prior &&
    prior.noteAdequacy !== 'ENOUGH_FOR_PURPOSE' &&
    noteAdequacy === 'ENOUGH_FOR_PURPOSE' &&
    noProgress > 0 &&
    input.answers.some((a) => !prior.answers.some((p) => p.id === a.id))
  )
    noteAdequacy = 'UNDETERMINED';
  if (
    out.purpose === 'COMPLETION' &&
    noteAdequacy !== 'CONTRADICTORY' &&
    (out.taskContextStatus !== 'CLEAR' ||
      !requirements.length ||
      coverage.length !== requirements.length ||
      coverage.some((c) => c.status !== 'SUPPORTED'))
  )
    noteAdequacy = 'UNDETERMINED';
  const candidateGap =
    !rawInconsistentEnough && out.nextQuestion
      ? gaps[out.nextQuestion.gapIndex]
      : undefined;
  const canAskCandidate =
    !!candidateGap &&
    candidateGap.impact === 'BLOCKING' &&
    candidateGap.status === 'open' &&
    !input.answers.some((a) => gapMatchesId(candidateGap, a.gapId));
  const declinedCandidate =
    !!candidateGap &&
    candidateGap.impact === 'BLOCKING' &&
    (candidateGap.status !== 'open' ||
      input.answers.some((a) => gapMatchesId(candidateGap, a.gapId)));
  const v: AssessmentView = {
    schemaVersion: 'task-note-assessment/v1',
    id: prior?.id ?? randomUUID(),
    revision: (prior?.revision ?? 0) + 1,
    sourceRevision: meta.sourceRevision,
    taskContextHash: meta.taskContextHash,
    answerLedgerHash: assessmentHash(input.answers),
    purpose: out.purpose,
    state: 'ready_to_edit',
    contextManifest: {
      acquisitionStatus: 'LOADED',
      sources: input.sources,
      sourceCatalogVersion: '1',
    },
    taskUnderstanding: { ...out.taskUnderstanding, requirements },
    claims,
    coverage,
    gaps,
    nextQuestion: null,
    taskContextStatus: out.taskContextStatus,
    noteAdequacy,
    counters: { questionCount: prior?.counters.questionCount ?? 0, noProgress },
    allowedActions: [],
    answers: input.answers,
    authorValidated: false,
    reviewerSemanticAssessment: 'NOT_ESTABLISHED',
    signals: {
      saved: false,
      proposalApplied: false,
      authorValidated: false,
      reviewerSemanticAssessment: 'NOT_ESTABLISHED',
    },
    feedback: prior?.feedback ?? [],
    createdAt: prior?.createdAt ?? now,
    expiresAt: meta.expiresAt,
    trace: [...(prior?.trace ?? []), ...coverageTrace],
    promptVersion: meta.promptVersion ?? ASSESSMENT_PROMPT_VERSION,
    model: meta.model,
  };
  let reason = 'ASSESSMENT_READY';
  if (
    noteAdequacy === 'CONTRADICTORY' ||
    gaps.some((g) => g.kind === 'CONTRADICTION' && g.status !== 'answered')
  ) {
    v.state = 'contradiction';
    reason = 'SOURCE_CONTRADICTION';
  } else if (
    noteAdequacy === 'ENOUGH_FOR_PURPOSE' &&
    out.taskContextStatus !== 'INSUFFICIENT' &&
    !canAskCandidate
  ) {
    v.state = 'ready_to_edit';
    reason = 'ASSESSMENT_READY';
  } else if (v.counters.questionCount >= 3 || noProgress >= 2) {
    v.state = 'paused';
    reason =
      v.counters.questionCount >= 3 ? 'QUESTION_LIMIT' : 'NO_PROGRESS_LIMIT';
  } else if (canAskCandidate && out.nextQuestion && candidateGap) {
    v.state = 'waiting_for_answer';
    v.nextQuestion = {
      ...out.nextQuestion,
      id: randomUUID(),
      gapId: candidateGap.id,
    };
    delete (v.nextQuestion as unknown as Record<string, unknown>).gapIndex;
    v.counters.questionCount++;
    reason = 'MISSING_INFORMATION';
  } else if (declinedCandidate) {
    v.state = 'paused';
    reason = 'RESOLVED_OR_DECLINED_GAP';
  } else if (
    out.taskContextStatus === 'INSUFFICIENT' ||
    noteAdequacy !== 'ENOUGH_FOR_PURPOSE'
  ) {
    v.state = 'missing_context';
    reason = rawInconsistentEnough
      ? 'INCONSISTENT_MODEL_OUTPUT'
      : 'LIMITED_INFORMATION';
  }
  v.trace = [...v.trace, { phase: v.state, reasonCode: reason, at: now }].slice(
    -40,
  );
  v.allowedActions = assessmentActions(v);
  return v;
}
