import {
  BadGatewayException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AiEngineClient,
  AiEngineRequest,
  AiEngineResponse,
} from './ai-engine.port';

@Injectable()
export class HttpAiEngineClient implements AiEngineClient {
  constructor(private readonly config: ConfigService) {}

  async request<TResponse>(
    request: AiEngineRequest,
  ): Promise<AiEngineResponse<TResponse>> {
    const baseUrl = this.config.get<string>('SAG_API_BASE_URL')?.trim();
    const serviceToken = this.config.get<string>('SAG_BFF_SERVICE_TOKEN');
    if (!baseUrl || !serviceToken) {
      throw new ServiceUnavailableException({
        code: 'AI_ENGINE_NOT_CONFIGURED',
        message: 'AI Engine is not configured.',
      });
    }

    const base = new URL(baseUrl);
    const target = new URL(request.path, `${base.origin}/`);
    const allowedPath =
      (request.method === 'GET' &&
        target.pathname.startsWith('/api/v1/projects/')) ||
      (request.method === 'POST' &&
        target.pathname === '/api/v1/auth/continuum-login');
    if (target.origin !== base.origin || !allowedPath) {
      throw new BadGatewayException('AI Engine path is not allowed.');
    }

    const headers = new Headers(request.headers);
    headers.set('X-SAG-BFF-Service-Token', serviceToken);
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
    } catch {
      throw new ServiceUnavailableException({
        code: 'AI_ENGINE_UNAVAILABLE',
        message: 'AI Engine is unavailable.',
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new BadGatewayException('AI Engine returned an invalid response.');
    }
    if (!response.ok) {
      if (response.status < 500) {
        throw new HttpException(
          {
            code: 'AI_ENGINE_REQUEST_FAILED',
            message: 'AI Engine request failed.',
          },
          response.status,
        );
      }
      throw new BadGatewayException('AI Engine request failed.');
    }
    return { status: response.status, body: body as TResponse };
  }
}
