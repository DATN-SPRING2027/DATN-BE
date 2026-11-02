import {
  detectSensitiveData,
  stripInvisible,
  summarizeFindings,
} from './sensitive-data.detector';
import { isDummyValue, luhnValid } from './sensitive-data.rules';
import {
  MaskVault,
  maskWithVault,
  placeholdersIn,
} from './sensitive-data.masker';
import {
  OutputSecurityViolation,
  validateModelOutput,
} from './output-security.validator';
import type { SecurityPolicy } from './security.types';
import {
  FAKE,
  NEGATIVE_SAMPLES,
  POSITIVE_SAMPLES,
} from './fixtures/sensitive-corpus';
import {
  FEW_SHOTS,
  OPERATION_POLICY,
  SYSTEM_PROMPT,
} from '../work-note-agent.prompt';

const policy: SecurityPolicy = {
  mode: 'enforce',
  maxFindings: 25,
  maskInternalEmail: false,
  internalEmailDomains: ['continuum.vn'],
  placeholderKey: Buffer.alloc(32, 7),
};
const detect = (text: string) =>
  detectSensitiveData(text, {
    maskInternalEmail: policy.maskInternalEmail,
    internalEmailDomains: policy.internalEmailDomains,
  });

describe('Sensitive Data Detection', () => {
  it.each(POSITIVE_SAMPLES)('detects %s', (_label, text, category, value) => {
    const findings = detect(text);
    expect(findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ category, value })]),
    );
  });

  it.each(NEGATIVE_SAMPLES.map((s) => [s]))(
    'does not flag ordinary engineering prose: %s',
    (text) => {
      expect(detect(text)).toEqual([]);
    },
  );

  it('blocks PEM private keys and masks the whole block', () => {
    const [finding] = detect(`Key cũ:\n${FAKE.privateKey}\nđã thu hồi`);
    expect(finding).toMatchObject({ category: 'PRIVATE_KEY', action: 'BLOCK' });
    expect(finding.value).toBe(FAKE.privateKey);
  });

  it('keeps internal emails unless configured, and never flags example domains', () => {
    expect(detect(`gửi ${FAKE.internalEmail}`)).toEqual([]);
    expect(
      detectSensitiveData(`gửi ${FAKE.internalEmail}`, {
        maskInternalEmail: true,
        internalEmailDomains: ['continuum.vn'],
      }),
    ).toEqual([expect.objectContaining({ category: 'EMAIL' })]);
  });

  it('masks only the value of key/value pairs so the field name stays readable', () => {
    const [finding] = detect(`DB_PASSWORD=${FAKE.dbPassword}`);
    expect(finding.value).toBe(FAKE.dbPassword);
    expect(`DB_PASSWORD=${FAKE.dbPassword}`.slice(0, finding.start)).toBe(
      'DB_PASSWORD=',
    );
  });

  it('resolves overlaps by severity (connection password beats the e-mail lookalike)', () => {
    const findings = detect(FAKE.mongoUri('Pa55word99'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: 'CONNECTION_STRING',
      value: 'Pa55word99',
    });
  });

  it('ignores our own placeholders and protection markers', () => {
    expect(
      detect(
        'token: [[WN_SEC:CREDENTIAL:0123456789]] __WN_PROTECTED_abcdef012345_0__',
      ),
    ).toEqual([]);
  });

  it('summaries never include values or offsets', () => {
    const summary = summarizeFindings(detect(`mk: ${FAKE.dbPassword}`));
    expect(JSON.stringify(summary)).not.toContain(FAKE.dbPassword);
    expect(summary[0]).toEqual({
      ruleId: 'password-assignment',
      category: 'PASSWORD',
      severity: 'HIGH',
      count: 1,
    });
  });

  it('static prompts and few-shots contain nothing detectable', () => {
    const statics = [
      SYSTEM_PROMPT,
      ...Object.values(OPERATION_POLICY),
      ...FEW_SHOTS.map((f) => JSON.stringify(f)),
    ];
    for (const text of statics) expect(detect(text)).toEqual([]);
  });

  it('helpers: Luhn and dummy values', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(isDummyValue('<your-api-key>')).toBe(true);
    expect(isDummyValue('process.env.SECRET')).toBe(true);
    expect(isDummyValue('S3cr3t!')).toBe(false);
  });
});

