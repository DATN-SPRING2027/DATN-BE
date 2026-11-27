import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { readCookieValue } from '../http/cookies';

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function validCsrfPair(
  cookieValue: string | undefined,
  headerValue: string | undefined,
): boolean {
  if (
    !cookieValue ||
    !headerValue ||
    cookieValue.length > 4096 ||
    headerValue.length > 4096
  )
    return false;
  const cookieBytes = Buffer.from(cookieValue);
  const headerBytes = Buffer.from(headerValue);
  return (
    cookieBytes.length === headerBytes.length &&
    timingSafeEqual(cookieBytes, headerBytes)
  );
}

export function isBearerAuthorizationHeader(
  authorization: string | undefined,
): boolean {
  return (
    typeof authorization === 'string' &&
    /^bearer\s+\S+/i.test(authorization.trim())
  );
}

/**
 * Extracts the double-submit CSRF cookie token.
 * In production, ONLY `__Host-csrf` is trusted (prevents subdomain cookie-tossing,
 * SEC-BE-014). In local development/test HTTP environments, legacy names are
 * accepted as fallback.
 */
export function extractCsrfCookie(
  cookieHeader: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string | undefined {
  const hostCsrf = readCookieValue(cookieHeader, '__Host-csrf');
  if (hostCsrf !== undefined || nodeEnv === 'production') {
    return hostCsrf;
  }
  return (
    readCookieValue(cookieHeader, 'continuum_csrf') ??
    readCookieValue(cookieHeader, 'csrf_token')
  );
}

/**
 * Enforces CSRF protection for cookie-authenticated mutations.
 * Pure Bearer-token requests (with no session cookie fallback) bypass CSRF.
 * Cookie-authenticated requests MUST ALWAYS supply a valid CSRF cookie/header
 * pair — omitting both cookie and header is NEVER allowed to bypass CSRF
 * (SEC-AUTH-005, SEC-BE-001).
 */
export function assertCookieAuthCsrf(
  authorization: string | undefined,
  cookieHeader: string | undefined,
  csrfHeader: string | undefined,
  errorCode = 'CSRF_TOKEN_INVALID',
): void {
  if (isBearerAuthorizationHeader(authorization)) {
    return;
  }
  if (!cookieHeader || cookieHeader.trim().length === 0) {
    // No Bearer header and no Cookie header -> unauthenticated request; let
    // the authentication layer return 401 rather than 403.
    return;
  }
  const cookieToken = extractCsrfCookie(cookieHeader);
  const trimmedHeader =
    typeof csrfHeader === 'string' ? csrfHeader.trim() : undefined;
  if (!validCsrfPair(cookieToken, trimmedHeader)) {
    throw new ForbiddenException({
      code: errorCode,
      message: 'Missing or invalid CSRF token.',
    });
  }
}

function readSingleHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const method = (request.method ?? 'GET').toUpperCase();
    if (SAFE_HTTP_METHODS.has(method)) {
      return true;
    }

    const authorization = readSingleHeader(request.headers.authorization);
    const cookieHeader = readSingleHeader(request.headers.cookie);
    const csrfHeader = readSingleHeader(request.headers['x-csrf-token']);

    assertCookieAuthCsrf(authorization, cookieHeader, csrfHeader);
    return true;
  }
}
