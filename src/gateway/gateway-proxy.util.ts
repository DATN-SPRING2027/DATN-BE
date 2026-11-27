import { BadRequestException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';

const FORBIDDEN_PATH_PATTERN = /(?:%2e|%2f|%5c|%00|\\|\0|\/\/)/i;

/**
 * SEC-BE-005: Reject dot-segments, encoded path separators, backslashes, NUL bytes,
 * and cross-origin rewrites BEFORE passing any gateway request URL to `new URL(...)`.
 */
export function buildSafeInternalProxyUrl(
  originalUrl: string,
  baseUrl: string,
): URL {
  if (typeof originalUrl !== 'string' || originalUrl.length === 0) {
    throw new BadRequestException({
      code: 'INVALID_PROXY_PATH',
      message: 'Missing request URL.',
    });
  }
  const queryIndex = originalUrl.indexOf('?');
  const rawPathname =
    queryIndex === -1 ? originalUrl : originalUrl.slice(0, queryIndex);
  const rawSearch = queryIndex === -1 ? '' : originalUrl.slice(queryIndex);

  if (
    !rawPathname.startsWith('/api/v1/') ||
    FORBIDDEN_PATH_PATTERN.test(rawPathname)
  ) {
    throw new BadRequestException({
      code: 'INVALID_PROXY_PATH',
      message: 'Request path contains disallowed segments.',
    });
  }

  const segments = rawPathname.split('/');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new BadRequestException({
        code: 'INVALID_PROXY_PATH',
        message: 'Dot-segments are not permitted in proxy paths.',
      });
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new BadRequestException({
        code: 'INVALID_PROXY_PATH',
        message: 'Malformed percent-encoding in request path.',
      });
    }
    if (
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded.includes('\0')
    ) {
      throw new BadRequestException({
        code: 'INVALID_PROXY_PATH',
        message: 'Request path contains disallowed encoded segments.',
      });
    }
  }

  const rewrittenPathname = rawPathname.replace(/^\/api\/v1\//, '/internal/');
  const base = new URL(baseUrl);
  const target = new URL(`${rewrittenPathname}${rawSearch}`, base);
  if (
    target.origin !== base.origin ||
    !target.pathname.startsWith('/internal/') ||
    target.pathname !== rewrittenPathname
  ) {
    throw new BadRequestException({
      code: 'INVALID_PROXY_PATH',
      message: 'Resolved proxy target escapes allowed internal namespace.',
    });
  }
  return target;
}

export function collectForwardedRequestHeaders(
  request: Request,
  allowedHeaders: readonly string[],
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of allowedHeaders) {
    const value = request.headers[name];
    if (typeof value === 'string') {
      headers[name] = value;
    } else if (Array.isArray(value) && typeof value[0] === 'string') {
      headers[name] = value.join(', ');
    }
  }
  // OBS-003: Propagate W3C traceparent whenever present on incoming request.
  const traceparent = request.headers.traceparent;
  if (typeof traceparent === 'string' && !headers.traceparent) {
    headers.traceparent = traceparent;
  }
  return headers;
}

/**
 * BE-DATA-002 / BE-PERF: Stream large binary / SSE upstream bodies directly
 * to Express without buffering 25MB+ into V8 heap when `response` is a real
 * writable stream, while preserving `.send(Buffer)` compatibility for unit mocks.
 */
export async function sendOrStreamUpstreamResponse(
  upstream: globalThis.Response,
  response: Response,
  options: { preferStream?: boolean } = {},
): Promise<void> {
  response.status(upstream.status);
  const canStream =
    options.preferStream === true &&
    upstream.body !== null &&
    typeof (response as unknown as { write?: unknown }).write === 'function' &&
    typeof (response as unknown as { end?: unknown }).end === 'function' &&
    typeof (response as unknown as { on?: unknown }).on === 'function';

  if (canStream && upstream.body) {
    const nodeReadable = Readable.fromWeb(
      upstream.body as Parameters<typeof Readable.fromWeb>[0],
    );
    try {
      await pipeline(nodeReadable, response);
    } catch {
      if (!response.writableEnded) {
        response.end();
      }
    }
    return;
  }

  response.send(Buffer.from(await upstream.arrayBuffer()));
}
