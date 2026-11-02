import {
  BadGatewayException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  AgentInput,
  AgentMessage,
  AgentResult,
  BoundSuggestion,
} from '../work-note-agent.types';
import { snapshotHash } from '../work-note-agent.protection';
import { agentInputCorpus, maskAgentInput } from './agent-input.masking';
import {
  detectSensitiveData,
  stripInvisible,
  summarizeFindings,
} from './sensitive-data.detector';
import {
  MaskVault,
  PLACEHOLDER_PATTERN,
  maskWithVault,
  placeholdersIn,
} from './sensitive-data.masker';
import {
  OutputSecurityViolation,
  validateModelOutput,
  type OutputValidationKind,
  type OutputValidationResult,
} from './output-security.validator';
import type {
  FindingSummary,
  SecurityPolicy,
  SecurityReport,
  SensitiveCategory,
  SensitiveFinding,
} from './security.types';

export type GuardedRequest = Readonly<{
  messages: AgentMessage[];
  vault: MaskVault;
  findings: readonly FindingSummary[];
  decision: SecurityReport['input']['decision'];
  maskedInputText: string;
  rawInputText: string;
}>;

export type MaskedAgentInput = Readonly<{
  /** Masked copy used ONLY to build the prompt. Bind results to the raw input. */
  input: AgentInput;
  vault: MaskVault;
  findings: readonly SensitiveFinding[];
  rawCorpus: readonly string[];
}>;

/** Mirrors the draft body budget enforced by prepare/parse. */
const MAX_BODY = 30_000;

const logger = new Logger('WorkNoteSecurityGateway');

/** Apply `fn` to every string of a JSON-ish value. */
function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        mapStrings(v, fn),
      ]),
    );
  return value;
}

function collectStrings(value: unknown, out: string[]): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object')
    Object.values(value as Record<string, unknown>).forEach((v) =>
      collectStrings(v, out),
    );
  return out;
}

/** Message content is either JSON (structured payload) or plain text. */
function parseContent(
  content: string,
): { json: true; value: unknown } | { json: false } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('['))
    return { json: false };
  try {
    return { json: true, value: JSON.parse(content) };
  } catch {
    return { json: false };
  }
}

function transformMessage(
  message: AgentMessage,
  fn: (s: string) => string,
): AgentMessage {
  const parsed = parseContent(message.content);
  return {
    role: message.role,
    content: parsed.json
      ? JSON.stringify(mapStrings(parsed.value, fn))
      : fn(message.content),
  };
}

function messageStrings(message: AgentMessage): string[] {
  const parsed = parseContent(message.content);
  return parsed.json ? collectStrings(parsed.value, []) : [message.content];
}

export class SensitiveDataBlockedException extends UnprocessableEntityException {
  constructor(categories: readonly SensitiveCategory[]) {
    super({
      code: 'SENSITIVE_DATA_BLOCKED',
      message:
        'Nội dung chứa dữ liệu bí mật không thể gửi tới Trợ lý AI (ví dụ Private Key). Hãy xoá hoặc thay thế phần đó trước khi dùng AI. Bạn vẫn có thể Lưu ghi chú.',
      categories: [...new Set(categories)],
    });
  }
}

export class OutputSecurityViolationException extends BadGatewayException {
  constructor() {
    super({
      code: 'OUTPUT_SECURITY_VIOLATION',
      message:
        'Phản hồi của Trợ lý AI không đạt kiểm tra bảo mật nên đã bị loại bỏ. Bản nháp của bạn vẫn an toàn; hãy thử lại hoặc Lưu ghi chú không cần AI.',
    });
  }
}

/**
 * Single choke point between Work Note data and any external LLM.
 * 1) detect → 2) block/mask → (LLM) → 3) validate output → 4) optional server-side unmask.
 */
export class WorkNoteLlmSecurityGateway {
  constructor(private readonly policy: SecurityPolicy) {}

  get mode() {
    return this.policy.mode;
  }

  /** Detects across the whole request plus server-side raw corpus (e.g. full draft body). */
  detect(strings: readonly string[]): SensitiveFinding[] {
    return strings.flatMap((s) =>
      detectSensitiveData(stripInvisible(s), {
        maskInternalEmail: this.policy.maskInternalEmail,
        internalEmailDomains: this.policy.internalEmailDomains,
      }),
    );
  }

