import { createHmac, randomBytes, createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type {
  SecurityGatewayMode,
  SecurityPolicy,
  SensitiveCategory,
} from './security.types';

/** ASCII-only so it survives JSON escaping; `[[` avoids Markdown/code collisions. */
export const PLACEHOLDER_PATTERN =
  /\[\[WN_SEC:([A-Z_]+):([a-f0-9]{10,16})\]\]/g;
export const placeholdersIn = (text: string): string[] =>
  [...text.matchAll(new RegExp(PLACEHOLDER_PATTERN.source, 'g'))].map(
    (m) => m[0],
  );

/**
 * Request-scoped mapping placeholder <-> original value. Lives only in memory.
 * Identifiers are HMAC-derived so the same value yields the same placeholder across
 * turns/sources (needed for assessment quotes), without being reversible by the LLM.
 */
export class MaskVault {
  readonly #byPlaceholder = new Map<string, string>();
  readonly #byValue = new Map<string, string>();
  constructor(private readonly key: Buffer) {}

  placeholderFor(category: SensitiveCategory, value: string): string {
    const existing = this.#byValue.get(value);
    if (existing) return existing;
    const digest = createHmac('sha256', this.key).update(value).digest('hex');
    let placeholder = `[[WN_SEC:${category}:${digest.slice(0, 10)}]]`;
    if (
      this.#byPlaceholder.has(placeholder) &&
      this.#byPlaceholder.get(placeholder) !== value
    )
      placeholder = `[[WN_SEC:${category}:${digest.slice(0, 16)}]]`;
    this.#byPlaceholder.set(placeholder, value);
    this.#byValue.set(value, placeholder);
    return placeholder;
  }

  has(placeholder: string): boolean {
    return this.#byPlaceholder.has(placeholder);
  }

  /** Server-side only. Never send the result to the LLM. */
  reveal(placeholder: string): string | undefined {
    return this.#byPlaceholder.get(placeholder);
  }

  get size(): number {
    return this.#byPlaceholder.size;
  }

  /** Values sorted longest first so nested values are replaced correctly. */
  valuesLongestFirst(): { value: string; placeholder: string }[] {
    return [...this.#byValue.entries()]
      .map(([value, placeholder]) => ({ value, placeholder }))
      .sort((a, b) => b.value.length - a.value.length);
  }
}

const MIN_PARTIAL = 8;
const MIN_VALUE_FOR_PARTIAL = 12;

/**
 * Replace every occurrence of every vault value. Also masks truncated fragments of
 * long secrets at string boundaries (e.g. the 320-char `before/after` selection windows).
 */
export function maskWithVault(text: string, vault: MaskVault): string {
  let out = text;
  const entries = vault.valuesLongestFirst();
  for (const { value, placeholder } of entries)
    if (out.includes(value)) out = out.split(value).join(placeholder);
  for (const { value, placeholder } of entries) {
    if (value.length < MIN_VALUE_FOR_PARTIAL) continue;
    for (let k = value.length - 1; k >= MIN_PARTIAL; k--) {
      if (out.startsWith(value.slice(-k))) {
        out = placeholder + out.slice(k);
        break;
      }
    }
    for (let k = value.length - 1; k >= MIN_PARTIAL; k--) {
      if (out.endsWith(value.slice(0, k))) {
        out = out.slice(0, out.length - k) + placeholder;
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Policy from configuration
// ---------------------------------------------------------------------------
let processKey: Buffer | null = null;
let warnedEphemeralKey = false;
const logger = new Logger('WorkNoteSecurityPolicy');

function placeholderKey(configured: string | undefined): Buffer {
  if (configured?.trim())
    return createHash('sha256')
      .update(`wn-sec-v1:${configured.trim()}`)
      .digest();
  if (!processKey) processKey = randomBytes(32);
  if (!warnedEphemeralKey) {
    warnedEphemeralKey = true;
    logger.warn(
      'WORKNOTE_SECURITY_PLACEHOLDER_KEY is not set; using an ephemeral per-process key. Assessment placeholders will change after restart.',
    );
  }
  return processKey;
}

const bool = (value: unknown, fallback: boolean) =>
  value === undefined || value === null || value === ''
    ? fallback
    : value === true || value === 'true';

export function securityPolicyFromConfig(
  config: ConfigService,
): SecurityPolicy {
  const rawMode = String(
    config.get<string>('WORKNOTE_SECURITY_GATEWAY_MODE') ?? 'enforce',
  ).toLowerCase();
  const mode: SecurityGatewayMode =
    rawMode === 'monitor' || rawMode === 'off' ? rawMode : 'enforce';
  const max = Number(
    config.get<string | number>('WORKNOTE_SECURITY_MAX_FINDINGS'),
  );
  return {
    mode,
    maxFindings: Number.isSafeInteger(max) && max > 0 ? max : 25,
    maskInternalEmail: bool(
      config.get<string | boolean>('WORKNOTE_PII_MASK_INTERNAL_EMAIL'),
      false,
    ),
    internalEmailDomains: String(
      config.get<string>('WORKNOTE_SECURITY_INTERNAL_EMAIL_DOMAINS') ?? '',
    )
      .split(',')
      .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean),
    placeholderKey: placeholderKey(
      config.get<string>('WORKNOTE_SECURITY_PLACEHOLDER_KEY'),
    ),
  };
}
