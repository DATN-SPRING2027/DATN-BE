import { ConfigService } from '@nestjs/config';
import { WorkNoteAgentModel } from './work-note-agent.model';
import type { AgentInput } from '../../application/work-note-agent/work-note-agent.types';
import { FAKE } from '../../application/work-note-agent/security/fixtures/sensitive-corpus';

const ALL_SECRETS = [
  FAKE.dbPassword,
  FAKE.jwt,
  FAKE.openAiKey,
  FAKE.personalEmail,
  FAKE.phone,
  FAKE.cccd,
  'Pa55word99',
];

const BODY = [
  'Đã cấu hình kết nối DB cho staging.',
  `DB_PASSWORD=${FAKE.dbPassword}`,
  `Chuỗi kết nối: ${FAKE.mongoUri('Pa55word99')}`,
  `Token test \`${FAKE.jwt}\` hết hạn sau 1h.`,
  `OPENAI=${FAKE.openAiKey}`,
  `Liên hệ khách ${FAKE.personalEmail}, SĐT ${FAKE.phone}, CCCD ${FAKE.cccd}.`,
  'Chưa test production.',
].join('\n');

const input = (overrides: Partial<AgentInput> = {}): AgentInput => ({
  operation: 'grammar',
  scope: 'whole_note',
  instruction: 'Sửa lỗi chính tả',
  workflow: 'TASK_NOTE',
  draft: { revision: 1, title: 'Cấu hình staging', body: BODY },
  task: {
    title: 'Cấu hình DB staging',
    description: `Người phụ trách: ${FAKE.personalEmail}`,
    status: 'IN_PROGRESS',
    steps: [],
  },
  clarifications: [],
  history: [],
  ...overrides,
});

type Captured = { messages: { role: string; content: string }[] };
/** Returns the Nest exception `response.code` thrown by `fn`, or null. */
const thrownCode = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    const response = (error as { getResponse?: () => unknown }).getResponse?.();
    return (response as { code?: string } | undefined)?.code ?? null;
  }
};
const completionFrom = (content: string) =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200 },
  );
const echoSuggestion =
  (
    transform: (sourceText: string) => string = (s) => s,
    message = 'Đã sửa chính tả.',
  ) =>
  (_url: unknown, init?: RequestInit) => {
    const sent = JSON.parse(init?.body as string) as Captured;
    const payload = JSON.parse(sent.messages.at(-1)!.content) as {
      source: { text: string };
    };
    return Promise.resolve(
      completionFrom(
        JSON.stringify({
          status: 'SUGGESTION_READY',
          message,
          suggestion: {
            replacementText: transform(payload.source.text),
            suggestedTitle: null,
            changeSummary: ['Sửa chính tả'],
          },
          questions: [],
          uncertainties: [],
        }),
      ),
    );
  };

const model = (extra: Record<string, unknown> = {}) =>
  new WorkNoteAgentModel(
    new ConfigService({
      WORKNOTE_AGENT_ENABLED: true,
      XKIRO_API_KEY: 'SYNTHETIC_TEST_KEY',
      XKIRO_MODEL: 'test/model',
      WORKNOTE_SECURITY_PLACEHOLDER_KEY: 'test-placeholder-key',
      ...extra,
    }),
  );

