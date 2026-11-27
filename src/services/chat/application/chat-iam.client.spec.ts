import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { runWithRequestContext } from '../../../common/http/request-context';
import { ChatIamClient } from './chat-iam.client';

describe('ChatIamClient latency, request-scoped deduplication & multi-org headers', () => {
  const actorId = '651a2b3c4d5e6f7a8b9c0d1e';
  const organizationId = '651a2b3c4d5e6f7a8b9c0d1f';
  const otherOrgId = '651a2b3c4d5e6f7a8b9c0d20';
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

  it('forwards x-organization-id and x-expected-organization-id headers and rejects mismatches (SEC-BE-005)', async () => {
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

    const actor = await client.getActor({
      authorization: 'Bearer token-org',
      organizationId,
      expectedOrganizationId: organizationId,
    });
    expect(actor.organizationId).toBe(organizationId);
    const [, sentInit] = fetchSpy.mock.calls[0] as [unknown, RequestInit];
    const sentHeaders = new Headers(sentInit.headers);
    expect(sentHeaders.get('x-organization-id')).toBe(organizationId);
    expect(sentHeaders.get('x-expected-organization-id')).toBe(organizationId);

    await expect(
      client.getActor({
        authorization: 'Bearer token-org',
        expectedOrganizationId: otherOrgId,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    await expect(
      client.getActor({
        authorization: 'Bearer token-org',
        organizationId: otherOrgId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Conflicting headers fail fast with 409 before hitting IAM
    fetchSpy.mockClear();
    await expect(
      client.getActor({
        authorization: 'Bearer token-org',
        organizationId,
        expectedOrganizationId: otherOrgId,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('includes organization headers in request-scoped memoization keys (SEC-BE-005)', async () => {
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
      await client.getActor({
        authorization: 'Bearer token-a',
        organizationId,
      });
      await expect(
        client.getActor({
          authorization: 'Bearer token-a',
          expectedOrganizationId: otherOrgId,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