  /** Throws `SensitiveDataBlockedException` in enforce mode. Never logs values. */
  assertAllowed(findings: readonly SensitiveFinding[]): void {
    const blocking = findings.filter((f) => f.action === 'BLOCK');
    const distinct = new Set(findings.map((f) => f.value)).size;
    if (blocking.length === 0 && distinct <= this.policy.maxFindings) return;
    const categories = (blocking.length ? blocking : findings).map(
      (f) => f.category,
    );
    logger.warn(
      JSON.stringify({
        event: 'worknote.security.blocked',
        mode: this.policy.mode,
        reason: blocking.length ? 'BLOCK_RULE' : 'TOO_MANY_FINDINGS',
        findings: summarizeFindings(findings),
      }),
    );
    if (this.policy.mode === 'enforce')
      throw new SensitiveDataBlockedException(categories);
  }

  /**
   * Source-level masking (assessment sources, historical notes). Placeholders are
   * HMAC-stable, so LLM quotes of masked sources still match on later turns.
   */
  maskTexts(texts: readonly string[]): string[] {
    if (this.policy.mode === 'off') return [...texts];
    const findings = this.detect(texts);
    this.assertAllowed(findings);
    if (findings.length === 0) return [...texts];
    const summary = summarizeFindings(findings);
    if (this.policy.mode === 'monitor') {
      logger.warn(
        JSON.stringify({
          event: 'worknote.security.detected',
          mode: 'monitor',
          scope: 'sources',
          findings: summary,
        }),
      );
      return [...texts];
    }
    const vault = new MaskVault(this.policy.placeholderKey);
    for (const f of findings) vault.placeholderFor(f.category, f.value);
    logger.log(
      JSON.stringify({
        event: 'worknote.security.masked',
        scope: 'sources',
        values: vault.size,
        findings: summary,
      }),
    );
    return texts.map((t) => maskWithVault(stripInvisible(t), vault));
  }

  /**
   * Input-level masking for Rewrite/Chat requests. Runs BEFORE prompt construction so
   * the literal-protection step can never split a secret into separately-sent pieces.
   */
  maskAgentInput(input: AgentInput): MaskedAgentInput {
    const vault = new MaskVault(this.policy.placeholderKey);
    const rawCorpus = agentInputCorpus(input);
    if (this.policy.mode === 'off')
      return { input, vault, findings: [], rawCorpus };
    const findings = this.detect(rawCorpus);
    this.assertAllowed(findings);
    if (this.policy.mode === 'monitor' || findings.length === 0)
      return { input, vault, findings, rawCorpus };
    for (const f of findings) vault.placeholderFor(f.category, f.value);
    return { input: maskAgentInput(input, vault), vault, findings, rawCorpus };
  }

