import type {
  FactPolarity,
  HistoricalFact,
  HistoricalFactKind,
  HistoricalNote,
} from './history.types';

/** Accent-insensitive lowercase fold (Vietnamese-safe). */
export const fold = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/gu, 'd')
    .toLowerCase();

const STOPWORDS = new Set(
  // VI (folded) + EN function words and polarity/aspect markers.
  (
    'va voi cua cho la thi ma de da dang se chua khong co duoc bi nay do kia nhung cac mot hai ba ' +
    'roi xong van con can phai nen neu khi tai o tren duoi trong ngoai sau truoc len xuong ra vao ' +
    'minh toi em ban anh chi ho chung ta nhe a oi ha nhi lam viec phan muc nhu theo ve tu den ' +
    'the and or of for to in on at by with is are was were be been being has have had do does did ' +
    'not no yet still already will would should can could may might this that these those it its ' +
    'a an as from into than then also just only very more most'
  ).split(' '),
);

/** Content tokens for fuzzy matching (stable, order-insensitive). */
export function contentTokens(text: string): string[] {
  const tokens = fold(text)
    .replace(/\[\[wn_sec:[a-z_]+:[a-f0-9]+\]\]/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
  return [...new Set(tokens)];
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const set = new Set(a);
  let inter = 0;
  for (const t of b) if (set.has(t)) inter++;
  return inter / (set.size + b.length - inter);
}

export function overlap(a: readonly string[], b: readonly string[]): number {
  const set = new Set(a);
  return b.filter((t) => set.has(t)).length;
}

/** Same subject when they share ≥2 content tokens and enough of the smaller set. */
export function sameTarget(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const shared = overlap(a, b);
  if (shared < 2) return false;
  return shared / Math.min(a.length, b.length) >= 0.5 || jaccard(a, b) >= 0.4;
}

const KIND_RULES: readonly [HistoricalFactKind, RegExp][] = [
  [
    'TEST_RESULT',
    /\b(?:kiem thu|test(?:ed|ing|s)?|unit test|e2e|qa|regression|pass(?:ed)?|fail(?:ed)?)\b/u,
  ],
  [
    'DEPLOYMENT',
    /\b(?:deploy(?:ed|ment)?|trien khai|release(?:d)?|production|prod|staging|moi truong|rollback|go live)\b/u,
  ],
  [
    'BLOCKER',
    /\b(?:vuong|blocker|blocked|bi chan|su co|incident|loi|bug|issue|khong the|chua the|timeout|crash)\b/u,
  ],
  [
    'DECISION',
    /\b(?:quyet dinh|chot|thong nhat|lua chon|chon dung|decided|decision|agreed|thay vi|instead of)\b/u,
  ],
  [
    'PLAN',
    /\b(?:du kien|ke hoach|tiep theo|ngay mai|tuan sau|sap toi|next step|todo|will|plan(?:ned)?)\b/u,
  ],
  [
    'STATUS',
    /\b(?:hoan thanh|hoan tat|xong|done|completed?|dang lam|dang thuc hien|in progress|bat dau|da sua|da lam|da implement|da cap nhat|da them|da xu ly|fixed|implemented|merged?)\b/u,
  ],
  [
    'METRIC',
    /\d+(?:[.,]\d+)?\s?(?:ms|s|giay|phut|%|mb|gb|kb|req\/s|rps|qps|users?)\b/u,
  ],
];

const NEGATIVE =
  /\b(?:chua|khong|not|never|no longer|fail(?:ed|s)?|that bai|untested|unverified|blocked|bi chan|van con loi|con loi|van loi)\b/u;
const UNCERTAIN =
  /\b(?:co the|co le|du kien|kha nang|chac|hinh nhu|maybe|might|probably|expected|dang|in progress|pending)\b/u;

export function factPolarity(sentence: string): FactPolarity {
  const f = fold(sentence);
  if (NEGATIVE.test(f)) return 'NEGATIVE';
  if (UNCERTAIN.test(f)) return 'UNCERTAIN';
  return 'POSITIVE';
}

export function classifyFact(sentence: string): HistoricalFactKind | null {
  const f = fold(sentence);
  for (const [kind, pattern] of KIND_RULES) if (pattern.test(f)) return kind;
  return null;
}

/** Splits Markdown into sentence-like statements (code blocks are skipped). */
export function statements(markdown: string): string[] {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, '\n');
  const out: string[] = [];
  for (const rawLine of withoutCode.split(/\r?\n/)) {
    const line = rawLine
      .replace(
        /^\s{0,3}(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+•]\s+|\d+[.)]\s+|>\s+)/,
        '',
      )
      .replace(/\*\*|__/g, '')
      .trim();
    if (!line) continue;
    for (const part of line.split(/(?<=[.!?;])\s+(?=\p{Lu}|\d|\[\[)/u)) {
      const s = part.trim();
      if (s.length >= 6) out.push(s.length > 300 ? `${s.slice(0, 297)}…` : s);
    }
  }
  return out;
}

const MAX_FACTS_PER_NOTE = 12;

/** Rule-based Fact Ledger (Decision 3: no extra LLM call in Phase 1). */
export function extractFacts(note: HistoricalNote): HistoricalFact[] {
  const facts: HistoricalFact[] = [];
  const origin = {
    relation: note.relation ?? ('SELF' as const),
    taskId: note.taskId ?? '',
    ...(note.taskKey ? { taskKey: note.taskKey } : {}),
  };
  if (note.source === 'CLARIFICATION_LEDGER') {
    const target = contentTokens(note.title);
    if (target.length)
      facts.push({
        id: `${note.id}#0`,
        noteId: note.id,
        noteTitle: note.title,
        at: note.createdAt,
        kind: 'AUTHOR_ANSWER',
        ...origin,
        polarity: factPolarity(note.text),
        target: [...new Set([...target, ...contentTokens(note.text)])],
        quote:
          note.text.length > 300 ? `${note.text.slice(0, 297)}…` : note.text,
      });
    return facts;
  }
  for (const sentence of statements(note.text)) {
    const kind = classifyFact(sentence);
    if (!kind) continue;
    const target = contentTokens(sentence);
    if (target.length < 2) continue;
    facts.push({
      id: `${note.id}#${facts.length}`,
      noteId: note.id,
      noteTitle: note.title,
      at: note.createdAt,
      kind,
      polarity: factPolarity(sentence),
      target,
      quote: sentence,
      ...origin,
    });
    if (facts.length >= MAX_FACTS_PER_NOTE) break;
  }
  return facts;
}
