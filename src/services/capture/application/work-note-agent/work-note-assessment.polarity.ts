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
  fold(s)
    .replace(/\bnot only\b|\bkhong chi\b/gu, '')
    .replace(/\b((?:query|truy van)(?:\s+tuy\s+y)?)\s+chua dang ky\b/gu, '$1');
const pendingEpistemic = (s: string) =>
  /\b(?:(?:tests?|testing|verification|deployment)\s+(?:(?:is|are)\s+)?(?:still\s+)?pending|pending\s+(?:tests?|testing|verification|deployment))\b/iu.test(
    fold(s),
  );
export const hasNegation = (s: string) =>
  /\b(?:not|never|cannot|can['’]t|doesn['’]t|didn['’]t|isn['’]t|wasn['’]t|hasn['’]t|haven['’]t|won['’]t|untested|unverified|unknown|chua|khong|cam|forbid|forbids|forbidden|prohibit|prohibits|prohibited)\b/iu.test(
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
    return /\b(?:not|never|cannot|can['’]t|doesn['’]t|didn['’]t|isn['’]t|wasn['’]t|hasn['’]t|haven['’]t|won['’]t|chua|khong|cam|forbid|forbids|forbidden|prohibit|prohibits|prohibited|(?:no|without)\s+(?:evidence|confirmation|results?))(?:\s+[\p{L}]+){0,3}\s*$/iu.test(
      prefix,
    );
  });
}
function polarityClauses(text: string) {
  const out: { start: number; end: number; text: string }[] = [];
  let start = 0;
  const separator =
    /[;\r\n]|[.!?](?=\s|$)|,\s+(?=(?:chưa|chua|không|khong|not|never|untested|unverified|pending)\b)|\s+(?:và|va|nhưng|nhung|còn|con|but|while|and)\s+(?=(?:chưa|chua|không|khong|not|never|(?:no|without)\s+(?:evidence|confirmation|results?))\b)/giu;
  for (const match of text.matchAll(separator)) {
    const isConjunction = /^[\s,]/u.test(match[0]);
    const end = isConjunction ? match.index : match.index + match[0].length;
    if (end > start) out.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  if (start < text.length)
    out.push({ start, end: text.length, text: text.slice(start) });
  return out;
}

function words(s: string) {
  const normalized = fold(s);
  const tokens = normalized.match(/[a-z0-9_]+/gu) ?? [];
  const stop =
    /^(?:the|a|an|is|are|was|were|has|have|been|be|bi|must|should|on|in|of|to|for|and|or|not|never|cannot|untested|unverified|unknown|test|tests|tested|testing|verify|verified|verification|da|chua|khong|co|duoc|can|phai|va|hoac|la|thi|khi|voi|cho|cua|cac|nhung|mot|tu|tren|sau|truoc|toi|kiem|thu|trien|khai|dien|tap|do|chay|viet|hoan|thanh)$/u;
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
  const parts = polarityClauses(source),
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

const ADVERSE_OUTCOME_RE =
  /\b(?:that bai|bi loi|gap loi|bao loi|khong thanh cong|khong dat|chua dat|bi chan|timeout|timed out|failed|fails|failure|errored|error|crashed|crash|aborted|broken|rollback|reverted)\b/iu;

const CONDITIONAL_MARKER_RE =
  /\b(?:nếu|neu|khi|trừ\s+khi|tru\s+khi|miễn\s+là|mien\s+la|chỉ\s+khi|chi\s+khi|trong\s+trường\s+hợp|trong\s+truong\s+hop|if|when|unless|provided(?:\s+that)?|only\s+if|in\s+case)\b/iu;

export function normalizeClaimLiteral(s: string): string {
  return s
    .normalize('NFC')
    .toLocaleLowerCase('vi')
    .replace(/["'“”‘’]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.;,:!?]$/u, '')
    .trim();
}

function locateRawContiguousSlice(
  quote: string,
  claimText: string,
): string | null {
  const cleanedClaim = claimText
    .normalize('NFC')
    .trim()
    .replace(/[.;,:!?]$/u, '')
    .trim();
  if (!cleanedClaim) return null;
  const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const patternParts = cleanedClaim
    .split(/\s+/gu)
    .filter(Boolean)
    .map((tok) => escapeRe(tok).replace(/["'“”‘’]/gu, '["\'“”‘’]'));
  if (!patternParts.length) return null;
  const regex = new RegExp(patternParts.join('\\s+'), 'giu');
  const matches = [...quote.normalize('NFC').matchAll(regex)];
  if (matches.length !== 1) return null;
  return matches[0][0];
}

/**
 * D10a (F15 / G2): Deterministic parser check accepting a claim as FULL only
 * when it is a unique, clause-bounded contiguous literal substring of its cited
 * quote and drops no negation, uncertainty, governing condition, or adverse outcome.
 */
export function isContiguousGroundedClaimSubstring(
  source: string,
  quote: string,
  claimText: string,
  taskTitle: string,
): boolean {
  const nq = normalizeClaimLiteral(quote);
  const nc = normalizeClaimLiteral(claimText);
  if (!nc || !nq) return false;

  // C1: Must appear in normalized quote strictly once as a contiguous sequence.
  const idx = nq.indexOf(nc);
  if (idx < 0 || nq.indexOf(nc, idx + 1) >= 0) return false;

  // Token boundary guard: never slice inside a word or identifier.
  if (
    idx > 0 &&
    /[\p{L}\p{N}_]/u.test(nq[idx - 1]) &&
    /[\p{L}\p{N}_]/u.test(nc[0])
  )
    return false;
  const endIdx = idx + nc.length;
  if (
    endIdx < nq.length &&
    /[\p{L}\p{N}_]/u.test(nc[nc.length - 1]) &&
    /[\p{L}\p{N}_]/u.test(nq[endIdx])
  )
    return false;

  // C5: Minimum 3 meaningful content tokens (per polarity words() stopword filter).
  if (words(claimText).size < 3) return false;

  const before = nq.slice(0, idx);
  const after = nq.slice(endIdx);

  // C2: Both ends must sit on strict clause boundaries.
  const validLeft =
    before.trim().length === 0 ||
    /(?:[,;:.!?]|(?:^|\s)(?:và|nhưng|còn|rồi|and|but|while))\s*$/u.test(before);
  const validRight =
    after.trim().length === 0 ||
    /^\s*(?:[,;:.!?]|(?:và|nhưng|còn|rồi|and|but|while)(?:\s|$))/u.test(after);
  if (!validLeft || !validRight) return false;

  // C3: Enclosing sentence/clause must not hold dropped condition, negation,
  // uncertainty, or contrastive/adverse outcome qualifying this claim.
  const sameSentenceBefore = before.split(/[;.!?\r\n]/u).at(-1) ?? '';
  const sameSentenceAfter = after.split(/[;.!?\r\n]/u)[0] ?? '';

  // Governing prefix condition (unless isolated inside an earlier coordinate clause before `, và` / `, and`).
  if (
    CONDITIONAL_MARKER_RE.test(sameSentenceBefore) &&
    !/,\s*(?:và|còn|rồi|and|while)\s*$/iu.test(sameSentenceBefore)
  ) {
    return false;
  }
  // Trailing conditional suffix qualifying the claim (e.g. "API trả 200 nếu bật cờ X").
  if (
    /^\s*,?\s*(?:nếu|neu|khi|trừ\s+khi|tru\s+khi|miễn\s+là|mien\s+la|chỉ\s+khi|chi\s+khi|trong\s+trường\s+hợp|trong\s+truong\s+hop|if|when|unless|provided(?:\s+that)?|only\s+if|in\s+case)\b/iu.test(
      sameSentenceAfter,
    )
  ) {
    return false;
  }
  // Concessive prefix ("Mặc dù...", "Although...") cannot have its main contrast stripped or vice versa.
  if (
    /^\s*(?:mặc\s+dù|mac\s+du|dù|du|tuy(?:\s+nhiên)?|although|though|even\s+though|despite)\b/iu.test(
      sameSentenceBefore,
    )
  ) {
    return false;
  }
  // Trailing contrastive conjunction ("nhưng...", "but...", "yet...", "however...") qualifies the preceding clause.
  if (
    /^\s*,?\s*(?:nhưng|nhung|tuy\s+nhiên|tuy\s+nhien|song|dù|du|mặc\s+dù|mac\s+du|but|yet|however|although|though)\b/iu.test(
      sameSentenceAfter,
    )
  ) {
    return false;
  }
  // Adjacent adverse outcome in the same sentence without an independent coordinate conjunction (", thất bại", ", failed").
  if (
    !hasNegation(claimText) &&
    !ADVERSE_OUTCOME_RE.test(fold(claimText)) &&
    sameSentenceAfter.trim().length > 0 &&
    !/^\s*,?\s*(?:và|còn|rồi|and|while)\b/iu.test(sameSentenceAfter) &&
    (ADVERSE_OUTCOME_RE.test(fold(sameSentenceAfter)) ||
      hasExplicitUncertainty(sameSentenceAfter))
  ) {
    return false;
  }

  // Locate raw slice inside quote for C4 & C6 source-level negation/polarity checks.
  const rawSlice = locateRawContiguousSlice(quote, claimText);
  if (!rawSlice || !source.includes(rawSlice)) return false;

  // C4: Must not start after a governing source negator.
  if (
    !hasNegation(claimText) &&
    (dropsSourceNegation(source, quote) ||
      dropsSourceNegation(source, rawSlice))
  ) {
    return false;
  }

  // C6: Unconditional polarity conflict veto across all verbs/nouns on both quote and slice.
  if (
    !hasNegation(claimText) &&
    (coveragePolarityConflict(claimText, source, quote, taskTitle) ||
      coveragePolarityConflict(claimText, source, rawSlice, taskTitle))
  ) {
    return false;
  }

  return true;
}
