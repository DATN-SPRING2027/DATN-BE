import { createHash } from 'node:crypto';
import {
  AgentValidationError,
  type DraftSnapshot,
} from './work-note-agent.types';

export const snapshotHash = (draft: DraftSnapshot): string =>
  createHash('sha256')
    .update(JSON.stringify([draft.revision, draft.title, draft.body]))
    .digest('hex');
export type Fragment = Readonly<{ marker: string; text: string }>;

export function findProtectedRanges(
  text: string,
  extra: readonly Readonly<{ start: number; end: number }>[] = [],
): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [...extra];
  let fence: { start: number; token: string } | null = null;
  let offset = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line);
    if (match) {
      if (!fence) fence = { start: offset, token: match[1] };
      else if (
        match[1][0] === fence.token[0] &&
        match[1].length >= fence.token.length &&
        !match[2].trim()
      ) {
        ranges.push({ start: fence.start, end: offset + line.length });
        fence = null;
      }
    }
    offset += line.length;
  }
  if (fence) ranges.push({ start: fence.start, end: text.length });
  for (const pattern of [
    /(`+)[^\r\n]*?\1/g,
    /https?:\/\/[^\s<>"`]+/g,
    /__WN_PROTECTED_[A-Za-z0-9_]+?__/g,
    // Technical literals are immutable even outside Markdown. Preserve exact
    // spelling/separators rather than letting the model localize them.
    /\b[A-Z][A-Z0-9]*-\d+\b/g,
    /\b[A-Za-z_$][\w$]*[a-z][A-Z][\w$]*\b/g,
    /\b[A-Za-z_$][\w$]*_[\w$]+\b/g,
    /\b[A-Za-z_$][A-Za-z0-9_$]*\d[A-Za-z_$][A-Za-z0-9_$]*\b/g,
    /(?<![\p{L}\p{N}_])v?[-+]?\d+(?:[.,:/-]\d+)*(?:%|ms|MB|GB|KB|MiB|GiB|KiB|[smh])?(?![\p{L}\p{N}_])/gu,
  ]) {
    for (const match of text.matchAll(pattern))
      ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges.sort(
    (a, b) => a.start - b.start || b.end - a.end,
  )) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end)
      previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function protectText(
  text: string,
  extra: readonly Readonly<{ start: number; end: number }>[] = [],
): { text: string; fragments: Fragment[] } {
  const merged = findProtectedRanges(text, extra);
  let salt = 0;
  let prefix: string;
  do {
    prefix = `__WN_PROTECTED_${createHash('sha256')
      .update(text + String(salt++))
      .digest('hex')
      .slice(0, 12)}_`;
  } while (text.includes(prefix));
  const fragments: Fragment[] = [];
  let cursor = 0;
  let masked = '';
  for (const [i, range] of merged.entries()) {
    const marker = `${prefix}${i}__`;
    fragments.push({ marker, text: text.slice(range.start, range.end) });
    masked += text.slice(cursor, range.start) + marker;
    cursor = range.end;
  }
  return { text: masked + text.slice(cursor), fragments };
}

export function restoreText(
  text: string,
  fragments: readonly Fragment[],
): string {
  const markers = text.match(/__WN_PROTECTED_[A-Za-z0-9_]+?__/g) ?? [];
  for (const fragment of fragments) {
    const index = text.indexOf(fragment.marker);
    if (
      index >= 0 &&
      (text[index - 1] === '`' || text[index + fragment.marker.length] === '`')
    ) {
      throw new AgentValidationError(
        'PROTECTED_CONTENT_CHANGED',
        'Protected markers cannot acquire Markdown wrappers.',
      );
    }
  }
  if (
    markers.length !== fragments.length ||
    markers.some((marker) => !fragments.some((f) => f.marker === marker)) ||
    fragments.some((f) => markers.filter((m) => m === f.marker).length !== 1)
  ) {
    throw new AgentValidationError(
      'PROTECTED_CONTENT_CHANGED',
      'Protected fragments must occur exactly once; unknown markers are rejected.',
    );
  }
  // One pass: restored source can itself contain marker-like text.
  const byMarker = new Map(fragments.map((f) => [f.marker, f.text]));
  return text.replace(/__WN_PROTECTED_[A-Za-z0-9_]+?__/g, (marker) =>
    byMarker.get(marker)!,
  );
}
