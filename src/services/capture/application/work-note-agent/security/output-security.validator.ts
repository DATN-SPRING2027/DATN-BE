import { detectSensitiveData, stripInvisible } from './sensitive-data.detector';
import { PLACEHOLDER_PATTERN, type MaskVault } from './sensitive-data.masker';
import type {
  OutputDecision,
  OutputIssue,
  SecurityPolicy,
} from './security.types';

export type OutputValidationKind = 'rewrite' | 'analysis';

export type OutputValidationContext = Readonly<{
  kind: OutputValidationKind;
  policy: SecurityPolicy;
  vault: MaskVault;
  /** All strings actually sent to the LLM (masked). */
  maskedInputText: string;
  /** All raw strings available server-side for this request (may contain secrets). */
  rawInputText: string;
  /** Placeholders present in the rewrite target; each must survive in replacementText. */
  expectedPlaceholders?: readonly string[];
}>;

export type OutputValidationResult = Readonly<{
  content: string;
  decision: OutputDecision;
  issues: readonly OutputIssue[];
}>;

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/g;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
const INVISIBLE_CHAR = /[\u200B-\u200D\u2060\uFEFF\u00AD]/;
const REMOVED_LINK = '[liên kết đã bị loại bỏ]';

function buildCleanMap(text: string): {
  clean: string;
  rawIndex: readonly number[];
} {
  const rawIndex: number[] = [];
  let clean = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (INVISIBLE_CHAR.test(ch)) continue;
    rawIndex.push(i);
    clean += ch;
  }
  return { clean, rawIndex };
}

function replaceCleanSpans(
  rawText: string,
  rawIndex: readonly number[],
  spans: readonly { start: number; end: number; replacement: string }[],
): string {
  if (spans.length === 0) return rawText;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    const rawStart = rawIndex[span.start];
    const rawEnd = rawIndex[span.end - 1] + 1;
    out += rawText.slice(cursor, rawStart) + span.replacement;
    cursor = rawEnd;
  }
  out += rawText.slice(cursor);
  return out;
}

const APPLIED_PATHS = new Set([
  'suggestion.replacementText',
  'suggestion.suggestedTitle',
]);
const REJECTING: ReadonlySet<OutputIssue['code']> = new Set([
  'PLACEHOLDER_DISTORTED',
  'PLACEHOLDER_UNKNOWN',
  'PLACEHOLDER_LOST',
]);

export class OutputSecurityViolation extends Error {
  constructor(public readonly issues: readonly OutputIssue[]) {
    super('Model output failed security validation.');
    this.name = 'OutputSecurityViolation';
  }
}

/**
 * Validates and (for chat-only text) sanitizes raw LLM output BEFORE it is parsed.
 * Throws `OutputSecurityViolation` when applied text could corrupt or leak data.
 */
