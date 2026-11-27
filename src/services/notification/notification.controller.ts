import {
  Controller,
  ConflictException,
  ForbiddenException,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
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
import { NOTIFICATION_REALTIME_PUBLISHER } from './notification-realtime.bus';
import { NotificationService } from './notification.service';

interface NotificationRateLimiter {
  consumeRateLimit?: (
    key: string,
    limit: number,
    windowSeconds: number,
  ) => Promise<boolean>;
}

const SESSION_COOKIE_NAMES = [
  '__Host-session',
  'continuum_session',
  'session_token',
  '__Host-access',
  'access_token',
  '__Host-refresh',
  'refresh_token',
  '__Host-csrf',
  'continuum_csrf',
  'csrf_token',
] as const;

// SEC-BE-008: Expose only 'notifications' (service-bootstrap already prefixes 'internal'
// in standalone mode, preventing public '/api/v1/internal/notifications' exposure in monolith).
@Controller('notifications')
export class NotificationCenterController {
  constructor(
    private readonly notificationService: NotificationService,
    @Optional()
    private readonly auth?: AuthenticationApplicationService,
    @Optional()
    @Inject(NOTIFICATION_REALTIME_PUBLISHER)
    private readonly rateLimiter?: NotificationRateLimiter,
  ) {}

  @Get('health')
  getHealth(): { service: string; status: string } {
    return this.notificationService.getHealth();
  }

  private async assertRateLimit(
    userId: string,
    organizationId: string | null,
    bucket: 'read' | 'mutate',
  ): Promise<void> {
    if (typeof this.rateLimiter?.consumeRateLimit !== 'function') {
      return;
    }
    const limit = bucket === 'mutate' ? 60 : 120;
    const windowSeconds = 60;
    let allowed = true;
    try {
      allowed = await this.rateLimiter.consumeRateLimit(
        `notifications:${bucket}:${organizationId ?? 'account'}:${userId}`,
        limit,
        windowSeconds,
      );
    } catch {
      return;
    }
    if (!allowed) {
      throw new HttpException(
        {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many notification requests. Please retry later.',
          details: { bucket, retryAfterSeconds: windowSeconds },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async resolveAuthenticatedUser(
    authorization: string | undefined,
    cookie: string | undefined,
    expectedOrganizationId?: string,
  ): Promise<{ id: string; organizationId: string }> {
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
    const organizationId =
      'organizationId' in identity &&
      typeof identity.organizationId === 'string' &&
      identity.organizationId.trim().length > 0
        ? identity.organizationId.trim()
        : null;
    if (!organizationId) {
      throw new ForbiddenException({
        code: 'ORGANIZATION_CONTEXT_REQUIRED',
        message: 'An active organization context is required.',
      });
    }
    if (
      expectedOrganizationId !== undefined &&
      expectedOrganizationId.trim() !== organizationId
    ) {
      throw new ConflictException({
        code: 'ORGANIZATION_CONTEXT_MISMATCH',
        message: 'The active organization changed. Refresh and retry.',
      });
    }
    return {
      id: identity.id,
      organizationId,
    };
  }

  private assertCsrfBeforeAuth(
    authorization: string | undefined,
    cookie: string | undefined,
    csrfHeader: string | undefined,
  ): void {
    // SEC-BE-012: Enforce CSRF BEFORE auth resolution, and never allow a Bearer
    // header to skip CSRF when session/auth cookies are also sent.
    const hasBearer =
      typeof authorization === 'string' &&
      authorization.trim().toLowerCase().startsWith('bearer ');
    const hasAuthCookie = SESSION_COOKIE_NAMES.some(
      (name) => readCookie(cookie, name) !== undefined,
    );
    if (hasBearer && !hasAuthCookie) return;

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
    @Headers('x-expected-organization-id') expectedOrganizationId?: string,
  ) {
    response?.setHeader('Cache-Control', 'no-store');
    const actor = await this.resolveAuthenticatedUser(
      authorization,
      cookie,
      expectedOrganizationId,
    );
    await this.assertRateLimit(actor.id, actor.organizationId, 'read');
    const parsedLimit = limit ? Number(limit) : 20;
    const isUnreadOnly = unreadOnly === 'true' || unreadOnly === '1';
    return this.notificationService.listForUser(
      actor.id,
      {
        cursor:
          typeof cursor === 'string' && cursor.trim()
            ? cursor.trim()
            : undefined,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : 20,
        unreadOnly: isUnreadOnly,
        organizationId: actor.organizationId,
      },
      actor.organizationId,
    );
  }

  @Get('unread-count')
  async getUnreadCount(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response?: Response,
    @Headers('x-expected-organization-id') expectedOrganizationId?: string,
  ) {
    response?.setHeader('Cache-Control', 'no-store');
    const actor = await this.resolveAuthenticatedUser(
      authorization,
      cookie,
      expectedOrganizationId,
    );
    await this.assertRateLimit(actor.id, actor.organizationId, 'read');
    return this.notificationService.getUnreadCount(
      actor.id,
      actor.organizationId,
    );
  }

  @Patch('read-all')
  async markAllAsRead(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Res({ passthrough: true }) response?: Response,
    @Headers('x-expected-organization-id') expectedOrganizationId?: string,
  ) {
    response?.setHeader('Cache-Control', 'no-store');
    this.assertCsrfBeforeAuth(authorization, cookie, csrfHeader);
    const actor = await this.resolveAuthenticatedUser(
      authorization,
      cookie,
      expectedOrganizationId,
    );
    await this.assertRateLimit(actor.id, actor.organizationId, 'mutate');
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
    @Headers('x-expected-organization-id') expectedOrganizationId?: string,
  ) {
    response?.setHeader('Cache-Control', 'no-store');
    this.assertCsrfBeforeAuth(authorization, cookie, csrfHeader);
    const actor = await this.resolveAuthenticatedUser(
      authorization,
      cookie,
      expectedOrganizationId,
    );
    await this.assertRateLimit(actor.id, actor.organizationId, 'mutate');
    return this.notificationService.markAsRead(
      actor.id,
      id,
      actor.organizationId,
    );
  }

  @Get(':id/resolve')
  async resolveTarget(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('id') id: string,
    @Res({ passthrough: true }) response?: Response,
    @Headers('x-expected-organization-id') expectedOrganizationId?: string,
  ) {
    response?.setHeader('Cache-Control', 'no-store');
    const actor = await this.resolveAuthenticatedUser(
      authorization,
      cookie,
      expectedOrganizationId,
    );
    await this.assertRateLimit(actor.id, actor.organizationId, 'read');
    return this.notificationService.resolveTarget(
      actor.id,
      id,
      actor.organizationId,
    );
  }

  @Get('account-events')
  async listAccountEvents(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res({ passthrough: true }) response?: Response,
  ) {
    response?.setHeader('Cache-Control', 'no-store');
    if (!this.auth) {
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication is required.',
      });
    }
    const identity = await this.auth.getCurrentAccountEventsIdentity(
      authorization,
      cookie,
    );
    await this.assertRateLimit(identity.id, null, 'read');
    const parsedLimit = limit ? Number(limit) : 20;
    return this.notificationService.listAccountEventsForUser(identity.id, {
      cursor:
        typeof cursor === 'string' && cursor.trim() ? cursor.trim() : undefined,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 20,
    });
  }
}
