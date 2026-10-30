import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAiEngineClient } from './http-ai-engine.client';

describe('HttpAiEngineClient', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function makeClient(overrides: Record<string, unknown> = {}) {
    const values: Record<string, unknown> = {
      SAG_API_BASE_URL: 'http://127.0.0.1:8000',
      SAG_BFF_SERVICE_TOKEN: 's'.repeat(40),
      BACKEND_TIMEOUT_MS: 5000,
      SAG_CHAT_STREAM_TIMEOUT_MS: 120000,
      ...overrides,
    };
    const config = {
      get: jest.fn((key: string) => values[key]),
      getOrThrow: jest.fn((key: string) => {
        if (values[key] === undefined) {
          throw new Error(`Missing config ${key}`);
        }
        return values[key];
      }),
    } as unknown as ConfigService;
    return new HttpAiEngineClient(config);
  }

  it('throws 503 AI_ENGINE_NOT_CONFIGURED when SAG env vars are missing', async () => {
    const client = makeClient({ SAG_API_BASE_URL: '' });
    await expect(
      client.request({
        path: '/api/v1/auth/continuum-login',
        method: 'POST',
        headers: {},
        body: {},
      }),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unlisted paths, path traversal, and cross-origin URLs', async () => {
    const client = makeClient();
    for (const badPath of [
      '/api/v1/sources',
      '/api/v1/agents/a1/threads/../secrets',
      'https://evil.example/api/v1/agents/default',
      '/admin/metrics',
    ]) {
      await expect(
        client.request({
          path: badPath,
          method: 'GET',
          headers: { Authorization: 'Bearer token' },
        }),
      ).rejects.toThrow(BadGatewayException);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('attaches X-SAG-BFF-Service-Token on continuum-login and omits it on Bearer agent calls', async () => {
    const client = makeClient();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'a.b.c' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await client.request({
      path: '/api/v1/auth/continuum-login',
      method: 'POST',
      headers: { 'X-Continuum-User-Id': '507f1f77bcf86cd799439011' },
      body: {},
    });

    const loginInit = fetchMock.mock.calls[0]?.[1];
    const loginHeaders = new Headers(loginInit?.headers);
    expect(loginHeaders.get('X-SAG-BFF-Service-Token')).toBe('s'.repeat(40));

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'agent-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await client.request({
      path: '/api/v1/agents/default',
      method: 'GET',
      headers: { Authorization: 'Bearer user.jwt.token' },
    });

    const agentInit = fetchMock.mock.calls[1]?.[1];
    const agentHeaders = new Headers(agentInit?.headers);
    expect(agentHeaders.get('Authorization')).toBe('Bearer user.jwt.token');
    expect(agentHeaders.get('X-SAG-BFF-Service-Token')).toBeNull();
  });

  it('supports PATCH and DELETE on allowlisted agent thread paths and handles 204 responses', async () => {
    const client = makeClient();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await client.request<void>({
      path: '/api/v1/agents/agent_1/threads/thread_1',
      method: 'DELETE',
      headers: { Authorization: 'Bearer user.jwt.token' },
    });

    expect(result).toEqual({ status: 204, body: undefined });
  });

  it('opens an SSE stream on allowlisted /ask path and maps upstream 4xx/5xx/timeout safely', async () => {
    const client = makeClient();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('event: message.delta\ndata: {}\n\n'),
        );
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }),
    );

    const abortController = new AbortController();
    const opened = await client.requestStream({
      path: '/api/v1/agents/agent_1/threads/thread_1/ask',
      method: 'POST',
      headers: { Authorization: 'Bearer user.jwt.token' },
      body: { query: 'Hello', web_enabled: false, knowledge_only: true },
      signal: abortController.signal,
    });

    expect(opened.status).toBe(200);
    expect(opened.stream).toBeDefined();

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'Thread not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      client.requestStream({
        path: '/api/v1/agents/agent_1/threads/missing/ask',
        method: 'POST',
        headers: { Authorization: 'Bearer user.jwt.token' },
        body: { query: 'Hello' },
      }),
    ).rejects.toThrow(HttpException);

    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';
    fetchMock.mockRejectedValueOnce(timeoutErr);
    await expect(
      client.requestStream({
        path: '/api/v1/agents/agent_1/threads/thread_1/ask',
        method: 'POST',
        headers: { Authorization: 'Bearer user.jwt.token' },
        body: { query: 'Hello' },
      }),
    ).rejects.toThrow(GatewayTimeoutException);
  });

  it('maps upstream SAG 401/403/400 errors to 502 BadGatewayException and preserves base URL path prefixes', async () => {
    const prefixedClient = makeClient({
      SAG_API_BASE_URL: 'https://gateway.internal/sag/',
    });

    for (const upstreamStatus of [400, 401, 403]) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: 'upstream failure' }), {
          status: upstreamStatus,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await expect(
        prefixedClient.request({
          path: '/api/v1/agents/default',
          method: 'GET',
          headers: { Authorization: 'Bearer token' },
        }),
      ).rejects.toThrow(BadGatewayException);
    }

    const calledUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(calledUrl.toString()).toBe(
      'https://gateway.internal/sag/api/v1/agents/default',
    );
  });

  it('allows POST /api/v1/projects/:projectId/handover/assist with X-SAG-BFF-Service-Token and rejects arbitrary POST paths (C03)', async () => {
    const client = makeClient();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ task: 'SOURCE_PROPOSAL', candidates: [] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const res = await client.request({
      path: '/api/v1/projects/751a2b3c4d5e6f7a8b9c0d20/handover/assist',
      method: 'POST',
      headers: {
        'X-Continuum-User-Id': '651a2b3c4d5e6f7a8b9c0d11',
        'X-Continuum-Organization-Id': '651a2b3c4d5e6f7a8b9c0d10',
        'X-Continuum-Tenant-Id': '651a2b3c4d5e6f7a8b9c0d10',
        'X-Continuum-Project-Id': '751a2b3c4d5e6f7a8b9c0d20',
        'X-Continuum-Security-Partition': '751a2b3c4d5e6f7a8b9c0d20',
      },
      body: { task: 'SOURCE_PROPOSAL', query: 'runbook', sources: [] },
    });

    expect(res.status).toBe(200);
    const assistInit = fetchMock.mock.calls[0]?.[1];
    const assistHeaders = new Headers(assistInit?.headers);
    expect(assistHeaders.get('X-SAG-BFF-Service-Token')).toBe('s'.repeat(40));

    await expect(
      client.request({
        path: '/api/v1/search',
        method: 'POST',
        headers: {},
        body: { query: 'forbidden connector path' },
      }),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('supports answer feedback, share, regenerate stream, and platform feedback allowlists with safe 400/409 error mapping', async () => {
    const client = makeClient();

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message_id: 'm1',
          rating: 'LIKE',
          updated_at: '2026-10-30T09:00:00Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const putFeedback = await client.request({
      path: '/api/v1/agents/agent_1/threads/thread_1/messages/m1/feedback',
      method: 'PUT',
      headers: {
        Authorization: 'Bearer user.jwt.token',
        'X-SAG-BFF-Service-Token': 'forged',
      },
      body: { rating: 'LIKE' },
    });
    expect(putFeedback.status).toBe(200);
    const feedbackHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(feedbackHeaders.get('X-SAG-BFF-Service-Token')).toBeNull();

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const deleteShare = await client.request({
      path: '/api/v1/projects/507f1f77bcf86cd799439033/shares/sh_1',
      method: 'DELETE',
      headers: { 'X-Continuum-User-Id': '507f1f77bcf86cd799439011' },
    });
    expect(deleteShare.status).toBe(204);
    const shareHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(shareHeaders.get('X-SAG-BFF-Service-Token')).toBe('s'.repeat(40));

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          totals: { likes: 2, dislikes: 1 },
          items: [],
          next_cursor: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const adminPage = await client.request({
      path: '/api/v1/platform/ai/feedback?limit=20',
      method: 'GET',
      headers: {},
    });
    expect(adminPage.status).toBe(200);
    const adminHeaders = new Headers(fetchMock.mock.calls[2]?.[1]?.headers);
    expect(adminHeaders.get('X-SAG-BFF-Service-Token')).toBe('s'.repeat(40));

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'Invalid feedback cursor' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      client.request({
        path: '/api/v1/platform/ai/feedback?cursor=bad',
        method: 'GET',
        headers: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'Generation already active' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      client.requestStream({
        path: '/api/v1/agents/agent_1/threads/thread_1/messages/m1/regenerate',
        method: 'POST',
        headers: { Authorization: 'Bearer user.jwt.token' },
        body: {},
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
