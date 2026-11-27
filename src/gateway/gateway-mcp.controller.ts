import {
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

const requestHeaders = [
  'accept',
  'authorization',
  'content-type',
  'cookie',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'x-csrf-token',
  'x-organization-id',
  'x-request-id',
] as const;

const responseHeaders = [
  'allow',
  'cache-control',
  'content-type',
  'mcp-protocol-version',
  'mcp-session-id',
  'www-authenticate',
  'x-request-id',
] as const;

@Controller('mcp')
export class GatewayMcpController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  discover(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.forward(request, response);
  }

  @Post()
  handleRpc(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.forward(request, response);
  }

  @Delete()
  terminateSession(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  private async forward(request: Request, response: Response): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    const path = request.originalUrl.replace(
      /^\/api\/v1\/mcp(?=[/?]|$)/,
      '/internal/mcp',
    );
    const configuredMcpUrl = this.config.get<string>('MCP_SERVICE_URL')?.trim();
    const baseUrl =
      configuredMcpUrl && configuredMcpUrl.length > 0
        ? configuredMcpUrl
        : this.config.get<string>('IAM_SERVICE_URL')?.trim();
    if (!baseUrl) {
      throw new ServiceUnavailableException('MCP service unavailable');
    }
    const timeoutMs =
      this.config.get<number>('SAG_CHAT_STREAM_TIMEOUT_MS') ?? 120_000;
    const headers: Record<string, string> = {};
    for (const name of requestHeaders) {
      const value = request.headers[name];
      if (typeof value === 'string') {
        headers[name] = value;
      }
    }

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(new URL(path, baseUrl), {
        method: request.method,
        headers,
        ...(request.method === 'GET' ||
        request.method === 'DELETE' ||
        request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new GatewayTimeoutException('MCP service timed out');
      }
      throw new ServiceUnavailableException('MCP service unavailable');
    }

    for (const name of responseHeaders) {
      const value = upstream.headers.get(name);
      if (value) {
        response.setHeader(name, value);
      }
    }
    response
      .status(upstream.status)
      .send(Buffer.from(await upstream.arrayBuffer()));
  }
}
