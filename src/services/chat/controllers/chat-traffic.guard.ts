import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { hasCookieName, readCookieValue } from '../../../common/http/cookies';
import { validCsrfPair } from '../../../common/security/csrf';
import { ChatIamClient } from '../application/chat-iam.client';
import { RedisService } from '../infrastructure/redis/redis.service';

function preAuthSubjectKey(request: Request): string {
  const authorization =
    typeof request.headers.authorization === 'string'
      ? request.headers.authorization.trim()
      : '';
  const accessCookie = readCookieValue(
    request.headers.cookie,
    'continuum_access',
  );
  const credentialMaterial = authorization || accessCookie;
  if (credentialMaterial) {
    const hash = createHash('sha256')
      .update(credentialMaterial)
      .digest('hex')
      .slice(0, 32);
    return `cred:${hash}`;
  }
  const ip = typeof request.ip === 'string' && request.ip ? request.ip : 'anon';
  return `ip:${ip}`;
}

@Injectable()
export class ChatTrafficGuard implements CanActivate {
  constructor(
    private readonly iam: ChatIamClient,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const safeMethod = ['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(
      request.method.toUpperCase(),
    );
    const hasSessionCookie = [
      'continuum_access',
      '__Secure-refresh',
      'continuum_refresh',
    ].some((name) => hasCookieName(request.headers.cookie, name));
    if (
      !safeMethod &&
      hasSessionCookie &&
      !validCsrfPair(
        readCookieValue(request.headers.cookie, '__Host-csrf'),
        request.get('x-csrf-token'),
      )
    )
      throw new ForbiddenException({
        code: 'AUTH_CSRF_INVALID',
        message: 'CSRF validation failed.',
      });

    // Enforce rate limits BEFORE outbound IAM calls so throttled callers cannot hammer IAM.
    const prefix = this.config.get<string>('BULLMQ_PREFIX') ?? 'continuum';
    const read = request.method.toUpperCase() === 'GET';
    const subject = preAuthSubjectKey(request);
    if (
      !(await this.redis.consumeRateLimit(
        `${prefix}:chat:http:${subject}:${read ? 'read' : 'write'}`,
        read ? 600 : 180,
        60,
      ))
    ) {
      throw new HttpException(
        {
          code: 'CHAT_RATE_LIMITED',
          message: 'Too many chat requests. Try again shortly.',
        },
        429,
      );
    }

    await this.iam.getActor({
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      organizationId: request.get('x-organization-id'),
      expectedOrganizationId: request.get('x-expected-organization-id'),
    });
    return true;
  }
}
