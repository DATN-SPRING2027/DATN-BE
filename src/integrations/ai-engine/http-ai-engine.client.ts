import {
  BadGatewayException,
  BadRequestException,
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
const MESSAGE_ID_SEGMENT = '[A-Za-z0-9_-]{1,64}';
const PROJECT_ID_SEGMENT = '[A-Za-z0-9_-]{1,64}';
const SHARE_ID_SEGMENT = '[A-Za-z0-9_-]{1,64}';

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
const AGENT_MESSAGE_FEEDBACK_PATTERN = new RegExp(
  `^/api/v1/agents/${AGENT_ID_SEGMENT}/threads/${THREAD_ID_SEGMENT}/messages/${MESSAGE_ID_SEGMENT}/feedback$`,
);
const AGENT_MESSAGE_SHARES_PATTERN = new RegExp(
  `^/api/v1/agents/${AGENT_ID_SEGMENT}/threads/${THREAD_ID_SEGMENT}/messages/${MESSAGE_ID_SEGMENT}/shares$`,
);
const AGENT_MESSAGE_REGENERATE_PATTERN = new RegExp(
  `^/api/v1/agents/${AGENT_ID_SEGMENT}/threads/${THREAD_ID_SEGMENT}/messages/${MESSAGE_ID_SEGMENT}/regenerate$`,
);
const PROJECT_SHARE_ITEM_PATTERN = new RegExp(
  `^/api/v1/projects/${PROJECT_ID_SEGMENT}/shares/${SHARE_ID_SEGMENT}$`,
);
const PLATFORM_AI_FEEDBACK_PATH = '/api/v1/platform/ai/feedback';

function isAnswerActionClientValidatedRoute(pathname: string): boolean {
  return (
    AGENT_MESSAGE_FEEDBACK_PATTERN.test(pathname) ||
    AGENT_MESSAGE_SHARES_PATTERN.test(pathname) ||
    AGENT_MESSAGE_REGENERATE_PATTERN.test(pathname) ||
    PROJECT_SHARE_ITEM_PATTERN.test(pathname) ||
    pathname === PLATFORM_AI_FEEDBACK_PATH
  );
}

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
  if (
    method === 'POST' &&
    /^\/api\/v1\/projects\/[^/]+\/handover\/assist$/.test(pathname)
  ) {
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
  if (
    (method === 'GET' || method === 'PUT' || method === 'DELETE') &&
    AGENT_MESSAGE_FEEDBACK_PATTERN.test(pathname)
  ) {
    return true;
  }
  if (method === 'POST' && AGENT_MESSAGE_SHARES_PATTERN.test(pathname)) {
    return true;
  }
  if (method === 'DELETE' && PROJECT_SHARE_ITEM_PATTERN.test(pathname)) {
    return true;
  }
  if (method === 'GET' && pathname === PLATFORM_AI_FEEDBACK_PATH) {
    return true;
  }
  return false;
}

function requiresBffServiceToken(
  pathname: string,
  method: AiEngineHttpMethod,
): boolean {
  return (
    pathname === '/api/v1/auth/continuum-login' ||
    pathname.startsWith('/api/v1/projects/') ||
    pathname === PLATFORM_AI_FEEDBACK_PATH ||
    ((method === 'PUT' || method === 'DELETE') &&
      AGENT_MESSAGE_FEEDBACK_PATTERN.test(pathname)) ||
    (method === 'POST' &&
      (AGENT_MESSAGE_SHARES_PATTERN.test(pathname) ||
        AGENT_MESSAGE_REGENERATE_PATTERN.test(pathname)))
  );
}

@Injectable()
export class HttpAiEngineClient implements AiEngineClient {
  constructor(private readonly config: ConfigService) {}

  private resolveTarget(rawPath: string): {
    target: URL;
    routePathname: string;
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
    if (base.username || base.password || base.search || base.hash) {
      throw new BadGatewayException('AI Engine base URL is invalid.');
    }
    const basePrefix = base.pathname.replace(/\/+$/, '');
    const routeProbe = new URL(rawPath, 'http://sag.internal');
    const routePathname = routeProbe.pathname;
    const target = new URL(
      `${basePrefix}${routePathname}${routeProbe.search}`,
      `${base.origin}/`,
    );
    if (target.origin !== base.origin) {
      throw new BadGatewayException('AI Engine path is not allowed.');
    }
    return { target, routePathname, serviceToken };
  }

  async request<TResponse>(
    request: AiEngineRequest,
  ): Promise<AiEngineResponse<TResponse>> {
    const { target, routePathname, serviceToken } = this.resolveTarget(
      request.path,
    );
    if (!isAllowedJsonRoute(request.method, routePathname)) {
      throw new BadGatewayException('AI Engine path is not allowed.');
    }

    const headers = new Headers(request.headers);
    if (requiresBffServiceToken(routePathname, request.method)) {
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
      this.throwSafeHttpError(response.status, routePathname);
    }
    return { status: response.status, body: body as TResponse };
  }

  async requestStream(
    request: AiEngineStreamRequest,
  ): Promise<AiEngineStreamResponse> {
    const { target, routePathname, serviceToken } = this.resolveTarget(
      request.path,
    );
    if (
      request.method !== 'POST' ||
      (!AGENT_THREAD_ASK_PATTERN.test(routePathname) &&
        !AGENT_MESSAGE_REGENERATE_PATTERN.test(routePathname))
    ) {
      throw new BadGatewayException('AI Engine stream path is not allowed.');
    }

    const headers = new Headers(request.headers);
    if (requiresBffServiceToken(routePathname, request.method)) {
      headers.set('X-SAG-BFF-Service-Token', serviceToken);
    } else {
      headers.delete('X-SAG-BFF-Service-Token');
    }
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
      if (request.signal?.aborted) {
        throw error instanceof Error
          ? error
          : new Error('AI Engine stream aborted by caller.');
      }
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
      this.throwSafeHttpError(response.status, routePathname);
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

  private throwSafeHttpError(status: number, routePathname: string): never {
    if (status === 404) {
      throw new HttpException(
        {
          code: 'AI_CHAT_RESOURCE_NOT_FOUND',
          message: 'Requested AI chat resource was not found.',
        },
        404,
      );
    }
    if (status === 409) {
      throw new HttpException(
        {
          code: 'AI_CHAT_CONFLICT',
          message:
            'Another AI generation is already active in this conversation.',
        },
        409,
      );
    }
    if (status === 400 && isAnswerActionClientValidatedRoute(routePathname)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Request could not be processed for the target AI answer.',
      });
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
    if (status === 401 || status === 403) {
      throw new BadGatewayException({
        code: 'AI_ENGINE_AUTH_FAILED',
        message: 'AI Engine authentication failed.',
      });
    }
    if (status < 500) {
      throw new BadGatewayException({
        code: 'AI_ENGINE_REQUEST_FAILED',
        message: 'AI Engine rejected the upstream request.',
      });
    }
    throw new BadGatewayException({
      code: 'AI_ENGINE_UPSTREAM_ERROR',
      message: 'AI Engine request failed.',
    });
  }
}
