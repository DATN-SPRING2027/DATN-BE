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
}>;

const SEVERITY_RANK: Record<SensitiveSeverity, number> = {
  CRITICAL: 3,
  HIGH: 2,
  MEDIUM: 1,
};

/** Spans that must never be detected/masked again (our own markers). */
const RESERVED_SPAN =
  /\[\[WN_SEC:[A-Z_]+:[a-f0-9]{10,16}\]\]|__WN_PROTECTED_[A-Za-z0-9_]+?__/g;

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
  const overlapsReserved = (start: number, end: number) =>
    reserved.some((r) => start < r.end && end > r.start);

  const candidates: { finding: SensitiveFinding; order: number }[] = [];
  rules.forEach((rule, order) => {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (!value.trim()) continue;
      const start = match.index;
      const end = start + value.length;
      if (overlapsReserved(start, end)) continue;
      if (
        rule.validate &&
        !rule.validate(value, {
          text,
          start,
          end,
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
          start,
          end,
          value,
        },
        order,
      });
    }
  });

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
