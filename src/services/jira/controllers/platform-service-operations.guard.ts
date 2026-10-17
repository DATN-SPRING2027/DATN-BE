import {
  CanActivate,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { ExecutionContext } from '@nestjs/common';

const timestampWindowSeconds = 30;

@Injectable()
export class PlatformServiceOperationsGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.config.get<string>('PLATFORM_SERVICE_OPS_SECRET');
    if (!secret || secret.length < 32) {
      throw new ServiceUnavailableException(
        'Platform service operations are not configured',
      );
    }
    const request = context.switchToHttp().getRequest<Request>();
    const timestamp = request.header('x-platform-ops-timestamp') ?? '';
    const signature = request.header('x-platform-ops-signature') ?? '';
    if (!/^\d{10}$/.test(timestamp) || !/^[a-f\d]{64}$/i.test(signature)) {
      throw new UnauthorizedException({
        code: 'PLATFORM_SERVICE_AUTH_INVALID',
      });
    }
    const ageSeconds = Math.abs(
      Math.floor(Date.now() / 1000) - Number(timestamp),
    );
    if (ageSeconds > timestampWindowSeconds) {
      throw new UnauthorizedException({
        code: 'PLATFORM_SERVICE_AUTH_INVALID',
      });
    }
    const method = request.method.toUpperCase();
    const canonicalTarget = `${timestamp}\n${method}\n${request.originalUrl}`;
    let canonical = canonicalTarget;
    if (method !== 'GET') {
      let serializedBody: string | undefined;
      try {
        serializedBody = JSON.stringify(request.body ?? null);
      } catch {
        throw new UnauthorizedException({
          code: 'PLATFORM_SERVICE_AUTH_INVALID',
        });
      }
      if (typeof serializedBody !== 'string')
        throw new UnauthorizedException({
          code: 'PLATFORM_SERVICE_AUTH_INVALID',
        });
      const bodyHash = createHash('sha256')
        .update(serializedBody)
        .digest('hex');
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
    return true;
  }
}