export function validateModelOutput(
  raw: string,
  context: OutputValidationContext,
): OutputValidationResult {
  const issues: OutputIssue[] = [];
  const knownInput = new Set(
    [
      ...context.maskedInputText.matchAll(
        new RegExp(PLACEHOLDER_PATTERN.source, 'g'),
      ),
    ].map((m) => m[0]),
  );
  const rawUrls = context.rawInputText;

  const inspect = (text: string, field: 'applied' | 'display'): string => {
    let out = text;
    // 1. Placeholder integrity.
    const withoutValid = out.replace(
      new RegExp(PLACEHOLDER_PATTERN.source, 'g'),
      '',
    );
    if (/WN_SEC/i.test(withoutValid))
      issues.push({ code: 'PLACEHOLDER_DISTORTED', field });
    for (const m of out.matchAll(new RegExp(PLACEHOLDER_PATTERN.source, 'g'))) {
      const allowed = context.vault.has(m[0]) || knownInput.has(m[0]);
      if (!allowed) issues.push({ code: 'PLACEHOLDER_UNKNOWN', field });
    }
    // 2. Newly introduced sensitive data (guessed, hallucinated or leaked, including zero-width obfuscation).
    const detectorOpts = {
      maskInternalEmail: context.policy.maskInternalEmail,
      internalEmailDomains: context.policy.internalEmailDomains,
    };
    const sensitiveMap = buildCleanMap(out);
    const findings = detectSensitiveData(
      sensitiveMap.clean,
      detectorOpts,
    ).filter((f) => !context.maskedInputText.includes(f.value));
    for (const f of findings) {
      issues.push({ code: 'NEW_SENSITIVE_DATA', field, category: f.category });
    }
    if (field === 'display' && findings.length > 0) {
      out = replaceCleanSpans(
        out,
        sensitiveMap.rawIndex,
        findings.map((f) => ({
          start: f.start,
          end: f.end,
          replacement: `[đã ẩn: ${f.category}]`,
        })),
      );
    }
    // 3. URLs not present in the request (exfiltration / hallucinated links, including zero-width obfuscation).
    const imageMap = buildCleanMap(out);
    const untrustedImages: {
      start: number;
      end: number;
      replacement: string;
    }[] = [];
    for (const m of imageMap.clean.matchAll(MARKDOWN_IMAGE)) {
      const url = m[1];
      if (rawUrls.includes(url)) continue;
      issues.push({ code: 'UNTRUSTED_URL', field });
      if (field === 'display' && m.index !== undefined) {
        untrustedImages.push({
          start: m.index,
          end: m.index + m[0].length,
          replacement: '',
        });
      }
    }
    if (field === 'display' && untrustedImages.length > 0) {
      out = replaceCleanSpans(out, imageMap.rawIndex, untrustedImages);
    }
    const urlMap = buildCleanMap(out);
    const untrustedUrls: {
      start: number;
      end: number;
      replacement: string;
    }[] = [];
    for (const m of urlMap.clean.matchAll(URL_PATTERN)) {
      const url = m[0];
      if (rawUrls.includes(url)) continue;
      issues.push({ code: 'UNTRUSTED_URL', field });
      if (field === 'display' && m.index !== undefined) {
        untrustedUrls.push({
          start: m.index,
          end: m.index + url.length,
          replacement: REMOVED_LINK,
        });
      }
    }
    if (field === 'display' && untrustedUrls.length > 0) {
      out = replaceCleanSpans(out, urlMap.rawIndex, untrustedUrls);
    }
    // 4. Fail closed on display text if any detectable secret/PII or untrusted URL survived sanitization.
    if (field === 'display') {
      const residualClean = stripInvisible(out);
      const residualSensitive = detectSensitiveData(
        residualClean,
        detectorOpts,
      ).filter((f) => !context.maskedInputText.includes(f.value));
      const residualUrls = (residualClean.match(URL_PATTERN) ?? []).filter(
        (url) => !rawUrls.includes(url),
      );
      if (residualSensitive.length > 0 || residualUrls.length > 0) {
        throw new OutputSecurityViolation(
          dedupe([
            ...issues,
            ...residualSensitive.map((f) => ({
              code: 'NEW_SENSITIVE_DATA' as const,
              field: 'display' as const,
              category: f.category,
            })),
            ...residualUrls.map(() => ({
              code: 'UNTRUSTED_URL' as const,
              field: 'display' as const,
            })),
          ]),
        );
      }
    }
    return out;
  };

  let parsed: unknown;
  let parsedOk = false;
  try {
    parsed = JSON.parse(raw);
    parsedOk = parsed !== null && typeof parsed === 'object';
  } catch {
    parsedOk = false;
  }

  let content = raw;
  if (parsedOk) {
    let changed = false;
    const walk = (value: unknown, path: string): unknown => {
      if (typeof value === 'string') {
        const field =
          context.kind === 'rewrite' && APPLIED_PATHS.has(path)
            ? 'applied'
            : 'display';
        const next = inspect(value, field);
        if (next !== value) changed = true;
        return next;
      }
      if (Array.isArray(value)) return value.map((v) => walk(v, `${path}[]`));
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [
            k,
            walk(v, path ? `${path}.${k}` : k),
          ]),
        );
      return value;
    };
    const sanitized = walk(parsed, '');
    if (changed) content = JSON.stringify(sanitized);
    // 4. Placeholders of the rewrite target must not be dropped (data loss on apply).
    const replacement = (
      parsed as { suggestion?: { replacementText?: unknown } }
    ).suggestion?.replacementText;
    if (context.kind === 'rewrite' && typeof replacement === 'string')
      for (const placeholder of context.expectedPlaceholders ?? [])
        if (!replacement.includes(placeholder))
          issues.push({ code: 'PLACEHOLDER_LOST', field: 'applied' });
  } else {
    // Unparseable output may still be recovered later; treat it strictly.
    content = inspect(raw, context.kind === 'rewrite' ? 'applied' : 'display');
  }

  const rejecting = issues.filter(
    (i) => REJECTING.has(i.code) || i.field === 'applied',
  );
  if (rejecting.length > 0) throw new OutputSecurityViolation(dedupe(issues));
  return {
    content,
    decision: issues.length > 0 ? 'SANITIZED' : 'PASS',
    issues: dedupe(issues),
  };
}

function dedupe(issues: readonly OutputIssue[]): OutputIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.code}|${i.field}|${i.category ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
