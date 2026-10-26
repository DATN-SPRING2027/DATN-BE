import { createHash } from 'node:crypto';
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthSecurityStore } from '../authentication/auth-security.store';

const windowSeconds = 60;
const limits = { read: 120, write: 20 } as const;

// Shared Redis counters across IAM instances and resources. Only verified actor
// IDs reach this function; forwarded IPs and caller-provided identities are unused.
export async function enforcePlatformRateLimit(
  store: Pick<AuthSecurityStore, 'consumeRateLimit'>,
  actorUserId: string,
  method: string,
  response: Response,
): Promise<void> {
  const bucket = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'read' : 'write';
  const nowSeconds = Math.floor(Date.now() / 1000);
  const window = Math.floor(nowSeconds / windowSeconds);
  const reset = (window + 1) * windowSeconds;
  const actor = createHash('sha256')
    .update(actorUserId.toLowerCase())
    .digest('hex');
  let allowed: boolean;
  try {
    allowed = await store.consumeRateLimit(
      `platform:${bucket}:${actor}:${window}`,
      limits[bucket],
      windowSeconds,
    );
  } catch {
    throw new ServiceUnavailableException({
      code: 'PLATFORM_RATE_LIMIT_UNAVAILABLE',
      message: 'Platform request limiting is temporarily unavailable.',
    });
  }
  response.setHeader('X-RateLimit-Limit', limits[bucket]);
  response.setHeader('X-RateLimit-Reset', reset);
  if (!allowed) {
    response.setHeader('Retry-After', Math.max(1, reset - nowSeconds));
    throw new HttpException(
      {
        code: 'TOO_MANY_REQUESTS',
        message: 'Platform request limit exceeded.',
      },
      429,
    );
  }
}
