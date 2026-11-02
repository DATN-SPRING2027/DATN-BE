import type { Db, Document } from 'mongodb';
import { Types } from 'mongoose';
import {
  contentTokens,
  extractFacts,
  truncateFactQuote,
} from './work-note-history.facts';
import { verifyHistory } from './work-note-history.verification';
import {
  HISTORY_VIEW_LIMITS,
  type HistoricalContext,
  type HistoricalContextView,
  type HistoricalNote,
  type HistoryRelation,
} from './history.types';
export { HISTORY_VIEW_LIMITS } from './history.types';

export type HistoryRelatedTask = Readonly<{
  id: string;
  key?: string;
  relation: Exclude<HistoryRelation, 'SELF'>;
}>;

export type HistoryScope = Readonly<{
  organizationId: string;
  projectId: string;
  taskId: string;
  /** The note currently being edited is never its own history. */
  excludeNoteId?: string | null;
  /**
   * Phase 2: parent / direct children of `taskId` in the SAME Project. The caller MUST
   * have obtained them with the requesting user's own credentials (readable by that user).
   */
  related?: readonly HistoryRelatedTask[];
}>;

export type HistoryOptions = Readonly<{
  maxNotes: number;
  charBudget: number;
  staleDays: number;
  /** Max notes taken from parent/child Tasks in total. 0 disables Phase 2. */
  maxRelatedNotes?: number;
  scanLimit?: number;
  relatedScanLimit?: number;
  ledgerLimit?: number;
}>;

export const LEDGER_COLLECTION = 'task_clarification_ledger';

const oid = (v: string) => new Types.ObjectId(v);
const iso = (v: unknown) =>
  v instanceof Date
    ? v.toISOString()
    : typeof v === 'string'
      ? v
      : new Date(0).toISOString();
const bodyOf = (row: Document): string =>
  typeof row.contentMarkdown === 'string'
    ? row.contentMarkdown
    : [row.whatDone, row.howSolved, row.whyThisWay]
        .filter((v): v is string => typeof v === 'string' && !!v.trim())
        .join('\n\n');

/**
 * Retrieval: CONFIRMED TASK_NOTEs of the same organization/project/task (Phase 1) plus,
 * when `scope.related` is given, of its parent and direct children (Phase 2).
 * Never the whole Project. The caller MUST have authorized every Task already.
 */
