import { normalizeSearchText } from './literal-search';

export const CHAT_SEARCH_INDEX = 'chat_search_v1';

// Autocomplete uses indexed word prefixes, never a leading wildcard/substring scan.
export function autocompleteClause(path: string, query: string) {
  const terms = [
    ...new Set(normalizeSearchText(query).split(/\s+/).filter(Boolean)),
  ];
  if (!terms.some((term) => /[\p{L}\p{N}]/u.test(term)))
    return {
      compound: {
        must: [{ exists: { path } }],
        mustNot: [{ exists: { path } }],
      },
    };
  return {
    compound: {
      must: terms.map((term) => ({
        autocomplete: { path, query: term, tokenOrder: 'any' },
      })),
      should: [{ phrase: { path, query, score: { boost: { value: 5 } } } }],
    },
  };
}

// A literal B-tree prefix range keeps addresses intact; search analyzers split email punctuation.
export function literalPrefixRange(value: string): {
  $gte: string;
  $lt?: string;
} {
  const points = Array.from(value);
  while (points.length) {
    const last = points.pop()!.codePointAt(0)!;
    if (last < 0x10ffff)
      return {
        $gte: value,
        $lt:
          points.join('') +
          String.fromCodePoint(last === 0xd7ff ? 0xe000 : last + 1),
      };
  }
  return { $gte: value };
}

export function textSearchStage(query: string, filter: object[] = []) {
  return {
    $search: {
      index: CHAT_SEARCH_INDEX,
      compound: {
        must: [{ text: { path: 'content', query, matchCriteria: 'all' } }],
        filter,
      },
    },
  };
}
