import { contentTokens, overlap, sameTarget } from './work-note-history.facts';
import type {
  HistoricalContext,
  HistoryRelation,
  VerifiedFact,
} from './history.types';

export type DedupQuestion = Readonly<{
  text: string;
  reason: string;
  options: readonly string[];
}>;

export type HistoryRef = Readonly<{
  factId: string;
  noteId: string | null;
  noteTitle: string;
  date: string;
  status: VerifiedFact['status'];
  /** Masked quote of the historical statement being confirmed. */
  quote: string;
  /** SELF for the current Task; PARENT/CHILD for a related Task of the same Project. */
  relation: HistoryRelation;
  taskKey?: string;
}>;

export type DedupDecision =
  | Readonly<{ action: 'keep' }>
  | Readonly<{
      action: 'confirm';
      question: DedupQuestion;
      historyRef: HistoryRef;
    }>;

/** The only canned option for the current Task: any change must be typed. */
export const CONFIRM_STILL_TRUE = 'Vẫn đúng như ghi chú cũ';
/** Canned option when the information comes from a parent/child Task. */
export const CONFIRM_APPLIES = 'Áp dụng cho Task này';

/** Related-Task facts must match more strongly: they describe a different Task. */
const MIN_SHARED_TOKENS_RELATED = 3;

const formatDate = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso.slice(0, 10);
};
const relationLabel = (relation: HistoryRelation, taskKey?: string) => {
  if (relation === 'SELF') return '';
  const kind =
    relation === 'PARENT' ? 'cha' : relation === 'CHILD' ? 'con' : 'liên kết';
  return `Task ${kind}${taskKey ? ` ${taskKey}` : ''}`;
};

/**
 * Intelligent Clarification (layer 2, deterministic): if the model still asks about
 * something already recorded in a previous note/answer, replace the open question
 * with a one-click confirmation that quotes the source. Stale or conflicting
 * information is never silently reused; it is always confirmed with the author.
 * Facts of the current Task win over facts of parent/child Tasks.
 */
export function dedupeClarification(
  question: DedupQuestion,
  context: HistoricalContext | null,
): DedupDecision {
  if (!context?.facts.length) return { action: 'keep' };
  const target = contentTokens(
    `${question.text} ${question.options.join(' ')}`,
  );
  if (target.length < 2) return { action: 'keep' };
  const match = context.facts
    .filter(
      (f) =>
        f.status !== 'SUPERSEDED' &&
        sameTarget(f.target, target) &&
        (f.relation === 'SELF' ||
          overlap(f.target, target) >= MIN_SHARED_TOKENS_RELATED),
    )
    .sort(
      (a, b) =>
        Number(a.relation !== 'SELF') - Number(b.relation !== 'SELF') ||
        Date.parse(b.at) - Date.parse(a.at),
    )[0];
  if (!match) return { action: 'keep' };
  const note = context.notes.find((n) => n.id === match.noteId);
  const date = formatDate(match.at);
  const fromLedger = match.noteId.startsWith('ledger:');
  const other = relationLabel(match.relation, match.taskKey);
  const caveat =
    match.status === 'CURRENT'
      ? ''
      : match.status === 'OUTDATED'
        ? ' Thông tin này đã khá lâu, có thể không còn đúng.'
        : ' Thông tin này có dấu hiệu mâu thuẫn với dữ liệu hiện tại.';
  const source = fromLedger
    ? 'câu trả lời trước'
    : `ghi chú “${note?.title ?? match.noteTitle}”${other ? ` của ${other}` : ''}`;
  return {
    action: 'confirm',
    question: {
      text: fromLedger
        ? `Bạn đã trả lời trước đây: "${match.quote}". Thông tin này còn đúng không?`
        : other
          ? `Ghi chú ngày ${date} của ${other}: "${match.quote}". Thông tin này có áp dụng cho Task hiện tại không?`
          : `Ghi chú ngày ${date}: "${match.quote}". Thông tin này còn đúng không?`,
      reason: `Không hỏi lại từ đầu vì thông tin đã có trong ${source}.${caveat} Nếu không áp dụng hoặc đã thay đổi, hãy nhập thông tin mới.`,
      options: [other ? CONFIRM_APPLIES : CONFIRM_STILL_TRUE],
    },
    historyRef: {
      factId: match.id,
      noteId: fromLedger ? null : match.noteId,
      noteTitle: note?.title ?? match.noteTitle,
      date: match.at.slice(0, 10),
      status: match.status,
      quote: match.quote,
      relation: match.relation,
      ...(match.taskKey ? { taskKey: match.taskKey } : {}),
    },
  };
}

/**
 * Assessment answers are standalone evidence text, so a bare "still true" would carry
 * no information. Expand it into an explicit author confirmation of the quoted fact
 * (still author-reported, never independently verified, and never auto-applied).
 */
export function expandHistoryConfirmation(
  answer: string | undefined,
  ref: HistoryRef | undefined,
): string | undefined {
  if (!ref || answer === undefined) return answer;
  const trimmed = answer.trim();
  if (trimmed !== CONFIRM_STILL_TRUE && trimmed !== CONFIRM_APPLIES)
    return answer;
  const other = relationLabel(ref.relation, ref.taskKey);
  return (
    other
      ? `Tác giả xác nhận thông tin từ ghi chú ngày ${formatDate(ref.date)} của ${other} áp dụng cho Task này: "${ref.quote}"`
      : `Tác giả xác nhận lại thông tin từ ghi chú cũ ngày ${formatDate(ref.date)}: "${ref.quote}"`
  ).slice(0, 2000);
}
