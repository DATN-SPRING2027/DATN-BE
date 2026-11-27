import { posix } from 'node:path';
import type { NextFunction, Request, Response } from 'express';

const SAFE_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_MCP_RPC_METHODS = new Set([
  'GET',
  'POST',
  'DELETE',
  'OPTIONS',
  'HEAD',
]);
const ALLOWED_MCP_RPC_PATHS = new Set([
  '/api/v1/mcp',
  '/api/v1/mcp/',
  '/internal/mcp',
  '/internal/mcp/',
]);

const ALLOWED_LOOPBACK_READ_PATTERNS: readonly RegExp[] = [
  /^\/(?:api\/v1|internal)\/auth\/me$/,
  /^\/(?:api\/v1|internal)\/iam\/mcp-api-keys$/,
  /^\/(?:api\/v1|internal)\/iam\/projects\/[a-f0-9]{24}(?:\/(?:settings-access|memberships|leaders))?$/i,
  /^\/(?:api\/v1\/)?internal\/tasks\/projects\/[a-f0-9]{24}\/tasks(?:\/[a-f0-9]{24})?$/i,
];

function decodeSafePathname(pathname: string): string | null {
  if (!pathname || /%2e|%2f|\\/i.test(pathname)) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (
    decoded.includes('..') ||
    decoded.includes('\\') ||
    decoded.includes('\0')
  ) {
    return null;
  }
  return posix.normalize(decoded);
}

function isMcpRpcPathname(normalizedPath: string | null): boolean {
  return normalizedPath !== null && ALLOWED_MCP_RPC_PATHS.has(normalizedPath);
}

function trimTrailingSlashes(value: string, keepRoot = false): string {
  const minEnd = keepRoot && value.startsWith('/') ? 1 : 0;
  let end = value.length;
  while (end > minEnd && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function isAllowedLoopbackReadPathname(normalizedPath: string | null): boolean {
  if (normalizedPath === null) {
    return false;
  }
  const stripped = trimTrailingSlashes(normalizedPath, true);
  return ALLOWED_LOOPBACK_READ_PATTERNS.some((pattern) =>
    pattern.test(stripped),
  );
}

function denyMcpDirectRest(
  request: Request,
  response: Response,
  code: string,
  message: string,
): void {
  if (typeof request.resume === 'function') {
    request.resume();
  }
  response.setHeader('Connection', 'close');
  response.status(403).json({
    code,
    message,
  });
}

/**
 * Defense-in-depth HTTP boundary guard for Continuum MCP API keys (`Bearer ctm_mcp_...`).
 * - Allows `POST`/`GET`/`DELETE`/`OPTIONS`/`HEAD` on `/api/v1/mcp` and `/internal/mcp`.
 * - Outside MCP JSON-RPC endpoints, blocks all mutations (`MCP_KEY_DIRECT_MUTATION_FORBIDDEN`)
 *   and restricts `GET`/`HEAD` strictly to internal service-to-service loopback verification routes
 *   (`MCP_KEY_DIRECT_REST_FORBIDDEN`), while letting `GET /api/v1/iam/mcp-api-keys` reach its
 *   session-only controller `401`.
 */
export function mcpKeyRestMutationGuardMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const authorization = request.headers.authorization;
  if (
    typeof authorization === 'string' &&
    /^Bearer\s+ctm_mcp_/i.test(authorization.trim())
  ) {
    const method = (request.method || 'GET').toUpperCase();
    const rawUrl = request.originalUrl || request.url || '';
    const pathname = rawUrl.split('?')[0] ?? '';
    const normalizedPath = decodeSafePathname(pathname);

    if (isMcpRpcPathname(normalizedPath)) {
      if (!ALLOWED_MCP_RPC_METHODS.has(method)) {
        denyMcpDirectRest(
          request,
          response,
          'MCP_KEY_DIRECT_MUTATION_FORBIDDEN',
          'MCP API keys can only execute mutations through the /api/v1/mcp JSON-RPC endpoint.',
        );
        return;
      }
      next();
      return;
    }

    if (!SAFE_READ_METHODS.has(method)) {
      denyMcpDirectRest(
        request,
        response,
        'MCP_KEY_DIRECT_MUTATION_FORBIDDEN',
        'MCP API keys can only execute mutations through the /api/v1/mcp JSON-RPC endpoint.',
      );
      return;
    }

    if (
      method !== 'OPTIONS' &&
      !isAllowedLoopbackReadPathname(normalizedPath)
    ) {
      denyMcpDirectRest(
        request,
        response,
        'MCP_KEY_DIRECT_REST_FORBIDDEN',
        'MCP API keys can only access Continuum resources through the /api/v1/mcp JSON-RPC endpoint.',
      );
      return;
    }
  }
  next();
}
