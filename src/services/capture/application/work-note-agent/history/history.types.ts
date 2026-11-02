/**
 * Historical Work Note context (Phase 1: same Task, CONFIRMED TASK_NOTE only).
 * All texts in these structures are ALREADY masked by the Security Gateway.
 */
export const HISTORICAL_FACT_KINDS = [
  'STATUS',
  'TEST_RESULT',
  'DEPLOYMENT',
  'BLOCKER',
  'DECISION',
  'PLAN',
  'METRIC',
  'AUTHOR_ANSWER',
] as const;
export type HistoricalFactKind = (typeof HISTORICAL_FACT_KINDS)[number];
export type FactPolarity = 'POSITIVE' | 'NEGATIVE' | 'UNCERTAIN';
export type FactStatus =
  | 'CURRENT'
  | 'SUPERSEDED'
  | 'OUTDATED'
  | 'CONFLICT_CURRENT'
  | 'CONFLICT_TASK'
  | 'CONFLICT_HISTORY';

/** Where a historical note comes from relative to the Task being edited. */
export type HistoryRelation = 'SELF' | 'PARENT' | 'CHILD' | 'LINKED';

export type HistoricalNote = Readonly<{
  id: string;
  title: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  source: 'TASK_NOTE' | 'CLARIFICATION_LEDGER';
  /** Defaults to SELF. PARENT/CHILD notes belong to a different Task of the same Project. */
  relation?: HistoryRelation;
  /** Key of the Task the note belongs to (only meaningful for PARENT/CHILD). */
  taskKey?: string;
  taskId?: string;
}>;

export type HistoricalFact = Readonly<{
  id: string;
  noteId: string;
  noteTitle: string;
  /** ISO date of the source note (or ledger answer). */
  at: string;
  kind: HistoricalFactKind;
  polarity: FactPolarity;
  /** Accent-folded content tokens used for matching (never shown to users). */
  target: readonly string[];
  quote: string;
  relation: HistoryRelation;
  taskKey?: string;
  taskId: string;
}>;

export type HistoryFinding = Readonly<{
  factId: string;
  noteId: string;
  status: Exclude<FactStatus, 'CURRENT'>;
  /** Short machine-readable reason code. */
  reason:
    | 'NEWER_NOTE_DIFFERS'
    | 'OLDER_THAN_THRESHOLD'
    | 'CURRENT_NOTE_DIFFERS'
    | 'TASK_STATUS_DIFFERS'
    | 'HISTORY_SELF_CONTRADICTION';
  relatedFactId?: string;
}>;

export type VerifiedFact = HistoricalFact & Readonly<{ status: FactStatus }>;

export type HistoricalContext = Readonly<{
  notes: readonly Readonly<{
    id: string;
    title: string;
    createdAt: string;
    source: HistoricalNote['source'];
    relation: HistoryRelation;
    taskKey?: string;
  }>[];
  facts: readonly VerifiedFact[];
  findings: readonly HistoryFinding[];
  truncated: boolean;
}>;

/** Shared caps enforced by both HistoricalContext builders and validateAgentInput. */
export const HISTORY_VIEW_LIMITS = {
  maxNotes: 40,
  maxFacts: 80,
  maxFindings: 80,
  maxTitleLength: 1_000,
  maxQuoteLength: 400,
} as const;

/** Compact projection for the LLM payload and the public API. */
export type HistoricalContextView = Readonly<{
  notes: readonly Readonly<{
    ref: string;
    id: string;
    title: string;
    date: string;
    source: HistoricalNote['source'];
    relation: HistoryRelation;
    taskKey?: string;
  }>[];
  facts: readonly Readonly<{
    id: string;
    ref: string;
    date: string;
    kind: HistoricalFactKind;
    polarity: FactPolarity;
    status: FactStatus;
    quote: string;
    relation: HistoryRelation;
    taskKey?: string;
  }>[];
  findings: readonly HistoryFinding[];
  truncated: boolean;
}>;
