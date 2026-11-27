import { SENSITIVE_RULES, type SensitiveRule } from './sensitive-data.rules';
import type {
  FindingSummary,
  SensitiveFinding,
  SensitiveSeverity,
} from './security.types';

export type DetectorOptions = Readonly<{
  maskInternalEmail?: boolean;
  internalEmailDomains?: readonly string[];
  rules?: readonly SensitiveRule[];
  /**
   * Server-generated literal-protection prefixes (e.g. `__WN_PROTECTED_<nonce>_`)
   * that are trusted during post-protection residual scans ONLY. User-supplied
   * `__WN_PROTECTED_...__` tokens are NEVER trusted.
   */
  exemptProtectedPrefixes?: readonly string[];
}>;

const SEVERITY_RANK: Record<SensitiveSeverity, number> = {
  CRITICAL: 3,
  HIGH: 2,
  MEDIUM: 1,
};

/** Spans that must never be detected/masked again (strict HMAC placeholders only). */
const RESERVED_SPAN = /\[\[WN_SEC:[A-Z_]+:[a-f0-9]{10,16}\]\]/g;

/** User-supplied lookalike protection markers that could be abused to hide secrets (SEC-BE-003). */
const USER_PROTECTED_TOKEN = /__WN_PROTECTED_([A-Za-z0-9_]+?)__/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Invisible characters commonly used to split secrets and evade detection. */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '');
}

/**
 * Deterministic, regex-based detection. Pure and side-effect free.
 * Overlaps are resolved by severity, then span length, then rule order.
 */
export function detectSensitiveData(
  text: string,
  options: DetectorOptions = {},
): SensitiveFinding[] {
  if (!text) return [];
  const rules = options.rules ?? SENSITIVE_RULES;
  const reserved: { start: number; end: number }[] = [];
  for (const match of text.matchAll(RESERVED_SPAN))
    reserved.push({ start: match.index, end: match.index + match[0].length });
  for (const prefix of options.exemptProtectedPrefixes ?? []) {
    if (!prefix || !/^__WN_PROTECTED_[A-Za-z0-9]+_$/.test(prefix)) continue;
    const pattern = new RegExp(`${escapeRegExp(prefix)}\\d+__`, 'g');
    for (const match of text.matchAll(pattern)) {
      reserved.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  const overlapsReserved = (start: number, end: number) =>
    reserved.some((r) => start < r.end && end > r.start);

  const candidates: { finding: SensitiveFinding; order: number }[] = [];
  const scanText = (
    input: string,
    offsetMapper?: (
      localStart: number,
      localEnd: number,
    ) => {
      start: number;
      end: number;
      value: string;
    },
  ) => {
    rules.forEach((rule, order) => {
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      for (const match of input.matchAll(pattern)) {
        const rawMatch = match[0];
        if (!rawMatch.trim()) continue;
        const localStart = match.index;
        const localEnd = localStart + rawMatch.length;
        const mapped = offsetMapper
          ? offsetMapper(localStart, localEnd)
          : { start: localStart, end: localEnd, value: rawMatch };
        if (!offsetMapper && overlapsReserved(mapped.start, mapped.end)) {
          continue;
        }
        if (
          rule.validate &&
          !rule.validate(rawMatch, {
            text: input,
            start: localStart,
            end: localEnd,
            maskInternalEmail: options.maskInternalEmail ?? false,
            internalEmailDomains: options.internalEmailDomains ?? [],
          })
        )
          continue;
        candidates.push({
          finding: {
            ruleId: rule.id,
            category: rule.category,
            severity: rule.severity,
            action: rule.action,
            start: mapped.start,
            end: mapped.end,
            value: mapped.value,
          },
          order,
        });
      }
    });
  };

  scanText(text);

  // SEC-BE-003: Unwrap non-exempt user-supplied `__WN_PROTECTED_...__` tokens
  // so `_` word characters around embedded secrets (e.g. AWS/GitHub/OpenAI keys)
  // cannot defeat `\b` boundaries or hide credentials from DLP scanning.
  for (const tokenMatch of text.matchAll(USER_PROTECTED_TOKEN)) {
    const tokenStart = tokenMatch.index;
    const tokenEnd = tokenStart + tokenMatch[0].length;
    if (overlapsReserved(tokenStart, tokenEnd)) continue;
    const inner = tokenMatch[1];
    if (!inner) continue;
    const innerOffset = tokenStart + '__WN_PROTECTED_'.length;
    scanText(` ${inner} `, (localStart, localEnd) => {
      const adjustedStart = Math.max(0, localStart - 1);
      const adjustedEnd = Math.min(inner.length, localEnd - 1);
      const absStart = innerOffset + adjustedStart;
      const absEnd = innerOffset + adjustedEnd;
      return {
        start: absStart,
        end: absEnd,
        value: text.slice(absStart, absEnd),
      };
    });
  }

  const span = (f: SensitiveFinding) => f.end - f.start;
  candidates.sort(
    (a, b) =>
      SEVERITY_RANK[b.finding.severity] - SEVERITY_RANK[a.finding.severity] ||
      span(b.finding) - span(a.finding) ||
      a.order - b.order,
  );
  const selected: SensitiveFinding[] = [];
  for (const { finding } of candidates) {
    if (selected.some((s) => finding.start < s.end && finding.end > s.start))
      continue;
    selected.push(finding);
  }
  return selected.sort((a, b) => a.start - b.start);
}

/** Safe-to-log projection: never contains values or offsets. */
export function summarizeFindings(
  findings: readonly SensitiveFinding[],
): FindingSummary[] {
  const byRule = new Map<string, FindingSummary>();
  for (const f of findings) {
    const current = byRule.get(f.ruleId);
    byRule.set(f.ruleId, {
      ruleId: f.ruleId,
      category: f.category,
      severity: f.severity,
      count: (current?.count ?? 0) + 1,
    });
  }
  return [...byRule.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}
