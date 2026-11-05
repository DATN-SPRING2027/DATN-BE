import { createCredentialRoutedFetch } from '../../../../../scripts/work-note-agent/assessment-credential-routing';

describe('Evaluation credential routing', () => {
  it('does not rotate to key3 for 503 and refuses duplicate credentials', async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(() =>
        Promise.resolve(new Response('{}', { status: 503 })),
      );
    await createCredentialRoutedFetch('one', 'two', fetcher, 'three').fetch(
      'https://api.xkiro.com/v1/chat/completions',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    fetcher.mockImplementation(() =>
      Promise.resolve(new Response('{}', { status: 429 })),
    );
    await createCredentialRoutedFetch('one', 'two', fetcher, ' two ').fetch(
      'https://api.xkiro.com/v1/chat/completions',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('stops after all three credentials return429', async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(() =>
        Promise.resolve(new Response('{}', { status: 429 })),
      );
    const routed = createCredentialRoutedFetch('one', 'two', fetcher, 'three');
    expect(
      (await routed.fetch('https://api.xkiro.com/v1/chat/completions')).status,
    ).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('uses key3 only after prior credentials return429 and then stays on key3', async () => {
    const aliases: string[] = [];
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation((_url, init) => {
        aliases.push(new Headers(init?.headers).get('Authorization')!);
        return Promise.resolve(
          new Response('{}', { status: aliases.length < 3 ? 429 : 200 }),
        );
      });
    const routed = createCredentialRoutedFetch('one', 'two', fetcher, 'three');
    await routed.fetch('https://api.xkiro.com/v1/chat/completions');
    await routed.fetch('https://api.xkiro.com/v1/chat/completions');
    expect(aliases).toEqual([
      'Bearer one',
      'Bearer two',
      'Bearer three',
      'Bearer three',
    ]);
    expect(routed.snapshot().activeAlias).toBe('tertiary');
  });
  it('normalizes credential whitespace before forwarding the secondary Authorization header', async () => {
    const seen: string[] = [];
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation((_url, init) => {
        seen.push(new Headers(init?.headers).get('Authorization')!);
        return Promise.resolve(
          new Response('{}', { status: seen.length === 1 ? 429 : 200 }),
        );
      });
    await createCredentialRoutedFetch('primary', ' secondary ', fetcher).fetch(
      'https://api.xkiro.com/v1/chat/completions',
    );
    expect(seen[1]).toBe('Bearer secondary');
  });
  const endpoint = 'https://api.xkiro.com/v1/chat/completions';
  it('counts both attempts through the supplied fetch and stays on secondary after primary 429', async () => {
    const auth: string[] = [];
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation((_url, init) => {
        auth.push(new Headers(init?.headers).get('Authorization')!);
        return Promise.resolve(
          new Response('{}', { status: auth.length === 1 ? 429 : 200 }),
        );
      });
    const routed = createCredentialRoutedFetch(
      'test-primary',
      'test-secondary',
      fetcher,
    );
    await routed.fetch(endpoint, {});
    await routed.fetch(endpoint, {});
    expect(auth).toEqual([
      'Bearer test-primary',
      'Bearer test-secondary',
      'Bearer test-secondary',
    ]);
    expect(JSON.stringify(routed.snapshot())).not.toContain('test-');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([401, 403, 500])(
    'does not rotate credentials for HTTP %s',
    async (status) => {
      const fetcher = jest
        .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockResolvedValue(new Response('{}', { status }));
      await createCredentialRoutedFetch('p', 's', fetcher).fetch(endpoint);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('stops after secondary also returns 429 and respects global scope', async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(() =>
        Promise.resolve(new Response('{}', { status: 429 })),
      );
    const routed = createCredentialRoutedFetch('p', 's', fetcher);
    expect((await routed.fetch(endpoint)).status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const global = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        new Response('{}', {
          status: 429,
          headers: { 'x-ratelimit-scope': 'global' },
        }),
      );
    await createCredentialRoutedFetch('p', 's', global).fetch(endpoint);
    expect(global).toHaveBeenCalledTimes(1);
  });
});