describe('Pre-LLM Security Gateway (WorkNoteAgentModel)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('never sends secrets/PII to the provider and restores them server-side in the applied Rewrite', async () => {
    const network = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(echoSuggestion());
    const completion = await model().rewrite(input());

    const sentBody = network.mock.calls[0][1]?.body as string;
    for (const secret of ALL_SECRETS) expect(sentBody).not.toContain(secret);
    expect(sentBody).toContain('[[WN_SEC:PASSWORD:');
    expect(sentBody).toContain('[[WN_SEC:EMAIL:');

    // Decision 1: unmask only in applied text, only after PASS.
    expect(completion.result.suggestion?.replacementText).toBe(BODY);
    expect(completion.result.message).toBe('Đã sửa chính tả.');
    expect(completion.provenance.security).toMatchObject({
      mode: 'enforce',
      input: { decision: 'MASKED' },
      output: { decision: 'PASS' },
    });
    expect(JSON.stringify(completion.provenance)).not.toContain(
      FAKE.dbPassword,
    );
  });

  it('does not leak secrets through truncated selection windows', async () => {
    const network = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(echoSuggestion());
    const target = 'Chưa test production.';
    const start = BODY.indexOf(target);
    const body = `${BODY}\n${'x'.repeat(10)}`;
    await model().rewrite(
      input({
        scope: 'selection',
        draft: { revision: 1, title: 'Cấu hình staging', body },
        selection: { start, end: start + target.length, quote: target },
        includeWholeNoteContext: false,
      }),
    );
    const sentBody = network.mock.calls[0][1]?.body as string;
    for (const secret of ALL_SECRETS) expect(sentBody).not.toContain(secret);
    expect(sentBody).not.toContain(FAKE.jwt.slice(-12));
  });

  it('keeps chat text masked (no unmask outside applied Rewrite)', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const sent = JSON.parse(init?.body as string) as Captured;
      const placeholder = /\[\[WN_SEC:PASSWORD:[a-f0-9]+\]\]/.exec(
        sent.messages.at(-1)!.content,
      )![0];
      return Promise.resolve(
        completionFrom(
          JSON.stringify({
            status: 'ANSWER',
            message: `Mật khẩu hiện là ${placeholder}, nên đổi định kỳ.`,
            suggestion: null,
            questions: [],
            uncertainties: [],
          }),
        ),
      );
    });
    const completion = await model().rewrite(
      input({ operation: 'custom', instruction: 'Có rủi ro gì?' }),
    );
    expect(completion.result.message).toContain('[[WN_SEC:PASSWORD:');
    expect(completion.result.message).not.toContain(FAKE.dbPassword);
  });

  it('never splits a secret into separately-sent literal fragments', async () => {
    const network = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(echoSuggestion());
    await model().rewrite(input());
    const sent = JSON.parse(
      network.mock.calls[0][1]?.body as string,
    ) as Captured;
    const payload = JSON.parse(sent.messages.at(-1)!.content) as {
      protectedFragments: { text: string }[];
    };
    const fragments = payload.protectedFragments.map((f) => f.text);
    // Without input-level masking, `S3cr3t` and `2026` would be sent as fragments.
    expect(fragments).not.toContain('S3cr3t');
    expect(fragments.some((f) => f.startsWith('[[WN_SEC:PASSWORD:'))).toBe(
      true,
    );
  });

  it('refuses selections that cut through a masked value (before quota)', () => {
    const at = BODY.indexOf(FAKE.dbPassword) + 3;
    expect(
      thrownCode(() =>
        model().precheck(
          input({
            scope: 'selection',
            selection: { start: 0, end: at, quote: BODY.slice(0, at) },
          }),
        ),
      ),
    ).toBe('SELECTION_SPLITS_SENSITIVE_DATA');
  });

  it('rejects a Rewrite that drops a masked value (would lose data on apply)', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        echoSuggestion((s) =>
          s.replace(
            /__WN_PROTECTED_[A-Za-z0-9]+_\d+__=__WN_PROTECTED_[A-Za-z0-9]+_\d+__/,
            '',
          ),
        ),
      );
    await expect(model().rewrite(input())).rejects.toMatchObject({
      code: 'PROTECTED_CONTENT_CHANGED',
    });
  });

  it('rejects a Rewrite whose output guesses a secret value', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(echoSuggestion((s) => `${s}\npassword=Guess1234!`));
    await expect(model().rewrite(input())).rejects.toMatchObject({
      response: { code: 'OUTPUT_SECURITY_VIOLATION' },
    });
  });

  it('blocks private keys before any network call (precheck and rewrite)', async () => {
    const network = jest.spyOn(globalThis, 'fetch');
    const blocked = input({
      draft: { revision: 1, title: 'Key', body: `Key cũ:\n${FAKE.privateKey}` },
    });
    expect(thrownCode(() => model().precheck(blocked))).toBe(
      'SENSITIVE_DATA_BLOCKED',
    );
    await expect(model().rewrite(blocked)).rejects.toMatchObject({
      response: { code: 'SENSITIVE_DATA_BLOCKED' },
    });
    expect(network).not.toHaveBeenCalled();
  });

  it('monitor mode only reports; off mode is a passthrough', async () => {
    const network = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(echoSuggestion());
    const monitored = await model({
      WORKNOTE_SECURITY_GATEWAY_MODE: 'monitor',
    }).rewrite(input());
    // Monitor mode sends raw data (literal protection even splits it into fragments).
    expect(network.mock.calls[0][1]?.body as string).toContain('Pa55word99');
    expect(monitored.provenance.security?.input.decision).toBe('MONITORED');
    await model({ WORKNOTE_SECURITY_GATEWAY_MODE: 'off' }).rewrite(input());
    expect(network.mock.calls[1][1]?.body as string).toContain('Pa55word99');
  });

  it('source-level masking is HMAC-stable across calls (assessment quotes stay valid)', () => {
    const gateway = model().securityGateway();
    const first = gateway.maskTexts([
      `mk: ${FAKE.dbPassword}`,
      `mật khẩu ${FAKE.dbPassword}`,
    ]);
    const second = gateway.maskTexts([`DB_PASSWORD=${FAKE.dbPassword}`]);
    expect(first.join(' ')).not.toContain(FAKE.dbPassword);
    const placeholder = /\[\[WN_SEC:PASSWORD:[a-f0-9]+\]\]/.exec(first[0])![0];
    expect(first[1]).toContain(placeholder);
    expect(second[0]).toBe(`DB_PASSWORD=${placeholder}`);
  });
});
