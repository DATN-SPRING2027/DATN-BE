import type {
  SensitiveAction,
  SensitiveCategory,
  SensitiveSeverity,
} from './security.types';

export type RuleContext = Readonly<{
  text: string;
  start: number;
  end: number;
  maskInternalEmail: boolean;
  internalEmailDomains: readonly string[];
}>;

export type SensitiveRule = Readonly<{
  id: string;
  category: SensitiveCategory;
  severity: SensitiveSeverity;
  action: SensitiveAction;
  /** Must be global. The whole match is the sensitive value (use lookbehind for keys). */
  pattern: RegExp;
  validate?: (value: string, context: RuleContext) => boolean;
}>;

// ---------------------------------------------------------------------------
// Validators & helpers
// ---------------------------------------------------------------------------

/** Values that are documentation placeholders or code references, not secrets. */
export function isDummyValue(raw: string): boolean {
  const value = raw.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!value) return true;
  if (/^\[\[WN_SEC:/.test(value) || value.includes('__WN_PROTECTED_'))
    return true;
  if (/^(?:\*+|x{3,}|\.{3,}|-+|_+|#+|•+)$/i.test(value)) return true;
  if (/^(?:\$\{?|%[A-Z_]|\{\{|<)/i.test(value)) return true;
  if (
    /^(?:process\.env|import\.meta\.env|os\.environ|env\.|config\.|settings\.)/i.test(
      value,
    )
  )
    return true;
  if (
    /^(?:null|undefined|none|nil|true|false|string|number|boolean|any|object|required|optional|empty|redacted|hidden|masked|secret|password|passwd|token|changeme|placeholder|dummy|sample|example|test|todo|tbd|n\/a|your[_-]?[a-z_-]*|my[_-]?[a-z_-]*)$/i.test(
      value,
    )
  )
    return true;
  // Code identifier chains (this.token, cfg.auth.secret) without digits.
  if (
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) &&
    !/\d/.test(value)
  )
    return true;
  return false;
}

export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const digitsOf = (value: string) => value.replace(/\D/g, '');

/** Vietnamese CCCD province codes (Circular 07/2016/TT-BCA). */
const CCCD_PROVINCES = new Set(
  '001 002 004 006 008 010 011 012 014 015 017 019 020 022 024 025 026 027 030 031 033 034 035 036 037 038 040 042 044 045 046 048 049 051 052 054 056 058 060 062 064 066 067 068 070 072 074 075 077 079 080 082 083 084 086 087 089 091 092 093 094 095 096'.split(
    ' ',
  ),
);

const followedByCall = (context: RuleContext) =>
  /^\s*\(/.test(context.text.slice(context.end, context.end + 3));

const looksLikeSecretValue = (value: string) =>
  /\d/.test(value) ||
  value.length >= 16 ||
  (/[a-z]/.test(value) && /[A-Z]/.test(value)) ||
  /[^A-Za-z0-9]/.test(value);

const EXAMPLE_EMAIL_DOMAIN =
  /(?:^|\.)(?:example\.(?:com|org|net)|test|invalid|localhost|local)$/i;
const NON_PERSONAL_EMAIL_LOCAL =
  /^(?:git|noreply|no-reply|donotreply|do-not-reply)$/i;

// Secret value terminators: whitespace, quotes, separators and brackets.
// `\x60` is a backtick (an escaped backtick is invalid in unicode-mode regex).
const V = String.raw`[^\s"'\x60,;<>()\[\]{}\\]`;

// ---------------------------------------------------------------------------
// Rule registry (order matters only as a tie-breaker for overlaps)
// ---------------------------------------------------------------------------
export const SENSITIVE_RULES: readonly SensitiveRule[] = [
  {
    id: 'private-key-block',
    category: 'PRIVATE_KEY',
    severity: 'CRITICAL',
    action: 'BLOCK',
    pattern:
      /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  {
    id: 'aws-access-key-id',
    category: 'CLOUD_KEY',
    severity: 'CRITICAL',
    action: 'MASK',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
  },
  {
    id: 'aws-secret-access-key',
    category: 'CLOUD_KEY',
    severity: 'CRITICAL',
    action: 'MASK',
    pattern:
      /(?<=aws[_-]?secret[_-]?(?:access[_-]?)?key["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi,
  },
  {
    id: 'google-api-key',
    category: 'CLOUD_KEY',
    severity: 'CRITICAL',
    action: 'MASK',
    pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  },
  {
    id: 'google-oauth-client-secret',
    category: 'CLOUD_KEY',
    severity: 'CRITICAL',
    action: 'MASK',
    pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'openai-anthropic-key',
    category: 'API_KEY',
    severity: 'CRITICAL',
    action: 'MASK',
    pattern: /\bsk-(?:proj-|svcacct-|admin-|ant-)?[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'stripe-secret-key',
    category: 'API_KEY',
    severity: 'CRITICAL',
    action: 'MASK',
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  },
  {
    id: 'github-token',
    category: 'API_KEY',
    severity: 'CRITICAL',
    action: 'MASK',
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})/g,
  },
  {
    id: 'gitlab-token',
    category: 'API_KEY',
    severity: 'CRITICAL',
    action: 'MASK',
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'slack-token',
    category: 'API_KEY',
    severity: 'CRITICAL',
    action: 'MASK',
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: 'slack-webhook',
    category: 'API_KEY',
    severity: 'HIGH',
    action: 'MASK',
    pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g,
  },
  {
    id: 'sendgrid-key',
    category: 'API_KEY',
    severity: 'CRITICAL',
    action: 'MASK',
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  },
  {
    id: 'telegram-bot-token',
    category: 'API_KEY',
    severity: 'HIGH',
    action: 'MASK',
    pattern: /(?<!\d)\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/g,
  },
  {
    id: 'jwt',
    category: 'TOKEN',
    severity: 'HIGH',
    action: 'MASK',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    id: 'bearer-token',
    category: 'TOKEN',
    severity: 'HIGH',
    action: 'MASK',
    pattern: /(?<=\bBearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
    validate: (value) => !isDummyValue(value),
  },
  {
    id: 'basic-auth',
    category: 'TOKEN',
    severity: 'HIGH',
    action: 'MASK',
    pattern: /(?<=\bBasic\s+)[A-Za-z0-9+/]{12,}={0,2}(?![A-Za-z0-9+/=])/g,
    validate: (value) =>
      /[\d+/=]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value)),
  },
  {
    id: 'cookie-header',
    category: 'TOKEN',
    severity: 'HIGH',
    action: 'MASK',
    pattern: /(?<=\b(?:set-)?cookie\s*:\s*)[^\r\n]{12,2000}/gi,
    validate: (value) => /=/.test(value) && /\d/.test(value),
  },
  {
    id: 'connection-string-password',
    category: 'CONNECTION_STRING',
    severity: 'HIGH',
    action: 'MASK',
    pattern:
      /(?<=\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/"'`]{0,100}:)[^\s@/"'`]{1,200}(?=@)/gi,
    validate: (value) => !isDummyValue(value),
  },
  {
    id: 'password-assignment',
    category: 'PASSWORD',
    severity: 'HIGH',
    action: 'MASK',
    pattern: new RegExp(
      String.raw`(?<=(?:\b[\w.-]*(?:password|passwd|passphrase|pwd)|\bmk|mật\s?khẩu|mat\s?khau|matkhau)["']?\s*(?:[:=]|=>)\s*["']?)${V}{4,128}`,
      'giu',
    ),
    validate: (value, context) =>
      !isDummyValue(value) && !followedByCall(context),
  },
  {
    id: 'password-statement',
    category: 'PASSWORD',
    severity: 'HIGH',
    action: 'MASK',
    pattern: new RegExp(
      String.raw`(?<=(?:\bpassword|\bpasswd|\bmk|mật\s?khẩu|mat\s?khau|matkhau)\s+(?:là|la|is)\s+["']?)${V}{4,128}`,
      'giu',
    ),
    // "mật khẩu là bắt buộc" is prose; real passwords contain digits/symbols.
    validate: (value) =>
      !isDummyValue(value) && /[\d!@#$%^&*?_~.+-]/.test(value),
  },
  {
    id: 'credential-assignment',
    category: 'CREDENTIAL',
    severity: 'HIGH',
    action: 'MASK',
    pattern: new RegExp(
      String.raw`(?<=\b[\w.-]*(?:secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth[_-]?key|signing[_-]?key|session[_-]?key)["']?\s*(?:[:=]|=>)\s*["']?)${V}{8,512}`,
      'gi',
    ),
    validate: (value, context) =>
      !isDummyValue(value) &&
      !followedByCall(context) &&
      looksLikeSecretValue(value),
  },
  {
    id: 'high-entropy-near-keyword',
    category: 'HIGH_ENTROPY_SECRET',
    severity: 'MEDIUM',
    action: 'MASK',
    pattern:
      /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{32,256}={0,2}(?![A-Za-z0-9+/=_-])/g,
    validate: (value, context) => {
      if (isDummyValue(value)) return false;
      if (/^[a-f0-9]+$/i.test(value)) return false; // hashes / git SHAs
      if ((value.match(/\//g) ?? []).length >= 2) return false; // paths
      if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value))
        return false;
      if (shannonEntropy(value) < 4) return false;
      const before = context.text.slice(
        Math.max(0, context.start - 48),
        context.start,
      );
      return /(?:key|secret|token|passw|pwd|mật\s?khẩu|credential|auth|bearer|signature)/iu.test(
        before,
      );
    },
  },
  // ------------------------------- PII ------------------------------------
  {
    id: 'email',
    category: 'EMAIL',
    severity: 'MEDIUM',
    action: 'MASK',
    pattern:
      /(?<![\w.+%-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,24}(?![A-Za-z0-9-])/g,
    validate: (value, context) => {
      const [local, domain] = value.toLowerCase().split('@');
      if (NON_PERSONAL_EMAIL_LOCAL.test(local)) return false;
      if (EXAMPLE_EMAIL_DOMAIN.test(domain)) return false;
      const internal = context.internalEmailDomains.some(
        (d) => domain === d || domain.endsWith(`.${d}`),
      );
      return !internal || context.maskInternalEmail;
    },
  },
  {
    id: 'phone-vn-mobile',
    category: 'PHONE',
    severity: 'MEDIUM',
    action: 'MASK',
    pattern:
      /(?<![\d+])(?:\+84|0084|0)[\s.-]?[35789]\d(?:[\s.-]?\d){7}(?![\d])/g,
  },
  {
    id: 'phone-vn-landline',
    category: 'PHONE',
    severity: 'MEDIUM',
    action: 'MASK',
    pattern: /(?<![\d+])(?:\+84|0084|0)[\s.-]?2\d(?:[\s.-]?\d){8}(?![\d])/g,
  },
  {
    id: 'national-id-with-label',
    category: 'NATIONAL_ID',
    severity: 'HIGH',
    action: 'MASK',
    pattern:
      /(?<=(?:\bcmnd|\bcmt|\bcccd|chứng\s?minh(?:\s?nhân\s?dân|\s?thư)?|căn\s?cước(?:\s?công\s?dân)?|định\s?danh|\bid\s?card|\bpassport|hộ\s?chiếu)(?:\s*(?:số|so|no\.?|number))?\s*[:：]?\s*)(?:\d{12}|\d{9}|[A-Z]\d{7,8})(?![\dA-Za-z])/giu,
  },
  {
    id: 'national-id-cccd',
    category: 'NATIONAL_ID',
    severity: 'HIGH',
    action: 'MASK',
    pattern: /(?<![\d.,])\d{12}(?![\d.,]?\d)/g,
    validate: (value) => CCCD_PROVINCES.has(value.slice(0, 3)),
  },
  {
    id: 'bank-card',
    category: 'BANK_CARD',
    severity: 'HIGH',
    action: 'MASK',
    pattern: /(?<![\d.])\d(?:[ -]?\d){12,18}(?![\d.])/g,
    validate: (value) => {
      const digits = digitsOf(value);
      if (digits.length < 13 || digits.length > 19) return false;
      if (digits.startsWith('9704'))
        return digits.length === 16 || digits.length === 19;
      return /^[2-6]/.test(digits) && luhnValid(digits);
    },
  },
  {
    id: 'bank-account-with-label',
    category: 'BANK_ACCOUNT',
    severity: 'MEDIUM',
    action: 'MASK',
    pattern:
      /(?<=(?:\bstk|số\s?tk|so\s?tk|số\s?tài\s?khoản|so\s?tai\s?khoan|tài\s?khoản\s?ngân\s?hàng|tai\s?khoan\s?ngan\s?hang|\baccount\s?(?:no\.?|number)|\bacct\s?(?:no\.?)?|\biban)\s*(?:[:：]|là|la|is)?\s*)\d[\d .-]{4,24}\d(?!\d)/giu,
    validate: (value) => {
      const length = digitsOf(value).length;
      return length >= 6 && length <= 19;
    },
  },
];
