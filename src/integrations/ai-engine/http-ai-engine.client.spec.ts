import {
  BadGatewayException,
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
});
