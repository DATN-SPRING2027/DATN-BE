/** Conservative VI/EN vetoes, not an entailment verifier. Never creates evidence
 * or promotes coverage: the model must still judge support and a reviewer must
 * assess semantics. Source quotations themselves are never rewritten here.
 */
const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/gu, 'd')
    .toLowerCase();
const withoutIdioms = (s: string) =>
  fold(s).replace(/\bnot only\b|\bkhong chi\b/gu, '');
const pendingEpistemic = (s: string) =>
  /\b(?:(?:tests?|testing|verification|deployment)\s+(?:(?:is|are)\s+)?(?:still\s+)?pending|pending\s+(?:tests?|testing|verification|deployment))\b/iu.test(
    fold(s),
  );
export const hasNegation = (s: string) =>
  /\b(?:not|never|cannot|can['’]t|doesn['’]t|didn['’]t|isn['’]t|wasn['’]t|hasn['’]t|haven['’]t|won['’]t|untested|unverified|unknown|chua|khong)\b/iu.test(
    withoutIdioms(s),
  ) ||
  /\b(?:no|without)\s+(?:evidence|confirmation|results?)\b/iu.test(fold(s)) ||
  pendingEpistemic(s);

const activityGroups = [
  /\b(?:kiem thu|test(?:ed|ing|s)?|thu|dien tap|drill(?:ed|s)?|verif(?:y|ied|ication))\b/iu,
  /\b(?:trien khai|deploy(?:ed|ment|ing)?|release(?:d)?)\b/iu,
  /\b(?:do|measur(?:e|ed|ement)|evaluat(?:e|ed|ion))\b/iu,
];
const epistemic = (s: string) =>
  /\b(?:no|without)\s+(?:evidence|confirmation|results?)\b/iu.test(fold(s)) ||
  /\b(?:untested|unverified|unknown)\b/iu.test(fold(s)) ||
  /\b(?:chua|khong)\s+(?:duoc\s+)?(?:kiem thu|test|thu|dien tap|trien khai|deploy|xac minh|xac dinh|do|chay|viet|hoan thanh|sua|gui)\b/iu.test(
    fold(s),
  ) ||
  /\b(?:not|never)\s+(?:yet\s+|been\s+)?(?:tested|verified|confirmed|deployed|implemented|measured|evaluated|written|completed|sent|run)\b/iu.test(
    fold(s),
  ) ||
  pendingEpistemic(s) ||
  /\b(?:chua|khong)\s+(?:biet|ro|co\s+(?:ket qua|thong tin|chi tiet))\b/iu.test(
    fold(s),
  );
export const hasExplicitUncertainty = epistemic;
const artifactTask = (title: string) => {
  const text = fold(title);
  if (/\b(?:trien khai|implement|deploy|execute|dien tap|chay)\b/iu.test(text))
    return false;
  return (
    /^(?:viet|soan|write|author)\b.*\b(?:runbook|tai lieu|dac ta|tieu chi|specification|document|requirements)\b/iu.test(
      text,
    ) || /^(?:thiet ke|design)\b/iu.test(text)
  );
};

function segments(text: string) {
  const out: { start: number; end: number; text: string }[] = [];
  let start = 0;
  for (const match of text.matchAll(/[;\r\n]|[.!?](?=\s|$)/gu)) {
    const end = match.index + match[0].length;
    out.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  if (start < text.length)
    out.push({ start, end: text.length, text: text.slice(start) });
  return out;
}
export function atomicAssessmentPassages(text: string): string[] {
  return [
    ...new Set(
      (text.includes('```') ? [text] : segments(text).map((p) => p.text))
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && p.length <= 2000),
    ),
  ];
}
export function literalAssessmentPassages(text: string): string[] {
  // Extraction aids only, not approved criteria. Preserve full source context in
  // the request; avoid splitting code blocks or dropping text from that source.
  const passages = text.includes('```')
    ? [text]
    : [...text.split(/\r?\n/u), ...atomicAssessmentPassages(text)];
  return [
    ...new Set(
      passages
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && p.length <= 2000),
    ),
  ];
}
function occurrences(source: string, quote: string) {
  const positions: number[] = [];
  for (
    let at = source.indexOf(quote);
    at >= 0;
    at = source.indexOf(quote, at + 1)
  ) {
    if (positions.length >= 64) throw Error('AMBIGUOUS_SOURCE_REFERENCE');
    positions.push(at);
  }
  return positions;
}
function overlappingScopes(
  parts: ReturnType<typeof segments>,
  start: number,
  end: number,
) {
  let low = 0,
    high = parts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (parts[mid].end <= start) low = mid + 1;
    else high = mid;
  }
  const selected: ReturnType<typeof segments> = [];
  for (let i = low; i < parts.length && parts[i].start < end; i++)
    selected.push(parts[i]);
  return selected;
}
const conditionPrefix = (text: string) =>
  /^\s*(?:if|when|unless|khi|nếu|neu)\b.*?(?:,|\bthen\b|\s+thì\s+|\s+thi\s+|=>)/iu.exec(
    text,
  )?.[0] ?? '';
