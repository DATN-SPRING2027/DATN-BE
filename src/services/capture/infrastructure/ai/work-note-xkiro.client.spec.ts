import { WorkNoteXkiroClient, XkiroError } from './work-note-xkiro.client';

const success = (overrides: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      id: 'completion-test',
      model: 'vendor/test',
      choices: [
        {
          message: {
            content: '{"ok":true}',
            reasoning_content: 'DO NOT EXPOSE',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      ...overrides,
    }),
    { status: 200 },
  );
const config = {
  apiKey: 'synthetic-test-key',
  model: 'vendor/test',
  timeoutMs: 1000,
  maxTokens: 1024,
};

describe('xKiro rewrite client (mocked network)', () => {
  it('distinguishes deadlines from other network errors without retrying an ambiguous POST', async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValue(
        new DOMException('private transport detail', 'TimeoutError'),
      );
    await expect(
      new WorkNoteXkiroClient(config, fetcher).complete(
        [{ role: 'user', content: 'synthetic' }],
        'timeout-test',
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('calls only the fixed xKiro endpoint, sends no tools, and drops reasoning', async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(success());
    const client = new WorkNoteXkiroClient(config, fetcher);
    const result = await client.complete(
      [{ role: 'system', content: 'Return JSON.' }],
      'eval-1',
    );
    expect(fetcher.mock.calls[0][0]).toBe(
      'https://api.xkiro.com/v1/chat/completions',
    );
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      model: 'vendor/test',
      stream: false,
      user: 'eval-1',
    });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('web_search');
    expect(result.content).toBe('{"ok":true}');
    expect(JSON.stringify(result)).not.toContain('DO NOT EXPOSE');
    expect(JSON.stringify(client)).not.toContain(config.apiKey);
  });

  it('retries transient errors with byte-identical bodies while independent evaluations get a different identity', async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(
        new Response('private-provider-error', { status: 503 }),
      )
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success());
    const client = new WorkNoteXkiroClient(
      { ...config, retries: 1 },
      fetcher,
      () => Promise.resolve(),
    );
    expect(
      (
        await client.complete(
          [{ role: 'user', content: 'synthetic' }],
          'eval-run-1',
        )
      ).attempts,
    ).toBe(2);
    await client.complete(
      [{ role: 'user', content: 'synthetic' }],
      'eval-run-2',
    );
    expect(fetcher.mock.calls[0][1]!.body).toBe(fetcher.mock.calls[1][1]!.body);
    expect(fetcher.mock.calls[2][1]!.body).not.toBe(
      fetcher.mock.calls[1][1]!.body,
    );
  });

  it('does not retry authentication errors or leak provider bodies and credentials', async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        new Response('synthetic-test-key private note', { status: 401 }),
      );
    const client = new WorkNoteXkiroClient(config, fetcher);
    await expect(client.complete([], 'eval-auth')).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 401,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects truncated content, tool output and malformed provider envelopes', async () => {
    for (const response of [
      success({
        choices: [{ message: { content: '{}' }, finish_reason: 'length' }],
      }),
      success({
        choices: [{ message: { tool_calls: [] }, finish_reason: 'tool_calls' }],
      }),
      new Response('not json'),
    ]) {
      const client = new WorkNoteXkiroClient(
        config,
        jest
          .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
          .mockResolvedValue(response),
      );
      await expect(client.complete([], 'eval-bad')).rejects.toBeInstanceOf(
        XkiroError,
      );
    }
  });

  it('validates model/config and gives a bounded sanitized failure for network errors', async () => {
    expect(
      () => new WorkNoteXkiroClient({ ...config, model: 'bare-model' }),
    ).toThrow();
    expect(
      () => new WorkNoteXkiroClient({ ...config, maxTokens: -1 }),
    ).toThrow();
    const client = new WorkNoteXkiroClient(
      { ...config, retries: 0 },
      jest
        .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockRejectedValue(new Error('secret-provider-detail')),
    );
    await expect(client.complete([], 'eval-network')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: 'xKiro request failed before a complete response.',
    });
  });
});
