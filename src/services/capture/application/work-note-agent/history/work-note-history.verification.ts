import {
  classifyFact,
  contentTokens,
  factPolarity,
  fold,
  sameTarget,
  statements,
} from './work-note-history.facts';
import type {
  FactStatus,
  HistoricalFact,
  HistoricalFactKind,
  HistoryFinding,
  VerifiedFact,
} from './history.types';

const DAY = 86_400_000;
/** Kinds whose truth decays over time (decisions/metrics are historical records). */
const TIME_SENSITIVE: ReadonlySet<HistoricalFactKind> = new Set([
  'STATUS',
  'TEST_RESULT',
  'DEPLOYMENT',
  'BLOCKER',
  'PLAN',
]);
const COMPLETION =
  /\b(?:hoan thanh|hoan tat|xong|done|completed?|nghiem thu|closed)\b/u;
const OPEN_TASK_STATUSES = new Set([
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'IN_REVIEW',
]);

export type VerificationInput = Readonly<{
  facts: readonly HistoricalFact[];
  currentNoteText: string;
  taskStatus: string | null;
  now: Date;
  staleDays: number;
}>;

const comparable = (a: HistoricalFact, b: HistoricalFact) =>
  (a.kind === b.kind ||
    a.kind === 'AUTHOR_ANSWER' ||
    b.kind === 'AUTHOR_ANSWER') &&
  a.taskId === b.taskId && // facts of different Tasks never supersede each other
  sameTarget(a.target, b.target);

/**
 * Deterministic Historical Information Verification. Never edits old notes; it only
 * labels facts so the prompt/UI can avoid treating stale information as current.
 * Priority: conflict with current note > conflict with Task > superseded > outdated.
 */
export function verifyHistory(input: VerificationInput): {
  facts: VerifiedFact[];
  findings: HistoryFinding[];
} {
  const sorted = [...input.facts].sort(
    (a, b) => Date.parse(b.at) - Date.parse(a.at),
  );
  const current = statements(input.currentNoteText)
    .map((s) => ({
      kind: classifyFact(s),
      polarity: factPolarity(s),
      target: contentTokens(s),
    }))
    .filter((c) => c.kind !== null && c.target.length >= 2);
  const findings: HistoryFinding[] = [];
  const statusOf = new Map<string, FactStatus>();
  const mark = (
    fact: HistoricalFact,
    finding: Omit<HistoryFinding, 'factId' | 'noteId'>,
  ) => {
    if (statusOf.has(fact.id)) return;
    statusOf.set(fact.id, finding.status);
    findings.push({ factId: fact.id, noteId: fact.noteId, ...finding });
  };

  for (const fact of sorted) {
    // 1. The note being written now says otherwise.
    const differsNow = current.some(
      (c) =>
        fact.relation === 'SELF' && // parent/child notes describe other Tasks
        (c.kind === fact.kind || fact.kind === 'AUTHOR_ANSWER') &&
        c.polarity !== fact.polarity &&
        sameTarget(c.target, fact.target),
    );
    if (differsNow) {
      mark(fact, {
        status: 'CONFLICT_CURRENT',
        reason: 'CURRENT_NOTE_DIFFERS',
      });
      continue;
    }
    // 2. Old note claims completion but the Task is open again (status ≠ evidence).
    if (
      fact.relation === 'SELF' &&
      input.taskStatus &&
      OPEN_TASK_STATUSES.has(input.taskStatus) &&
      fact.kind === 'STATUS' &&
      fact.polarity === 'POSITIVE' &&
      COMPLETION.test(fold(fact.quote))
    ) {
      mark(fact, { status: 'CONFLICT_TASK', reason: 'TASK_STATUS_DIFFERS' });
      continue;
    }
    // 3. A newer historical statement about the same subject differs → superseded;
    //    same-time contradictions cannot be resolved → conflict.
    const newer = sorted.find(
      (other) =>
        other.id !== fact.id &&
        Date.parse(other.at) >= Date.parse(fact.at) &&
        other.polarity !== fact.polarity &&
        comparable(other, fact),
    );
    if (newer) {
      const sameMoment =
        newer.noteId === fact.noteId ||
        Math.abs(Date.parse(newer.at) - Date.parse(fact.at)) < 3_600_000;
      if (sameMoment)
        mark(fact, {
          status: 'CONFLICT_HISTORY',
          reason: 'HISTORY_SELF_CONTRADICTION',
          relatedFactId: newer.id,
        });
      else
        mark(fact, {
          status: 'SUPERSEDED',
          reason: 'NEWER_NOTE_DIFFERS',
          relatedFactId: newer.id,
        });
      continue;
    }
    // 4. Time-sensitive facts older than the threshold.
    if (
      TIME_SENSITIVE.has(fact.kind) &&
      input.now.getTime() - Date.parse(fact.at) > input.staleDays * DAY
    )
      mark(fact, { status: 'OUTDATED', reason: 'OLDER_THAN_THRESHOLD' });
  }

  return {
    facts: sorted.map((f) => ({
      ...f,
      status: statusOf.get(f.id) ?? 'CURRENT',
    })),
    findings,
  };
}
