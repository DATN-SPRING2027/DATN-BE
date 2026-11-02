/**
 * Pre-LLM security boundary types for the Work Note Agent.
 *
 * Invariants:
 * - Original sensitive values only live in a request-scoped `MaskVault` in memory.
 * - Nothing in this module may log, persist or return an original value except the
 *   explicit server-side unmask of an applied Rewrite suggestion.
 */
export const SENSITIVE_CATEGORIES = [
  'PRIVATE_KEY',
  'CLOUD_KEY',
  'API_KEY',
  'TOKEN',
  'PASSWORD',
  'CONNECTION_STRING',
  'CREDENTIAL',
  'HIGH_ENTROPY_SECRET',
  'EMAIL',
  'PHONE',
  'NATIONAL_ID',
  'BANK_CARD',
  'BANK_ACCOUNT',
] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];
export type SensitiveSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM';
export type SensitiveAction = 'MASK' | 'BLOCK';

export type SensitiveFinding = Readonly<{
  ruleId: string;
  category: SensitiveCategory;
  severity: SensitiveSeverity;
  action: SensitiveAction;
  start: number;
  end: number;
  /** Original value. Never log or persist this field. */
  value: string;
}>;

/** Safe-to-log projection of findings (no values, no offsets). */
export type FindingSummary = Readonly<{
  ruleId: string;
  category: SensitiveCategory;
  severity: SensitiveSeverity;
  count: number;
}>;

export type SecurityGatewayMode = 'enforce' | 'monitor' | 'off';

export type SecurityPolicy = Readonly<{
  mode: SecurityGatewayMode;
  maxFindings: number;
  maskInternalEmail: boolean;
  internalEmailDomains: readonly string[];
  /** HMAC key used to derive stable, non-reversible placeholder identifiers. */
  placeholderKey: Buffer;
}>;

export type OutputIssueCode =
  | 'PLACEHOLDER_DISTORTED'
  | 'PLACEHOLDER_UNKNOWN'
  | 'PLACEHOLDER_LOST'
  | 'NEW_SENSITIVE_DATA'
  | 'UNTRUSTED_URL';

export type OutputIssue = Readonly<{
  code: OutputIssueCode;
  /** `applied` = text that may be written into the note; `display` = chat-only text. */
  field: 'applied' | 'display';
  category?: SensitiveCategory;
}>;

export type OutputDecision = 'PASS' | 'SANITIZED' | 'REJECTED';

export type SecurityReport = Readonly<{
  mode: SecurityGatewayMode;
  input: Readonly<{
    decision: 'ALLOW' | 'MASKED' | 'MONITORED';
    maskedValues: number;
    findings: readonly FindingSummary[];
  }>;
  output: Readonly<{
    decision: OutputDecision;
    issues: readonly OutputIssue[];
    unmasked: number;
  }>;
}>;
