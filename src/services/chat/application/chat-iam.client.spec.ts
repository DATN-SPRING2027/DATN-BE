import { ConfigService } from '@nestjs/config';
import { runWithRequestContext } from '../../../common/http/request-context';
import { ChatIamClient } from './chat-iam.client';

describe('ChatIamClient latency and request-scoped deduplication', () => {
  const actorId = '651a2b3c4d5e6f7a8b9c0d1e';
  const organizationId = '651a2b3c4d5e6f7a8b9c0d1f';
  let fetchSpy: jest.SpyInstance;
  let client: ChatIamClient;

  beforeEach(() => {
    client = new ChatIamClient({
      getOrThrow: () => 'http://127.0.0.1:3001',
    } as unknown as ConfigService);
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('deduplicates repeated getActor calls within the same HTTP request context', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: actorId,
            name: 'Mina Member',
            organizationId,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await runWithRequestContext(async () => {
      const first = await client.getActor({ authorization: 'Bearer token-a' });
      const second = await client.getActor({ authorization: 'Bearer token-a' });
      expect(first).toEqual(second);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('remembers /api/v1 prefix after /internal returns 404 on the monolith to avoid double loopback calls', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: actorId,
            name: 'Mina Member',
            organizationId,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: actorId,
            name: 'Mina Member',
            organizationId,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    await client.getActor({ authorization: 'Bearer token-1' });
    await client.getActor({ authorization: 'Bearer token-2' });

    expect(fetchSpy.mock.calls.map(([url]: [unknown]) => String(url))).toEqual([
      'http://127.0.0.1:3001/internal/auth/me',
      'http://127.0.0.1:3001/api/v1/auth/me',
      'http://127.0.0.1:3001/api/v1/auth/me',
    ]);
  });
});
