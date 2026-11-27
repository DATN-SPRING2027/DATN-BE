import {
  CanActivate,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { ExecutionContext } from '@nestjs/common';
import { RedisService } from '../infrastructure/redis/redis.service';

const TIMESTAMP_WINDOW_SECONDS = 30;
const NONCE_TTL_SECONDS = 90;
const NONCE_RE = /^[a-zA-Z0-9._-]{16,128}$/;
const ACTOR_ID_RE = /^[a-f0-9]{24}$/i;
const MAX_TEST_NONCE_ENTRIES = 1000;

export interface PlatformOpsAuthenticatedRequest extends Request {
  rawBody?: Buffer | string;
  platformOpsActorUserId?: string;
  platformOpsNonce?: string;
}

@Injectable()
export class PlatformServiceOperationsGuard implements CanActivate {
  private readonly testNonceStore = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const secret = this.config.get<string>('PLATFORM_SERVICE_OPS_SECRET');
    if (!secret || secret.length < 32) {
      throw new ServiceUnavailableException(
        'Platform service operations are not configured',
      );
    }
    const request = context
      .switchToHttp()
      .getRequest<PlatformOpsAuthenticatedRequest>();
    const timestamp = request.header('x-platform-ops-timestamp') ?? '';
    const signature = request.header('x-platform-ops-signature') ?? '';
    const nonce = (request.header('x-platform-ops-nonce') ?? '').trim();
    const rawActorId = (request.header('x-platform-ops-actor-id') ?? '').trim();
    const method = request.method.toUpperCase();

    if (
      !/^\d{10}$/.test(timestamp) ||
      !/^[a-f\d]{64}$/i.test(signature) ||
      !NONCE_RE.test(nonce)
    ) {
      throw new UnauthorizedException({
        code: 'PLATFORM_SERVICE_AUTH_INVALID',
      });
    }
    if (method !== 'GET') {
      if (!ACTOR_ID_RE.test(rawActorId)) {
        throw new UnauthorizedException({
          code: 'PLATFORM_SERVICE_AUTH_INVALID',
        });
      }
    } else if (rawActorId && !ACTOR_ID_RE.test(rawActorId)) {
      throw new UnauthorizedException({
        code: 'PLATFORM_SERVICE_AUTH_INVALID',
      });
    }

    const ageSeconds = Math.abs(
      Math.floor(Date.now() / 1000) - Number(timestamp),
    );
    if (ageSeconds > TIMESTAMP_WINDOW_SECONDS) {
      throw new UnauthorizedException({
        code: 'PLATFORM_SERVICE_AUTH_INVALID',
      });
    }

    const actorId = rawActorId.toLowerCase();
    const canonicalTarget = `${timestamp}\n${nonce}\n${method}\n${request.originalUrl}\n${actorId}`;
    let canonical = canonicalTarget;
    if (method !== 'GET') {
      const bodyHash = this.computeBodyHash(request);
      canonical = `${canonicalTarget}\n${bodyHash}`;
    }

    const expected = createHmac('sha256', secret).update(canonical).digest();
    const supplied = Buffer.from(signature, 'hex');
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new UnauthorizedException({
        code: 'PLATFORM_SERVICE_AUTH_INVALID',
      });
    }

    await this.consumeSingleUseNonce(nonce);

    if (actorId) {
      request.platformOpsActorUserId = actorId;
    }
    request.platformOpsNonce = nonce;
    return true;
  }

  private computeBodyHash(request: PlatformOpsAuthenticatedRequest): string {
    if (Buffer.isBuffer(request.rawBody)) {
      return createHash('sha256').update(request.rawBody).digest('hex');
    }
    if (typeof request.rawBody === 'string') {
      return createHash('sha256').update(request.rawBody, 'utf8').digest('hex');
    }
    let serializedBody: string | undefined;
    try {
      serializedBody = JSON.stringify(request.body ?? null);
    } catch {
      throw new UnauthorizedException({
        code: 'PLATFORM_SERVICE_AUTH_INVALID',
      });
    }
    if (typeof serializedBody !== 'string') {
      throw new UnauthorizedException({
        code: 'PLATFORM_SERVICE_AUTH_INVALID',
      });
    }
    return createHash('sha256').update(serializedBody).digest('hex');
  }

  private async consumeSingleUseNonce(nonce: string): Promise<void> {
    if (this.redis) {
      let claimed: boolean;
      try {
        claimed = await this.redis.setIfAbsent(
          `platform-ops:nonce:${nonce}`,
          '1',
          NONCE_TTL_SECONDS,
        );
      } catch {
        throw new ServiceUnavailableException({
          code: 'PLATFORM_SERVICE_REPLAY_STORE_UNAVAILABLE',
          message: 'Platform service replay protection is unavailable.',
        });
      }
      if (!claimed) {
        throw new UnauthorizedException({
          code: 'PLATFORM_SERVICE_AUTH_REPLAYED',
        });
      }
      return;
    }

    if (process.env.NODE_ENV !== 'test') {
      throw new ServiceUnavailableException({
        code: 'PLATFORM_SERVICE_REPLAY_STORE_UNAVAILABLE',
        message: 'Platform service replay protection is unavailable.',
      });
    }

    const now = Date.now();
    for (const [storedNonce, expiresAt] of this.testNonceStore.entries()) {
      if (expiresAt <= now) {
        this.testNonceStore.delete(storedNonce);
      }
    }
    if (this.testNonceStore.has(nonce)) {
      throw new UnauthorizedException({
        code: 'PLATFORM_SERVICE_AUTH_REPLAYED',
      });
    }
    if (this.testNonceStore.size >= MAX_TEST_NONCE_ENTRIES) {
      const firstEntry = this.testNonceStore.keys().next();
      if (!firstEntry.done) this.testNonceStore.delete(firstEntry.value);
    }
    this.testNonceStore.set(nonce, now + NONCE_TTL_SECONDS * 1000);
  }
}
