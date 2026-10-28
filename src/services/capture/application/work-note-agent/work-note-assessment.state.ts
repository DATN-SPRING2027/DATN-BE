import { randomUUID } from 'node:crypto';
import {
  assessmentHash,
  ASSESSMENT_PROMPT_VERSION,
} from './work-note-assessment.protocol';
import type {
  AssessmentModelInput,
  AssessmentModelOutput,
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
const gapKey = (
  g: Pick<AssessmentGap, 'kind' | 'owner' | 'target' | 'sourceRefs'>,
) =>
  assessmentHash([
    g.kind,
    g.owner,
    targetKey(g.target),
    anchorKey(g.sourceRefs),
  ]).slice(0, 24);
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
const overlaps = (a: Set<string>, b: Set<string>) =>
  [...a].some((w) => b.has(w));
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
  const gaps: AssessmentGap[] = out.gaps.map((g) => {
    const id = `gap-${gapKey(g)}`;
    const answer = [...input.answers].reverse().find((a) => a.gapId === id);
    const priorGap = prior?.gaps.find((p) => p.id === id);
    const status =
      answer?.disposition === 'unknown'
        ? 'unknown'
        : answer?.disposition === 'skipped'
          ? 'skipped'
          : priorGap?.status === 'answered'
            ? 'answered'
            : 'open';
    return { ...g, id, status };
  });
  for (const g of prior?.gaps ?? []) {
    if (gaps.some((x) => x.id === g.id)) continue;
    const a = [...input.answers].reverse().find((x) => x.gapId === g.id);
    if (a)
      gaps.push({
        ...g,
        status: a.disposition === 'answered' ? 'answered' : a.disposition,
      });
    else if (g.status !== 'open') gaps.push(g);
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
  // Only new replies to an existing gap can reset the bounded question loop.
  const relevantReplies = input.answers.filter((a) => {
    const gap = prior?.gaps.find(
      (g) => g.id === a.gapId && g.status === 'open',
    );
    const text = norm(a.answer ?? '');
    if (
      !gap ||
      a.disposition !== 'answered' ||
      a.purpose !== prior?.purpose ||
      a.taskContextHash !== meta.taskContextHash ||
      !text ||
      contentWords(text).size < 2 ||
      prior?.answers.some((p) => p.id === a.id || norm(p.answer ?? '') === text)
    )
      return false;
    const context = contentWords(
      [
        gap.target,
        ...gap.sourceRefs.map((r) => r.quote),
        ...prior.taskUnderstanding.requirements.map((r) => r.text),
      ].join(' '),
    );
    return (
      overlaps(contentWords(text), context) ||
      (targetKey(gap.target).includes('environment') &&
        /\b(localhost|staging|production|development|docker|uat|127 0 0 1)\b/.test(
          text,
        ))
    );
  });
  const replyGrounds = (refs: SourceRef[]) =>
    relevantReplies.some((a) =>
      refs.some((ref) => {
        const source = input.sources.find(
          (s) =>
            s.id === ref.sourceId &&
            s.kind === 'ANSWER' &&
            s.loadStatus === 'LOADED' &&
            s.includedInRequest,
        );
        const quote = norm(ref.quote),
          answer = norm(a.answer ?? '');
        return (
          !!source &&
          !!quote &&
          norm(source.text).includes(answer) &&
          norm(source.text).includes(quote) &&
          contentWords(quote).size >= 2 &&
          overlaps(contentWords(quote), contentWords(answer))
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
        overlaps(contentWords(c.text), contentWords(a.answer ?? '')),
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
  let noteAdequacy = out.noteAdequacy;
  const fullyGrounded =
    claims.some(
      (c) => c.originKind === 'AUTHOR_REPORT' && c.supportRelation === 'FULL',
    ) && claims.every((c) => c.supportRelation === 'FULL');
  if (noteAdequacy === 'ENOUGH_FOR_PURPOSE' && (!fullyGrounded || unresolved))
    noteAdequacy = unresolved ? 'NEEDS_AUTHOR_INPUT' : 'UNDETERMINED';
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
    (out.taskContextStatus !== 'CLEAR' ||
      !requirements.length ||
      coverage.length !== requirements.length ||
      coverage.some((c) => c.status !== 'SUPPORTED'))
  )
    noteAdequacy = 'UNDETERMINED';
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
    promptVersion: ASSESSMENT_PROMPT_VERSION,
    model: meta.model,
  };
  let reason = 'ASSESSMENT_READY';
  if (
    noteAdequacy === 'CONTRADICTORY' ||
    coverage.some((c) => c.status === 'CONTRADICTORY')
  ) {
    v.state = 'contradiction';
    reason = 'SOURCE_CONTRADICTION';
  } else if (v.counters.questionCount >= 3 || noProgress >= 2) {
    v.state = 'paused';
    reason =
      v.counters.questionCount >= 3 ? 'QUESTION_LIMIT' : 'NO_PROGRESS_LIMIT';
  } else if (out.nextQuestion) {
    const g = gaps[out.nextQuestion.gapIndex];
    const answered = input.answers.some((a) => a.gapId === g.id);
    if (g.status === 'open' && !answered) {
      v.state = 'waiting_for_answer';
      v.nextQuestion = { ...out.nextQuestion, id: randomUUID(), gapId: g.id };
      delete (v.nextQuestion as unknown as Record<string, unknown>).gapIndex;
      v.counters.questionCount++;
      reason = 'MISSING_INFORMATION';
    } else {
      v.state = 'paused';
      reason = 'RESOLVED_OR_DECLINED_GAP';
    }
  } else if (
    out.taskContextStatus === 'INSUFFICIENT' ||
    noteAdequacy !== 'ENOUGH_FOR_PURPOSE'
  ) {
    v.state = 'missing_context';
    reason = 'LIMITED_INFORMATION';
  }
  v.trace = [...v.trace, { phase: v.state, reasonCode: reason, at: now }].slice(
    -40,
  );
  v.allowedActions = assessmentActions(v);
  return v;
}
