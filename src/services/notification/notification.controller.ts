import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Optional,
  Param,
  Patch,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  AuthenticationApplicationService,
  readCookie,
  validCsrfPair,
} from '../iam/application/authentication/authentication.application.service';
import { NotificationService } from './notification.service';

@Controller(['notifications', 'internal/notifications'])
export class NotificationCenterController {
  constructor(
    private readonly notificationService: NotificationService,
    @Optional()
    private readonly auth?: AuthenticationApplicationService,
  ) {}

  @Get('health')
  getHealth(): { service: string; status: string } {
    return this.notificationService.getHealth();
  }

  private async resolveAuthenticatedUser(
    authorization: string | undefined,
    cookie: string | undefined,
  ): Promise<{ id: string; organizationId: string | null }> {
    if (!this.auth) {
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication is required.',
      });
    }
    const identity = await this.auth.getCurrentSessionIdentity(
      authorization,
      cookie,
    );
    return {
      id: identity.id,
      organizationId:
        'organizationId' in identity ? identity.organizationId : null,
    };
  }

  private assertCsrfIfCookieAuthenticated(
    authorization: string | undefined,
    cookie: string | undefined,
    csrfHeader: string | undefined,
  ): void {
    const hasBearer =
      typeof authorization === 'string' &&
      authorization.trim().toLowerCase().startsWith('bearer ');
    if (hasBearer) return;

    const cookieToken =
      readCookie(cookie, '__Host-csrf') ??
      readCookie(cookie, 'continuum_csrf') ??
      readCookie(cookie, 'csrf_token');
    const trimmedHeader =
      typeof csrfHeader === 'string' ? csrfHeader.trim() : '';
    if (!validCsrfPair(cookieToken, trimmedHeader)) {
      throw new ForbiddenException({
        code: 'AUTH_CSRF_INVALID',
        message: 'Missing or invalid CSRF token.',
      });
    }
  }

  @Get()
  async listNotifications(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('unreadOnly') unreadOnly: string | undefined,
    @Res({ passthrough: true }) response?: Response,
  ) {
    response?.setHeader('Cache-Control', 'no-store');
    const actor = await this.resolveAuthenticatedUser(authorization, cookie);
    const parsedLimit = limit ? Number(limit) : 20;
    const isUnreadOnly = unreadOnly === 'true' || unreadOnly === '1';
    return this.notificationService.listForUser(actor.id, {
      cursor:
        typeof cursor === 'string' && cursor.trim() ? cursor.trim() : undefined,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 20,
      unreadOnly: isUnreadOnly,
    });
  }

  @Get('unread-count')
  async getUnreadCount(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response?: Response,
  ) {
    response?.setHeader('Cache-Control', 'no-store');
    const actor = await this.resolveAuthenticatedUser(authorization, cookie);
    return this.notificationService.getUnreadCount(actor.id);
  }

  @Patch('read-all')
  async markAllAsRead(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Res({ passthrough: true }) response?: Response,
  ) {
    response?.setHeader('Cache-Control', 'no-store');
    const actor = await this.resolveAuthenticatedUser(authorization, cookie);
    this.assertCsrfIfCookieAuthenticated(authorization, cookie, csrfHeader);
    return this.notificationService.markAllAsRead(
      actor.id,
      actor.organizationId,
    );
  }

  @Patch(':id/read')
  async markAsRead(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Param('id') id: string,
    @Res({ passthrough: true }) response?: Response,
  ) {
    response?.setHeader('Cache-Control', 'no-store');
    const actor = await this.resolveAuthenticatedUser(authorization, cookie);
    this.assertCsrfIfCookieAuthenticated(authorization, cookie, csrfHeader);
    return this.notificationService.markAsRead(actor.id, id);
  }

  @Get(':id/resolve')
  async resolveTarget(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('id') id: string,
    @Res({ passthrough: true }) response?: Response,
  ) {
    response?.setHeader('Cache-Control', 'no-store');
    const actor = await this.resolveAuthenticatedUser(authorization, cookie);
    return this.notificationService.resolveTarget(actor.id, id);
  }
}