describe('Data Masking & Redaction', () => {
  it('uses stable, typed, non-reversible placeholders', () => {
    const a = new MaskVault(policy.placeholderKey);
    const b = new MaskVault(policy.placeholderKey);
    const pa = a.placeholderFor('PASSWORD', FAKE.dbPassword);
    expect(pa).toMatch(/^\[\[WN_SEC:PASSWORD:[a-f0-9]{10}\]\]$/);
    expect(b.placeholderFor('PASSWORD', FAKE.dbPassword)).toBe(pa);
    expect(pa).not.toContain(FAKE.dbPassword);
    expect(
      new MaskVault(Buffer.alloc(32, 9)).placeholderFor(
        'PASSWORD',
        FAKE.dbPassword,
      ),
    ).not.toBe(pa);
  });

  it('replaces every occurrence and truncated boundary fragments', () => {
    const vault = new MaskVault(policy.placeholderKey);
    const ph = vault.placeholderFor('TOKEN', FAKE.jwt);
    expect(maskWithVault(`a ${FAKE.jwt} b ${FAKE.jwt}`, vault)).toBe(
      `a ${ph} b ${ph}`,
    );
    // e.g. the 320-char selection window cut a token in half
    expect(maskWithVault(`trước ${FAKE.jwt.slice(0, 30)}`, vault)).toBe(
      `trước ${ph}`,
    );
    expect(maskWithVault(`${FAKE.jwt.slice(-25)} sau`, vault)).toBe(
      `${ph} sau`,
    );
    expect(vault.reveal(ph)).toBe(FAKE.jwt);
    expect(placeholdersIn(`x ${ph} y`)).toEqual([ph]);
  });
});

describe('Output Security Validation', () => {
  const setup = () => {
    const vault = new MaskVault(policy.placeholderKey);
    const ph = vault.placeholderFor('PASSWORD', FAKE.dbPassword);
    return {
      vault,
      ph,
      context: {
        kind: 'rewrite' as const,
        policy,
        vault,
        maskedInputText: `DB_PASSWORD=${ph} https://docs.internal/run`,
        rawInputText: `DB_PASSWORD=${FAKE.dbPassword} https://docs.internal/run`,
        expectedPlaceholders: [ph],
      },
    };
  };
  const out = (replacementText: string, message = 'Đã sửa.') =>
    JSON.stringify({
      status: 'SUGGESTION_READY',
      message,
      suggestion: {
        replacementText,
        suggestedTitle: null,
        changeSummary: ['x'],
      },
      questions: [],
      uncertainties: [],
    });

  it('passes valid placeholders through untouched', () => {
    const { ph, context } = setup();
    const raw = out(`Mật khẩu DB: ${ph}`);
    expect(validateModelOutput(raw, context)).toEqual({
      content: raw,
      decision: 'PASS',
      issues: [],
    });
  });

  it.each([
    ['distorted placeholder', (ph: string) => out(ph.replace(']]', ']'))],
    ['unknown placeholder', () => out('[[WN_SEC:PASSWORD:ffffffffff]]')],
    ['lost placeholder', () => out('Đã rút gọn, bỏ dòng mật khẩu.')],
    [
      'guessed secret in applied text',
      (ph: string) => out(`${ph} hoặc password=Guess1234!`),
    ],
    [
      'untrusted url in applied text',
      (ph: string) => out(`${ph} xem https://evil.example/x`),
    ],
  ])('rejects %s', (_label, build) => {
    const { ph, context } = setup();
    expect(() => validateModelOutput(build(ph), context)).toThrow(
      OutputSecurityViolation,
    );
  });

  it('sanitizes chat-only text instead of rejecting (no unmask in chat)', () => {
    const { ph, context } = setup();
    const result = validateModelOutput(
      out(
        ph,
        `Liên hệ ${FAKE.personalEmail} ![x](https://evil.example/p.png?d=1)`,
      ),
      context,
    );
    expect(result.decision).toBe('SANITIZED');
    expect(result.content).not.toContain(FAKE.personalEmail);
    expect(result.content).not.toContain('evil.example');
    expect(result.content).toContain(ph); // display text keeps the placeholder masked
  });

  it('allows URLs that were present in the request', () => {
    const { ph, context } = setup();
    expect(
      validateModelOutput(out(`${ph} https://docs.internal/run`), context)
        .decision,
    ).toBe('PASS');
  });

  it('sanitizes zero-width obfuscated PII and untrusted URLs in display fields and rejects them in applied fields', () => {
    const { ph, context } = setup();
    const zwEmail = 'nguyen.van.a1990@\u200Bgmail.\u200Dcom';
    const zwPhone = '0912\u200B345\u2060678';
    const zwUrl = 'https://evil.\u200Bexample/exfil';
    const zwImg = '![beacon](https://evil.\u200Bexample/p.png?d=1)';

    const sanitized = validateModelOutput(
      out(ph, `Liên hệ ${zwEmail} hoặc ${zwPhone}; xem ${zwUrl} ${zwImg}`),
      context,
    );
    expect(sanitized.decision).toBe('SANITIZED');
    const cleanOutput = stripInvisible(sanitized.content);
    expect(cleanOutput).not.toContain('nguyen.van.a1990@gmail.com');
    expect(cleanOutput).not.toContain('0912345678');
    expect(cleanOutput).not.toContain('evil.example');
    expect(sanitized.content).toContain('[đã ẩn: EMAIL]');
    expect(sanitized.content).toContain('[đã ẩn: PHONE]');
    expect(sanitized.content).toContain('[liên kết đã bị loại bỏ]');

    expect(() => validateModelOutput(out(`${ph} ${zwEmail}`), context)).toThrow(
      OutputSecurityViolation,
    );
    expect(() => validateModelOutput(out(`${ph} ${zwUrl}`), context)).toThrow(
      OutputSecurityViolation,
    );
  });
});
