import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'node:crypto';
import { PlatformServiceOperationsGuard } from './platform-service-operations.guard';

describe('PlatformServiceOperationsGuard', () => {
  const secret = 'platform-internal-secret-that-is-long-enough';

  function createContext(timestamp: string, signature: string) {
    const request = {
      method: 'GET',
      originalUrl: '/internal/platform/integrations?page=1',
      header: (name: string) =>
        name === 'x-platform-ops-timestamp'
          ? timestamp
          : name === 'x-platform-ops-signature'
            ? signature
            : undefined,
    };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  it('accepts a fresh HMAC signature bound to method and exact request target', () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const canonical = `${timestamp}\nGET\n/internal/platform/integrations?page=1`;
    const signature = createHmac('sha256', secret)
      .update(canonical)
      .digest('hex');
    const guard = new PlatformServiceOperationsGuard({
      get: () => secret,
    } as unknown as ConfigService);

    expect(guard.canActivate(createContext(timestamp, signature))).toBe(true);
  });

  it('binds POST signatures to the exact parsed JSON body', () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const path =
      '/internal/platform/integrations/651a2b3c4d5e6f7a8b9c0d1e/reconnect';
    const body = {
      actorUserId: '651a2b3c4d5e6f7a8b9c0d1f',
      idempotencyKey: 'integration-reconnect-001',
      expectedUpdatedAt: '2026-10-17T09:00:00.000Z',
    };
    const bodyHash = createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex');
    const canonical = `${timestamp}\nPOST\n${path}\n${bodyHash}`;
    const signature = createHmac('sha256', secret)
      .update(canonical)
      .digest('hex');
    const guard = new PlatformServiceOperationsGuard({
      get: () => secret,
    } as unknown as ConfigService);
    const context = (requestBody: Record<string, string>) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'POST',
            originalUrl: path,
            body: requestBody,
            header: (name: string) =>
              name === 'x-platform-ops-timestamp'
                ? timestamp
                : name === 'x-platform-ops-signature'
                  ? signature
                  : undefined,
          }),
        }),
      }) as unknown as ExecutionContext;

    expect(guard.canActivate(context(body))).toBe(true);
    expect(() =>
      guard.canActivate(
        context({ ...body, idempotencyKey: 'attacker-chosen-operation-key' }),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('rejects stale or invalid signatures and fails closed without configuration', () => {
    const guard = new PlatformServiceOperationsGuard({
      get: () => secret,
    } as unknown as ConfigService);
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 60);
    expect(() =>
      guard.canActivate(createContext(staleTimestamp, 'f'.repeat(64))),
    ).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(createContext('bad', 'bad'))).toThrow(
      UnauthorizedException,
    );

    const unconfigured = new PlatformServiceOperationsGuard({
      get: () => undefined,
    } as unknown as ConfigService);
    expect(() =>
      unconfigured.canActivate(createContext('1234567890', 'f'.repeat(64))),
    ).toThrow(ServiceUnavailableException);
  });
});
