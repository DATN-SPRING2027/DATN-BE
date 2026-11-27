import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  AuthenticationApplicationService,
  readCookie,
  validCsrfPair,
} from '../services/iam/application/authentication/authentication.application.service';
import { MCP_ENDPOINT_PATH } from '../services/iam/application/mcp-api-keys/mcp-api-key.types';
import { McpService } from './mcp.service';
import {
  JSON_RPC_ERROR_CODES,
  MCP_CANONICAL_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from './mcp.types';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnsupportedProtocolHeader(header: string | undefined): boolean {
  if (header === undefined) return false;
  const trimmed = header.trim();
  if (trimmed.length === 0) return false;
  return !(MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(
    trimmed,
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function assertCsrfIfCookieAuthenticated(
  authorization: string | undefined,
  cookie: string | undefined,
  csrfToken: string | undefined,
): void {
  const hasBearer =
    typeof authorization === 'string' &&
    /^bearer\s+\S+/i.test(authorization.trim());
  if (!hasBearer && typeof cookie === 'string' && cookie.trim().length > 0) {
    const cookieToken =
      readCookie(cookie, '__Host-csrf') ??
      readCookie(cookie, 'continuum_csrf') ??
      readCookie(cookie, 'csrf_token');
    const csrfHeader = typeof csrfToken === 'string' ? csrfToken.trim() : '';
    if (!validCsrfPair(cookieToken, csrfHeader)) {
      throw new ForbiddenException({
        code: 'CSRF_INVALID',
        message: 'CSRF token is missing or invalid.',
      });
    }
  }
}

@Controller(['mcp', 'internal/mcp'])
export class McpController {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly mcpService: McpService,
  ) {}

  @Get()
  async discover(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const authorization = headerValue(request.headers.authorization);
    const cookie = headerValue(request.headers.cookie);
    await this.auth.getCurrentIdentity(authorization, cookie);

    const protocolHeader = headerValue(request.headers['mcp-protocol-version']);
    if (isUnsupportedProtocolHeader(protocolHeader)) {
      response.status(HttpStatus.BAD_REQUEST).json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          message: 'Unsupported MCP-Protocol-Version header.',
        },
      });
      return;
    }

    const accept = (headerValue(request.headers.accept) ?? '').toLowerCase();
    if (accept.includes('text/event-stream')) {
      response.setHeader('Allow', 'POST, DELETE, OPTIONS');
      response.status(HttpStatus.METHOD_NOT_ALLOWED).json({
        code: 'MCP_SSE_STREAM_UNSUPPORTED',
        message:
          'Stateless Streamable HTTP endpoint does not open standalone GET SSE streams; send JSON-RPC messages via POST /api/v1/mcp.',
      });
      return;
    }

    response.setHeader('MCP-Protocol-Version', MCP_CANONICAL_PROTOCOL_VERSION);
    response.status(HttpStatus.OK).json({
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      protocolVersion: MCP_CANONICAL_PROTOCOL_VERSION,
      endpoint: MCP_ENDPOINT_PATH,
      status: 'ok',
    });
  }

  @Post()
  async handlePost(
    @Req() request: Request,
    @Body() body: unknown,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const authorization = headerValue(request.headers.authorization);
    const cookie = headerValue(request.headers.cookie);
    const csrfToken = headerValue(request.headers['x-csrf-token']);

    assertCsrfIfCookieAuthenticated(authorization, cookie, csrfToken);
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);

    const protocolHeader = headerValue(request.headers['mcp-protocol-version']);
    if (isUnsupportedProtocolHeader(protocolHeader)) {
      response.status(HttpStatus.BAD_REQUEST).json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          message: 'Unsupported MCP-Protocol-Version header.',
        },
      });
      return;
    }

    if (!isPlainRecord(body) && !Array.isArray(body)) {
      response.status(HttpStatus.BAD_REQUEST).json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          message: 'Invalid Request.',
        },
      });
      return;
    }

    const requestId = headerValue(request.headers['x-request-id']);

    const outcome = await this.mcpService.handlePayload(
      {
        actor,
        authorizationHeader: authorization,
        cookieHeader: cookie,
        requestId,
      },
      body,
      protocolHeader?.trim(),
    );

    if (outcome.kind === 'accepted') {
      response.status(HttpStatus.ACCEPTED).send();
      return;
    }

    response.setHeader('MCP-Protocol-Version', outcome.protocolVersion);
    response.status(HttpStatus.OK).json(outcome.body);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async terminateSession(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const authorization = headerValue(request.headers.authorization);
    const cookie = headerValue(request.headers.cookie);
    const csrfToken = headerValue(request.headers['x-csrf-token']);

    assertCsrfIfCookieAuthenticated(authorization, cookie, csrfToken);
    await this.auth.getCurrentIdentity(authorization, cookie);
  }
}
