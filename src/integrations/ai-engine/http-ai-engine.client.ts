import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AiEngineClient,
  AiEngineHttpMethod,
  AiEngineRequest,
  AiEngineResponse,
  AiEngineStreamRequest,
  AiEngineStreamResponse,
} from './ai-engine.port';

const AGENT_ID_SEGMENT = '[A-Za-z0-9_-]{1,64}';
const THREAD_ID_SEGMENT = '[A-Za-z0-9_-]{1,64}';

const AGENT_THREADS_COLLECTION_PATTERN = new RegExp(
  `^/api/v1/agents/${AGENT_ID_SEGMENT}/threads$`,
);
const AGENT_THREAD_ITEM_PATTERN = new RegExp(
  `^/api/v1/agents/${AGENT_ID_SEGMENT}/threads/${THREAD_ID_SEGMENT}$`,
);
const AGENT_THREAD_MESSAGES_PATTERN = new RegExp(
  `^/api/v1/agents/${AGENT_ID_SEGMENT}/threads/${THREAD_ID_SEGMENT}/messages$`,
);
const AGENT_THREAD_ASK_PATTERN = new RegExp(
  `^/api/v1/agents/${AGENT_ID_SEGMENT}/threads/${THREAD_ID_SEGMENT}/ask$`,
);

function hasRawTraversal(rawPath: string): boolean {
  const pathPart = rawPath.split('?')[0] ?? '';
  return (
    !rawPath.startsWith('/') ||
    rawPath.startsWith('//') ||
    pathPart.split('/').some((seg) => seg === '.' || seg === '..') ||
    /%2e/i.test(pathPart) ||
    /%2f/i.test(pathPart) ||
    /\\/.test(pathPart)
  );
}

function isAllowedJsonRoute(
  method: AiEngineHttpMethod,
  pathname: string,
): boolean {
  if (method === 'POST' && pathname === '/api/v1/auth/continuum-login') {
    return true;
  }
  if (method === 'GET' && pathname.startsWith('/api/v1/projects/')) {
    return true;
  }
  if (method === 'GET' && pathname === '/api/v1/agents/default') {
    return true;
  }
  if (
    (method === 'GET' || method === 'POST') &&
    AGENT_THREADS_COLLECTION_PATTERN.test(pathname)
  ) {
    return true;
  }
  if (
    (method === 'PATCH' || method === 'DELETE') &&
    AGENT_THREAD_ITEM_PATTERN.test(pathname)
  ) {
    return true;
  }
  if (method === 'GET' && AGENT_THREAD_MESSAGES_PATTERN.test(pathname)) {
    return true;
  }
  return false;
}

function requiresBffServiceToken(pathname: string): boolean {
  return (
    pathname === '/api/v1/auth/continuum-login' ||
    pathname.startsWith('/api/v1/projects/')
  );
}

@Injectable()
export class HttpAiEngineClient implements AiEngineClient {
  constructor(private readonly config: ConfigService) {}

  private resolveTarget(rawPath: string): {
    target: URL;
    serviceToken: string;
  } {
    const baseUrl = this.config.get<string>('SAG_API_BASE_URL')?.trim();
    const serviceToken = this.config.get<string>('SAG_BFF_SERVICE_TOKEN');
    if (!baseUrl || !serviceToken) {
      throw new ServiceUnavailableException({
        code: 'AI_ENGINE_NOT_CONFIGURED',
        message: 'AI Engine is not configured.',
      });
    }

    if (hasRawTraversal(rawPath)) {
      throw new BadGatewayException('AI Engine path is not allowed.');
    }

    const base = new URL(baseUrl);
    const target = new URL(rawPath, `${base.origin}/`);
    if (target.origin !== base.origin) {
      throw new BadGatewayException('AI Engine path is not allowed.');
    }
    return { target, serviceToken };
  }

  async request<TResponse>(
    request: AiEngineRequest,
  ): Promise<AiEngineResponse<TResponse>> {
    const { target, serviceToken } = this.resolveTarget(request.path);
    if (!isAllowedJsonRoute(request.method, target.pathname)) {
      throw new BadGatewayException('AI Engine path is not allowed.');
    }

    const headers = new Headers(request.headers);
    if (requiresBffServiceToken(target.pathname)) {
      headers.set('X-SAG-BFF-Service-Token', serviceToken);
    } else {
      headers.delete('X-SAG-BFF-Service-Token');
    }
    headers.set('Accept', 'application/json');
    if (request.body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }

    let response: Response;
    try {
      response = await fetch(target, {
        method: request.method,
        headers,
        ...(request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
        cache: 'no-store',
        signal: AbortSignal.timeout(
          this.config.getOrThrow<number>('BACKEND_TIMEOUT_MS'),
        ),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new GatewayTimeoutException({
          code: 'AI_ENGINE_TIMEOUT',
          message: 'AI Engine request timed out.',
        });
      }
      throw new ServiceUnavailableException({
        code: 'AI_ENGINE_UNAVAILABLE',
        message: 'AI Engine is unavailable.',
      });
    }

    if (response.status === 204) {
      return { status: 204, body: undefined as TResponse };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new BadGatewayException('AI Engine returned an invalid response.');
    }
    if (!response.ok) {
      this.throwSafeHttpError(response.status);
    }
    return { status: response.status, body: body as TResponse };
  }

  async requestStream(
    request: AiEngineStreamRequest,
  ): Promise<AiEngineStreamResponse> {
    const { target } = this.resolveTarget(request.path);
    if (
      request.method !== 'POST' ||
      !AGENT_THREAD_ASK_PATTERN.test(target.pathname)
    ) {
      throw new BadGatewayException('AI Engine stream path is not allowed.');
    }

    const headers = new Headers(request.headers);
    headers.delete('X-SAG-BFF-Service-Token');
    headers.set('Accept', 'text/event-stream');
    if (request.body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }

    const streamTimeoutMs =
      this.config.get<number>('SAG_CHAT_STREAM_TIMEOUT_MS') ?? 120000;
    const timeoutSignal = AbortSignal.timeout(streamTimeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(target, {
        method: request.method,
        headers,
        ...(request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
        cache: 'no-store',
        signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new GatewayTimeoutException({
          code: 'AI_ENGINE_TIMEOUT',
          message: 'AI Engine stream timed out.',
        });
      }
      throw new ServiceUnavailableException({
        code: 'AI_ENGINE_UNAVAILABLE',
        message: 'AI Engine is unavailable.',
      });
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      this.throwSafeHttpError(response.status);
    }

    if (!response.body) {
      throw new BadGatewayException(
        'AI Engine returned an empty event stream.',
      );
    }

    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      stream: response.body,
    };
  }

  private throwSafeHttpError(status: number): never {
    if (status === 404) {
      throw new HttpException(
        {
          code: 'AI_CHAT_RESOURCE_NOT_FOUND',
          message: 'Requested AI chat resource was not found.',
        },
        404,
      );
    }
    if (status === 429) {
      throw new HttpException(
        {
          code: 'AI_ENGINE_RATE_LIMITED',
          message: 'AI Engine rate limit exceeded. Please retry shortly.',
        },
        429,
      );
    }
    if (status < 500) {
      throw new HttpException(
        {
          code: 'AI_ENGINE_REQUEST_FAILED',
          message: 'AI Engine request failed.',
        },
        status,
      );
    }
    throw new BadGatewayException('AI Engine request failed.');
  }
}
