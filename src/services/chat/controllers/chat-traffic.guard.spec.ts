import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatIamClient } from '../application/chat-iam.client';
import { RedisService } from '../infrastructure/redis/redis.service';
import { ChatTrafficGuard } from './chat-traffic.guard';

describe('ChatTrafficGuard', () => {
  const actor = { id: 'user-1', organizationId: 'org-1' };
  let iam: { getActor: jest.Mock };
  let redis: { consumeRateLimit: jest.Mock };
  let guard: ChatTrafficGuard;

  function context(request: {
    method: string;
    headers: Record<string, string | undefined>;
    ip?: string;
  }): ExecutionContext {
    const expressRequest = {
      ip: '127.0.0.1',
      ...request,
      get: (header: string) => request.headers[header.toLowerCase()],
    };
    return {
      switchToHttp: () => ({ getRequest: () => expressRequest }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    iam = { getActor: jest.fn().mockResolvedValue(actor) };
    redis = { consumeRateLimit: jest.fn().mockResolvedValue(true) };
    guard = new ChatTrafficGuard(
      iam as unknown as ChatIamClient,
      redis as unknown as RedisService,
      { get: () => 'continuum' } as unknown as ConfigService,
    );
  });

  it.each([
    ['missing', undefined],
    ['mismatched', 'other-token'],
  ])(
    'rejects cookie-authenticated POST requests with a %s CSRF pair',
    async (_case, csrfHeader) => {
      await expect(
        guard.canActivate(
          context({
            method: 'POST',
            headers: {
              cookie: 'continuum_access=session; __Host-csrf=csrf-value',
              'x-csrf-token': csrfHeader,
            },
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(iam.getActor).not.toHaveBeenCalled();
      expect(redis.consumeRateLimit).not.toHaveBeenCalled();
    },
  );

  it('allows an unsafe cookie-authenticated request with the matching CSRF pair', async () => {
    await expect(
      guard.canActivate(
        context({
          method: 'POST',
          headers: {
            cookie: 'continuum_access=session; __Host-csrf=csrf-value',
            'x-csrf-token': 'csrf-value',
          },
        }),
      ),
    ).resolves.toBe(true);

    expect(iam.getActor).toHaveBeenCalledTimes(1);
    expect(redis.consumeRateLimit).toHaveBeenCalledTimes(1);
  });

  it('keeps bearer-only unsafe requests and safe cookie requests compatible', async () => {
    await expect(
      guard.canActivate(
        context({ method: 'POST', headers: { authorization: 'Bearer token' } }),
      ),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(
        context({
          method: 'GET',
          headers: { cookie: 'continuum_access=session' },
        }),
      ),
    ).resolves.toBe(true);

    expect(iam.getActor).toHaveBeenCalledTimes(2);
  });

  it('enforces rate limiting BEFORE calling IAM so throttled callers cannot hammer IAM (SEC-BE-012)', async () => {
    redis.consumeRateLimit.mockResolvedValue(false);

    await expect(
      guard.canActivate(
        context({
          method: 'GET',
          headers: { authorization: 'Bearer throttled-token' },
        }),
      ),
    ).rejects.toMatchObject({
      status: 429,
    });
    await expect(
      guard.canActivate(
        context({
          method: 'GET',
          headers: { authorization: 'Bearer throttled-token' },
        }),
      ),
    ).rejects.toBeInstanceOf(HttpException);

    expect(redis.consumeRateLimit).toHaveBeenCalledTimes(2);
    expect(iam.getActor).not.toHaveBeenCalled();
  });

  it('forwards x-organization-id and x-expected-organization-id headers to IAM (SEC-BE-005)', async () => {
    await expect(
      guard.canActivate(
        context({
          method: 'GET',
          headers: {
            authorization: 'Bearer token',
            'x-organization-id': '507f1f77bcf86cd799439011',
            'x-expected-organization-id': '507f1f77bcf86cd799439011',
          },
        }),
      ),
    ).resolves.toBe(true);

    expect(iam.getActor).toHaveBeenCalledWith({
      authorization: 'Bearer token',
      cookie: undefined,
      organizationId: '507f1f77bcf86cd799439011',
      expectedOrganizationId: '507f1f77bcf86cd799439011',
    });
  });
});