const assertedScope = (text: string) =>
  text.slice(conditionPrefix(text).length);
export function dropsSourceNegation(source: string, quote: string): boolean {
  const parts = segments(source);
  return occurrences(source, quote).some((at) => {
    const part = overlappingScopes(parts, at, at + 1)[0];
    if (!part) return false;
    const prefix = withoutIdioms(assertedScope(source.slice(part.start, at)));
    // An excerpt may not start just after a governing negator. Punctuation
    // separates independent clauses; repeated ambiguous occurrences fail closed.
    return /\b(?:not|never|cannot|can['’]t|doesn['’]t|didn['’]t|isn['’]t|wasn['’]t|hasn['’]t|haven['’]t|won['’]t|chua|khong|(?:no|without)\s+(?:evidence|confirmation|results?))(?:\s+[\p{L}]+){0,3}\s*$/iu.test(
      prefix,
    );
  });
}
function words(s: string) {
  const normalized = fold(s);
  const tokens = normalized.match(/[a-z0-9_]+/gu) ?? [];
  const stop =
    /^(?:the|a|an|is|are|was|were|has|have|been|be|must|should|on|in|of|to|for|and|or|not|never|cannot|untested|unverified|unknown|test|tests|tested|testing|verify|verified|verification|da|chua|khong|co|duoc|can|phai|va|hoac|la|thi|khi|voi|cho|cua|cac|nhung|mot|tu|tren|sau|truoc|toi|kiem|thu|trien|khai|dien|tap|do|chay|viet|hoan|thanh)$/u;
  const result = new Set(tokens.filter((w) => !stop.test(w)));
  // Keep short named entities such as API A / API B distinct from articles.
  for (const match of s.matchAll(/\b[A-HJ-Z]\b/gu))
    result.add(`id:${match[0].toLowerCase()}`);
  return result;
}
const overlap = (a: Set<string>, b: Set<string>) =>
  [...a].filter((w) => b.has(w));

export function coveragePolarityConflict(
  requirement: string,
  source: string,
  quote: string,
  taskTitle: string,
): boolean {
  if (dropsSourceNegation(source, quote)) return true;
  const parts = segments(source),
    required = words(requirement);
  // Check each possible occurrence separately; a short ambiguous quote cannot
  // silently select a positive occurrence over a negative one elsewhere.
  return occurrences(source, quote).some((at) => {
    const scopes = overlappingScopes(parts, at, at + quote.length).map((p) =>
      assertedScope(p.text),
    );
    const positive = words(scopes.filter((s) => !hasNegation(s)).join(' '));
    const positiveScore = overlap(required, positive).length;
    return scopes.some((scope) => {
      if (!hasNegation(scope)) return false;
      const uncertain = epistemic(scope);
      if (uncertain && artifactTask(taskTitle)) {
        const execution = activityGroups.find((group) =>
          group.test(fold(scope)),
        );
        if (execution && !execution.test(fold(requirement))) return false;
      }
      if (!uncertain && hasNegation(requirement)) return false;
      const shared = overlap(required, words(scope));
      if (!shared.length && positiveScore > 0) return false;
      const missingSpecific = shared.some((w) => !positive.has(w));
      return missingSpecific || shared.length >= positiveScore;
    });
  });
}