  protectRequest(
    messages: readonly AgentMessage[],
    options: {
      vault?: MaskVault;
      /** Raw server-side strings (already detected upstream); used for URL/trust checks. */
      rawCorpus?: readonly string[];
      priorFindings?: readonly SensitiveFinding[];
    } = {},
  ): GuardedRequest {
    const vault = options.vault ?? new MaskVault(this.policy.placeholderKey);
    const messageText = messages.flatMap(messageStrings);
    const rawStrings = [...messageText, ...(options.rawCorpus ?? [])];
    const rawInputText = rawStrings.join('\n\u0000\n');
    if (this.policy.mode === 'off')
      return {
        messages: [...messages],
        vault,
        findings: [],
        decision: 'ALLOW',
        maskedInputText: rawInputText,
        rawInputText,
      };

    const seen = new Set<string>();
    const findings = [
      ...(options.priorFindings ?? []),
      ...this.detect(messageText),
    ].filter((f) => {
      const key = `${f.ruleId}\u0000${f.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    this.assertAllowed(findings);
    const summary = summarizeFindings(findings);
    if (this.policy.mode === 'monitor') {
      if (findings.length)
        logger.warn(
          JSON.stringify({
            event: 'worknote.security.detected',
            mode: 'monitor',
            findings: summary,
          }),
        );
      return {
        messages: [...messages],
        vault,
        findings: summary,
        decision: findings.length ? 'MONITORED' : 'ALLOW',
        maskedInputText: rawInputText,
        rawInputText,
      };
    }

    for (const f of findings) vault.placeholderFor(f.category, f.value);
    const mask = (s: string) => maskWithVault(stripInvisible(s), vault);
    const masked = vault.size
      ? messages.map((m) => transformMessage(m, mask))
      : [...messages];
    // Defense in depth: nothing detectable may remain in what we send.
    const residual = this.detect(masked.flatMap(messageStrings));
    if (residual.length > 0) {
      logger.error(
        JSON.stringify({
          event: 'worknote.security.residual',
          findings: summarizeFindings(residual),
        }),
      );
      throw new SensitiveDataBlockedException(residual.map((f) => f.category));
    }
    if (findings.length)
      logger.log(
        JSON.stringify({
          event: 'worknote.security.masked',
          values: vault.size,
          findings: summary,
        }),
      );
    return {
      messages: masked,
      vault,
      findings: summary,
      decision: findings.length ? 'MASKED' : 'ALLOW',
      maskedInputText: masked.flatMap(messageStrings).join('\n\u0000\n'),
      rawInputText,
    };
  }

  validateOutput(
    raw: string,
    request: GuardedRequest,
    kind: OutputValidationKind,
    expectedPlaceholders: readonly string[] = [],
  ): OutputValidationResult {
    if (this.policy.mode === 'off')
      return { content: raw, decision: 'PASS', issues: [] };
    try {
      const result = validateModelOutput(raw, {
        kind,
        policy: this.policy,
        vault: request.vault,
        maskedInputText: request.maskedInputText,
        rawInputText: request.rawInputText,
        expectedPlaceholders,
      });
      if (result.issues.length)
        logger.warn(
          JSON.stringify({
            event: 'worknote.security.output_sanitized',
            kind,
            issues: result.issues,
          }),
        );
      if (this.policy.mode === 'monitor')
        return { content: raw, decision: 'PASS', issues: result.issues };
      return result;
    } catch (error) {
      if (!(error instanceof OutputSecurityViolation)) throw error;
      logger.warn(
        JSON.stringify({
          event: 'worknote.security.output_rejected',
          kind,
          issues: error.issues,
        }),
      );
      if (this.policy.mode === 'monitor')
        return { content: raw, decision: 'PASS', issues: error.issues };
      throw new OutputSecurityViolationException();
    }
  }

  /**
   * Server-side unmask of APPLIED Rewrite text only (replacementText/suggestedTitle),
   * then re-binds the suggestion to the RAW draft (revision hash + raw selection) so
   * Apply works on the user's real note. Chat text (message, questions, uncertainties,
   * changeSummary) stays masked. Only placeholders minted by this request are revealed.
   */
  finalizeRewrite(
    result: AgentResult,
    rawInput: AgentInput,
    request: GuardedRequest,
  ): { result: AgentResult; unmasked: number } {
    const suggestion = result.suggestion;
    if (!suggestion) return { result, unmasked: 0 };
    let unmasked = 0;
    const reveal = (text: string | null) =>
      text === null
        ? null
        : text.replace(
            new RegExp(PLACEHOLDER_PATTERN.source, 'g'),
            (placeholder) => {
              const value = request.vault.reveal(placeholder);
              if (value === undefined)
                throw new OutputSecurityViolationException();
              unmasked++;
              return value;
            },
          );
    const replacementText = reveal(suggestion.replacementText);
    const suggestedTitle = reveal(suggestion.suggestedTitle);
    if (replacementText !== null) {
      const replaced = rawInput.selection
        ? rawInput.selection.end - rawInput.selection.start
        : rawInput.draft.body.length;
      if (
        rawInput.draft.body.length - replaced + replacementText.length >
        MAX_BODY
      )
        throw new OutputSecurityViolationException();
    }
    const next: BoundSuggestion = Object.freeze({
      ...suggestion,
      snapshotHash: snapshotHash(rawInput.draft),
      ...(rawInput.selection
        ? { selection: Object.freeze({ ...rawInput.selection }) }
        : {}),
      replacementText,
      suggestedTitle,
    });
    return { result: { ...result, suggestion: next }, unmasked };
  }

  report(
    request: GuardedRequest,
    output: OutputValidationResult | null,
    unmasked = 0,
  ): SecurityReport {
    return {
      mode: this.policy.mode,
      input: {
        decision: request.decision,
        maskedValues: request.decision === 'MASKED' ? request.vault.size : 0,
        findings: request.findings,
      },
      output: {
        decision: output?.decision ?? 'PASS',
        issues: output?.issues ?? [],
        unmasked,
      },
    };
  }
}

/** Placeholders present in the rewrite target (`source.text`) of the last user message. */
export function rewriteTargetPlaceholders(
  messages: readonly AgentMessage[],
): string[] {
  const last = messages.at(-1);
  if (!last) return [];
  const parsed = parseContent(last.content);
  if (!parsed.json) return [];
  const text = (parsed.value as { source?: { text?: unknown } })?.source?.text;
  return typeof text === 'string' ? [...new Set(placeholdersIn(text))] : [];
}
