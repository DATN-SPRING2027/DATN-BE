import type { Response } from 'express';
import { enforcePlatformRateLimit } from './platform-request-rate-limit';

const actor = '651a2b3c4d5e6f7a8b9c0d21';

describe('Platform request budgets', () => {
  const store = {
    consumeRateLimit: jest
      .fn<Promise<boolean>, [string, number, number]>()
      .mockResolvedValue(true),
  };
  const setHeader = jest.fn();
  const response = { setHeader } as unknown as Response;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-26T00:00:15Z'));
    store.consumeRateLimit.mockReset().mockResolvedValue(true);
    setHeader.mockClear();
  });
  afterEach(() => jest.useRealTimers());

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'uses the shared read budget for %s',
    async (method) => {
      await enforcePlatformRateLimit(store, actor, method, response);
      const [key, limit, ttl] = store.consumeRateLimit.mock.calls[0];
      expect(key).toMatch(/^platform:read:[a-f\d]{64}:\d+$/);
      expect(key).not.toContain(actor);
      expect(limit).toBe(120);
      expect(ttl).toBe(60);
    },
  );
  it.each(['POST', 'PATCH', 'DELETE', 'PUT'])(
    'shares the stricter write budget for %s',
    async (method) => {
      await enforcePlatformRateLimit(store, actor, method, response);
      expect(store.consumeRateLimit.mock.calls[0]).toEqual([
        expect.stringMatching(/^platform:write:/),
        20,
        60,
      ]);
    },
  );
  it('isolates actors, normalizes actor ID case, and renews at the UTC minute boundary', async () => {
    await enforcePlatformRateLimit(store, actor, 'GET', response);
    await enforcePlatformRateLimit(store, actor.toUpperCase(), 'GET', response);
    await enforcePlatformRateLimit(
      store,
      '651a2b3c4d5e6f7a8b9c0d22',
      'GET',
      response,
    );
    jest.setSystemTime(new Date('2026-10-26T00:01:00Z'));
    await enforcePlatformRateLimit(store, actor, 'GET', response);
    const keys = store.consumeRateLimit.mock.calls.map((call) => call[0]);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
  });
  it('returns 429 and an accurate retry boundary without inventing remaining counts', async () => {
    store.consumeRateLimit.mockResolvedValue(false);
    await expect(
      enforcePlatformRateLimit(store, actor, 'POST', response),
    ).rejects.toMatchObject({
      status: 429,
      response: { code: 'TOO_MANY_REQUESTS' },
    });
    expect(setHeader.mock.calls).toEqual([
      ['X-RateLimit-Limit', 20],
      ['X-RateLimit-Reset', Date.parse('2026-10-26T00:01:00Z') / 1000],
      ['Retry-After', 45],
    ]);
  });
  it('fails closed on a Redis outage without exposing dependency details', async () => {
    store.consumeRateLimit.mockRejectedValue(new Error('redis://private-host'));
    await expect(
      enforcePlatformRateLimit(store, actor, 'POST', response),
    ).rejects.toMatchObject({
      status: 503,
      response: { code: 'PLATFORM_RATE_LIMIT_UNAVAILABLE' },
    });
  });
});
