import type { Db, Document } from 'mongodb';
import { Types } from 'mongoose';
import { contentTokens, extractFacts } from './work-note-history.facts';
import { verifyHistory } from './work-note-history.verification';
import type {
  HistoricalContext,
  HistoricalContextView,
  HistoricalNote,
  HistoryRelation,
} from './history.types';

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
    .find({ ...tenant, taskId: oid(scope.taskId), disposition: 'answered' })
    .sort({ answeredAt: -1 })
    .limit(options.ledgerLimit ?? 20)
    .toArray();
  for (const row of ledger)
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
  const facts = params.notes.flatMap(extractFacts);
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
  let remaining = params.options.charBudget;
  const kept = ordered.filter((f) => {
    const cost = f.quote.length + 80;
    if (cost > remaining) return false;
    remaining -= cost;
    return true;
  });
  const keptIds = new Set(kept.map((f) => f.id));
  const usedNotes = new Set(kept.map((f) => f.noteId));
  return {
    notes: params.notes
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
    findings: verified.findings.filter((f) => keptIds.has(f.factId)),
    truncated: kept.length < verified.facts.length,
  };
}

/** Compact, reference-based view (`H1`, `H2`…) for the prompt and the API. */
export function historicalContextView(
  context: HistoricalContext,
): HistoricalContextView {
  const refs = new Map(context.notes.map((n, i) => [n.id, `H${i + 1}`]));
  return {
    notes: context.notes.map((n) => ({
      ref: refs.get(n.id)!,
      id: n.id.startsWith('ledger:') ? '' : n.id,
      title: n.title,
      date: n.createdAt.slice(0, 10),
      source: n.source,
      relation: n.relation,
      ...(n.taskKey ? { taskKey: n.taskKey } : {}),
    })),
    facts: context.facts.map((f) => ({
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
    findings: context.findings,
    truncated: context.truncated,
  };
}