export async function loadTaskHistory(
  db: Db,
  scope: HistoryScope,
  options: HistoryOptions,
): Promise<HistoricalNote[]> {
  const tenant = {
    organizationId: oid(scope.organizationId),
    projectId: oid(scope.projectId),
  };
  const rowToNote = (
    row: Document,
    extra: Pick<HistoricalNote, 'relation' | 'taskId'> &
      Partial<Pick<HistoricalNote, 'taskKey'>>,
  ): HistoricalNote => ({
    id: String(row._id),
    title: typeof row.title === 'string' ? row.title : '',
    text: bodyOf(row),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt ?? row.createdAt),
    version: Number(row.currentVersionNumber ?? 1),
    source: 'TASK_NOTE',
    ...extra,
  });
  const rows = await db
    .collection('work_notes')
    .find({
      ...tenant,
      taskId: oid(scope.taskId),
      type: 'TASK_NOTE',
      status: 'CONFIRMED',
      ...(scope.excludeNoteId
        ? { _id: { $ne: oid(scope.excludeNoteId) } }
        : {}),
    })
    .sort({ createdAt: -1, _id: -1 })
    .limit(options.scanLimit ?? 50)
    .toArray();
  const notes: HistoricalNote[] = rows.map((row) =>
    rowToNote(row, { relation: 'SELF', taskId: scope.taskId }),
  );

  const related = new Map(
    (scope.related ?? [])
      .filter((r) => r.id !== scope.taskId)
      .map((r) => [r.id, r] as const),
  );
  if (related.size > 0 && (options.maxRelatedNotes ?? 0) > 0) {
    const relatedRows = await db
      .collection('work_notes')
      .find({
        ...tenant,
        taskId: { $in: [...related.keys()].map(oid) },
        type: 'TASK_NOTE',
        status: 'CONFIRMED',
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(options.relatedScanLimit ?? 30)
      .toArray();
    for (const row of relatedRows) {
      const task = related.get(String(row.taskId));
      if (!task) continue;
      notes.push(
        rowToNote(row, {
          relation: task.relation,
          taskId: task.id,
          ...(task.key ? { taskKey: task.key } : {}),
        }),
      );
    }
  }

  const ledger = await db
    .collection(LEDGER_COLLECTION)
    .find({
      ...tenant,
      taskId: oid(scope.taskId),
      disposition: 'answered',
      ...(scope.excludeNoteId
        ? { noteId: { $ne: oid(scope.excludeNoteId) } }
        : {}),
    })
    .sort({ answeredAt: -1 })
    .limit(options.ledgerLimit ?? 20)
    .toArray();
  const referencedNoteIds = [
    ...new Map(
      ledger
        .map((row): unknown => row.noteId)
        .filter((id): id is Types.ObjectId => id instanceof Types.ObjectId)
        .map((id) => [id.toHexString(), id] as const),
    ).values(),
  ];
  const confirmedLedgerNotes =
    referencedNoteIds.length > 0
      ? new Set(
          (
            await db
              .collection('work_notes')
              .find(
                {
                  ...tenant,
                  _id: { $in: referencedNoteIds },
                  status: 'CONFIRMED',
                },
                { projection: { _id: 1 } },
              )
              .toArray()
          ).map((row) => String(row._id)),
        )
      : new Set<string>();
  for (const row of ledger) {
    if (
      row.noteId instanceof Types.ObjectId &&
      !confirmedLedgerNotes.has(row.noteId.toHexString())
    )
      continue;
    notes.push({
      id: `ledger:${String(row._id)}`,
      title: typeof row.question === 'string' ? row.question : '',
      text: typeof row.answer === 'string' ? row.answer : '',
      createdAt: iso(row.answeredAt),
      updatedAt: iso(row.answeredAt),
      version: 1,
      source: 'CLARIFICATION_LEDGER',
      relation: 'SELF',
      taskId: scope.taskId,
    });
  }
  return notes;
}

const scoreNotes = (notes: readonly HistoricalNote[], query: string) => {
  const q = new Set(contentTokens(query));
  const times = notes.map((n) => Date.parse(n.createdAt));
  const min = Math.min(...times);
  const span = Math.max(1, Math.max(...times) - min);
  return notes.map((note, i) => {
    const tokens = contentTokens(`${note.title} ${note.text}`);
    const hits = tokens.filter((t) => q.has(t)).length;
    const lexical = q.size
      ? hits / Math.sqrt(q.size * Math.max(1, tokens.length))
      : 0;
    const recency = (times[i] - min) / span;
    return { note, score: 0.5 * recency + 0.5 * Math.min(1, lexical * 2) };
  });
};

/**
 * Recency + lexical relevance. The current Task's newest note is always kept; notes of
 * parent/child Tasks compete for at most `maxRelatedNotes` slots and are never forced in.
 */
export function rankNotes(
  notes: readonly HistoricalNote[],
  query: string,
  maxNotes: number,
  maxRelatedNotes = 0,
): HistoricalNote[] {
  const ledger = notes.filter((n) => n.source === 'CLARIFICATION_LEDGER');
  const own = notes.filter(
    (n) => n.source === 'TASK_NOTE' && (n.relation ?? 'SELF') === 'SELF',
  );
  const related = notes.filter(
    (n) => n.source === 'TASK_NOTE' && (n.relation ?? 'SELF') !== 'SELF',
  );
  const relatedPicked =
    maxRelatedNotes > 0 && related.length
      ? scoreNotes(related, query)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxRelatedNotes)
          .map((s) => s.note)
      : [];
  if (!own.length) return [...relatedPicked, ...ledger];
  const newest = own.reduce((a, b) =>
    Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a,
  );
  const picked = scoreNotes(own, query)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.note)
    .filter((n) => n.id !== newest.id)
    .slice(0, Math.max(0, maxNotes - 1));
  return [newest, ...picked, ...relatedPicked, ...ledger];
}

/**
 * Historical Context Builder: facts (rule-based) → verification → char budget.
 * `notes` must already be masked by the Security Gateway.
 */
