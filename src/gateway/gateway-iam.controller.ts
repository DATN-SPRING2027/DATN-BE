import {
  Controller,
  Get,
  GatewayTimeoutException,
  Patch,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

const forwardedRequestHeaders = [
  'accept',
  'authorization',
  'content-type',
  'cookie',
  'x-organization-id',
  'x-request-id',
] as const;
const forwardedResponseHeaders = [
  'cache-control',
  'content-type',
  'location',
  'retry-after',
  'www-authenticate',
] as const;

@Controller()
export class GatewayIamController {
  constructor(private readonly config: ConfigService) {}

  @Post('auth/login')
  login(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.forward(request, response);
  }

  @Get('auth/me')
  me(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.forward(request, response);
  }

  @Post('auth/logout')
  logout(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/users')
  listUsers(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/users/:userId')
  getUser(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.forward(request, response);
  }

  @Patch('iam/users/:userId')
  updateUser(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  private async forward(request: Request, response: Response): Promise<void> {
    const baseUrl = this.config.getOrThrow<string>('IAM_SERVICE_URL');
    const path = request.originalUrl.replace(/^\/api\/v1\//, '/internal/');
    const url = new URL(path, baseUrl).toString();
    const headers: Record<string, string> = {};
    for (const name of forwardedRequestHeaders) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(url, {
        method: request.method,
        headers,
        ...(request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(
          this.config.getOrThrow<number>('BACKEND_TIMEOUT_MS'),
        ),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new GatewayTimeoutException('IAM service timed out');
      }
      throw new ServiceUnavailableException('IAM service unavailable');
    }

    for (const name of forwardedResponseHeaders) {
      const value = upstream.headers.get(name);
      if (value) response.setHeader(name, value);
    }
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length > 0) response.setHeader('set-cookie', cookies);

    response
      .status(upstream.status)
      .send(Buffer.from(await upstream.arrayBuffer()));
  }
}
