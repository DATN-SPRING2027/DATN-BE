import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  AuthenticationApplicationService,
  readCookie,
  validCsrfPair,
  type AuthenticatedIdentity,
} from '../application/authentication/authentication.application.service';
import { McpApiKeysService } from '../application/mcp-api-keys/mcp-api-keys.service';
import type {
  CreateMcpApiKeyResponse,
  ListMcpApiKeysResponse,
  RevokeMcpApiKeyResponse,
} from '../application/mcp-api-keys/mcp-api-key.types';

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

@Controller('iam/mcp-api-keys')
export class McpApiKeysController {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly mcpApiKeys: McpApiKeysService,
  ) {}

  private async requireInteractiveOrganizationSession(
    authorization: string | undefined,
    cookie: string | undefined,
  ): Promise<AuthenticatedIdentity> {
    const identity = await this.auth.getCurrentSessionIdentity(
      authorization,
      cookie,
    );
    if (!('organizationId' in identity)) {
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_FAILED',
        message: 'An active organization session is required.',
      });
    }
    return identity;
  }

  @Get()
  async listKeys(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ListMcpApiKeysResponse> {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.requireInteractiveOrganizationSession(
      authorization,
      cookie,
    );
    return this.mcpApiKeys.list(actor);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createKey(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfToken: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreateMcpApiKeyResponse> {
    response.setHeader('Cache-Control', 'no-store');
    assertCsrfIfCookieAuthenticated(authorization, cookie, csrfToken);
    const actor = await this.requireInteractiveOrganizationSession(
      authorization,
      cookie,
    );
    return this.mcpApiKeys.create(actor, body);
  }

  @Delete(':keyId')
  @HttpCode(HttpStatus.OK)
  async revokeKey(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfToken: string | undefined,
    @Param('keyId') keyId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RevokeMcpApiKeyResponse> {
    response.setHeader('Cache-Control', 'no-store');
    assertCsrfIfCookieAuthenticated(authorization, cookie, csrfToken);
    const actor = await this.requireInteractiveOrganizationSession(
      authorization,
      cookie,
    );
    return this.mcpApiKeys.revoke(actor, keyId);
  }
}