export function buildHistoricalContext(params: {
  notes: readonly HistoricalNote[];
  currentNoteText: string;
  taskStatus: string | null;
  now: Date;
  options: HistoryOptions;
}): HistoricalContext {
  const normalizedNotes = params.notes.map((n) => ({
    ...n,
    title: truncateFactQuote(
      n.title.trim(),
      HISTORY_VIEW_LIMITS.maxTitleLength,
    ),
  }));
  const noteById = new Map(normalizedNotes.map((n) => [n.id, n] as const));
  const facts = normalizedNotes
    .flatMap(extractFacts)
    .map((f) => ({
      ...f,
      quote: truncateFactQuote(
        f.quote.trim(),
        HISTORY_VIEW_LIMITS.maxQuoteLength,
      ),
    }))
    .filter((f) => f.quote.length > 0);
  const verified = verifyHistory({
    facts,
    currentNoteText: params.currentNoteText,
    taskStatus: params.taskStatus,
    now: params.now,
    staleDays: params.options.staleDays,
  });
  // Budget: current Task first, then CURRENT facts, then conflicts, then newest first.
  const priority = (s: string) =>
    s === 'CURRENT' ? 0 : s.startsWith('CONFLICT') ? 1 : 2;
  const ordered = [...verified.facts].sort(
    (a, b) =>
      Number(a.relation !== 'SELF') - Number(b.relation !== 'SELF') ||
      priority(a.status) - priority(b.status) ||
      Date.parse(b.at) - Date.parse(a.at),
  );
  let remaining = Math.max(0, params.options.charBudget - 64);
  const usedNotes = new Set<string>();
  const kept: typeof ordered = [];
  for (const f of ordered) {
    if (kept.length >= HISTORY_VIEW_LIMITS.maxFacts) break;
    const note = noteById.get(f.noteId);
    const needsNewNote = Boolean(note) && !usedNotes.has(f.noteId);
    if (needsNewNote && usedNotes.size >= HISTORY_VIEW_LIMITS.maxNotes)
      continue;
    const noteCost =
      needsNewNote && note
        ? JSON.stringify({
            ref: 'H99',
            title: note.title,
            date: note.createdAt.slice(0, 10),
            source: note.source,
            relation: note.relation ?? 'SELF',
            ...(note.taskKey ? { task: note.taskKey } : {}),
          }).length + 1
        : 0;
    const factCost =
      JSON.stringify({
        ref: 'H99',
        date: f.at.slice(0, 10),
        kind: f.kind,
        polarity: f.polarity,
        status: f.status,
        quote: f.quote,
        relation: f.relation,
        ...(f.taskKey ? { task: f.taskKey } : {}),
      }).length + 1;
    if (noteCost + factCost > remaining) continue;
    remaining -= noteCost + factCost;
    if (needsNewNote) usedNotes.add(f.noteId);
    kept.push(f);
  }
  const keptIds = new Set(kept.map((f) => f.id));
  const allKeptFindings = verified.findings.filter((f) =>
    keptIds.has(f.factId),
  );
  const findings = allKeptFindings.slice(0, HISTORY_VIEW_LIMITS.maxFindings);
  return {
    notes: normalizedNotes
      .filter((n) => usedNotes.has(n.id))
      .map((n) => ({
        id: n.id,
        title: n.title,
        createdAt: n.createdAt,
        source: n.source,
        relation: n.relation ?? 'SELF',
        ...(n.taskKey ? { taskKey: n.taskKey } : {}),
      })),
    facts: kept.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    findings,
    truncated:
      kept.length < verified.facts.length ||
      findings.length < allKeptFindings.length,
  };
}

/** Compact, reference-based view (`H1`, `H2`…) for the prompt and the API. */
export function historicalContextView(
  context: HistoricalContext,
): HistoricalContextView {
  const cappedNotes = context.notes.slice(0, HISTORY_VIEW_LIMITS.maxNotes);
  const refs = new Map(cappedNotes.map((n, i) => [n.id, `H${i + 1}`]));
  const validFacts = context.facts
    .filter((f) => refs.has(f.noteId) || f.noteId.startsWith('ledger:'))
    .map((f) => ({
      ...f,
      quote: truncateFactQuote(
        f.quote.trim(),
        HISTORY_VIEW_LIMITS.maxQuoteLength,
      ),
    }))
    .filter((f) => f.quote.length > 0);
  const cappedFacts = validFacts.slice(0, HISTORY_VIEW_LIMITS.maxFacts);
  const keptFactIds = new Set(cappedFacts.map((f) => f.id));
  const cappedFindings = context.findings
    .filter((f) => keptFactIds.has(f.factId))
    .slice(0, HISTORY_VIEW_LIMITS.maxFindings);
  return {
    notes: cappedNotes.map((n) => ({
      ref: refs.get(n.id)!,
      id: n.id.startsWith('ledger:') ? '' : n.id,
      title: truncateFactQuote(
        n.title.trim(),
        HISTORY_VIEW_LIMITS.maxTitleLength,
      ),
      date: n.createdAt.slice(0, 10),
      source: n.source,
      relation: n.relation,
      ...(n.taskKey ? { taskKey: n.taskKey } : {}),
    })),
    facts: cappedFacts.map((f) => ({
      id: f.id,
      ref: refs.get(f.noteId) ?? '',
      date: f.at.slice(0, 10),
      kind: f.kind,
      polarity: f.polarity,
      status: f.status,
      quote: f.quote,
      relation: f.relation,
      ...(f.taskKey ? { taskKey: f.taskKey } : {}),
    })),
    findings: cappedFindings,
    truncated:
      context.truncated ||
      cappedNotes.length < context.notes.length ||
      cappedFacts.length < context.facts.length ||
      cappedFindings.length < context.findings.length,
  };
}
