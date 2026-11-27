import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'node:crypto';
import type { Response } from 'express';
import {
  PlatformServiceOperationsGuard,
  type PlatformOpsAuthenticatedRequest,
} from './platform-service-operations.guard';
import { JiraController } from './jira.controller';
import { createCollectionSchema } from '../infrastructure/mongodb/mongodb.schemas';
import { JIRA_PERSISTENCE } from '../infrastructure/persistence';

describe('PlatformServiceOperationsGuard & Jira security hardening (SEC-BE-009 / SEC-BE-017)', () => {
  const secret = 'platform-internal-secret-that-is-long-enough';
  const actorUserId = '651a2b3c4d5e6f7a8b9c0d1f';

  function signRequest(input: {
    timestamp: string;
    nonce: string;
    method: string;
    originalUrl: string;
    actorId?: string;
    rawBody?: Buffer | string;
    body?: unknown;
  }): string {
    const actor = (input.actorId ?? '').toLowerCase();
    let canonical = `${input.timestamp}\n${input.nonce}\n${input.method.toUpperCase()}\n${input.originalUrl}\n${actor}`;
    if (input.method.toUpperCase() !== 'GET') {
      const hashInput =
        input.rawBody !== undefined
          ? input.rawBody
          : JSON.stringify(input.body ?? null);
      const bodyHash = createHash('sha256').update(hashInput).digest('hex');
      canonical = `${canonical}\n${bodyHash}`;
    }
    return createHmac('sha256', secret).update(canonical).digest('hex');
  }

  function createContext(input: {
    method?: string;
    originalUrl?: string;
    timestamp: string;
    signature: string;
    nonce?: string;
    actorId?: string;
    body?: unknown;
    rawBody?: Buffer | string;
  }) {
    const headers: Record<string, string | undefined> = {
      'x-platform-ops-timestamp': input.timestamp,
      'x-platform-ops-signature': input.signature,
      'x-platform-ops-nonce': input.nonce,
      'x-platform-ops-actor-id': input.actorId,
    };
    const request: Partial<PlatformOpsAuthenticatedRequest> = {
      method: input.method ?? 'GET',
      originalUrl:
        input.originalUrl ?? '/internal/platform/integrations?page=1',
      body: input.body,
      rawBody: input.rawBody,
      header: ((name: string) => headers[name.toLowerCase()]) as never,
    };
    return {
      request,
      context: {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext,
    };
  }

  it('accepts a fresh HMAC signature bound to nonce, method, target, and rejects replay (SEC-BE-009)', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = 'nonce-unique-0000000001';
    const originalUrl = '/internal/platform/integrations?page=1';
    const signature = signRequest({
      timestamp,
      nonce,
      method: 'GET',
      originalUrl,
    });
    const usedNonces = new Set<string>();
    const redisMock = {
      setIfAbsent: jest.fn((key: string) => {
        if (usedNonces.has(key)) return Promise.resolve(false);
        usedNonces.add(key);
        return Promise.resolve(true);
      }),
    };
    const guard = new PlatformServiceOperationsGuard(
      { get: () => secret } as unknown as ConfigService,
      redisMock as never,
    );

    const first = createContext({ timestamp, signature, nonce, originalUrl });
    await expect(guard.canActivate(first.context)).resolves.toBe(true);
    expect(redisMock.setIfAbsent).toHaveBeenCalledWith(
      `platform-ops:nonce:${nonce}`,
      '1',
      90,
    );

    // Replaying the exact signed request MUST fail with PLATFORM_SERVICE_AUTH_REPLAYED
    const replay = createContext({ timestamp, signature, nonce, originalUrl });
    await expect(guard.canActivate(replay.context)).rejects.toMatchObject({
      response: { code: 'PLATFORM_SERVICE_AUTH_REPLAYED' },
    });
  });

  it('binds POST signatures to rawBody bytes, requires x-platform-ops-actor-id, and sets verified actor on request', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const path =
      '/internal/platform/integrations/651a2b3c4d5e6f7a8b9c0d1e/reconnect';
    const body = {
      actorUserId,
      idempotencyKey: 'integration-reconnect-001',
      expectedUpdatedAt: '2026-10-17T09:00:00.000Z',
    };
    const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
    const nonce = 'nonce-post-unique-00001';
    const signature = signRequest({
      timestamp,
      nonce,
      method: 'POST',
      originalUrl: path,
      actorId: actorUserId,
      rawBody,
    });

    const guard = new PlatformServiceOperationsGuard({
      get: () => secret,
    } as unknown as ConfigService);

    const valid = createContext({
      method: 'POST',
      originalUrl: path,
      timestamp,
      signature,
      nonce,
      actorId: actorUserId,
      body,
      rawBody,
    });
    await expect(guard.canActivate(valid.context)).resolves.toBe(true);
    expect(valid.request.platformOpsActorUserId).toBe(actorUserId);

    // Mutating rawBody whitespace breaks rawBody hash check even if parsed body matches
    const tamperedRaw = createContext({
      method: 'POST',
      originalUrl: path,
      timestamp,
      signature,
      nonce: 'nonce-post-unique-00002',
      actorId: actorUserId,
      body,
      rawBody: Buffer.from(` ${JSON.stringify(body)} `, 'utf8'),
    });
    await expect(guard.canActivate(tamperedRaw.context)).rejects.toThrow(
      UnauthorizedException,
    );

    // Missing x-platform-ops-actor-id on POST is rejected
    const missingActor = createContext({
      method: 'POST',
      originalUrl: path,
      timestamp,
      signature,
      nonce: 'nonce-post-unique-00003',
      body,
      rawBody,
    });
    await expect(guard.canActivate(missingActor.context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects stale/invalid signatures, missing nonce, and fails closed without configuration or Redis in non-test env', async () => {
    const guard = new PlatformServiceOperationsGuard({
      get: () => secret,
    } as unknown as ConfigService);
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 60);
    await expect(
      guard.canActivate(
        createContext({
          timestamp: staleTimestamp,
          signature: 'f'.repeat(64),
          nonce: 'nonce-stale-000000001',
        }).context,
      ),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      guard.canActivate(
        createContext({
          timestamp: Math.floor(Date.now() / 1000).toString(),
          signature: 'f'.repeat(64),
          nonce: 'short',
        }).context,
      ),
    ).rejects.toThrow(UnauthorizedException);

    const unconfigured = new PlatformServiceOperationsGuard({
      get: () => undefined,
    } as unknown as ConfigService);
    await expect(
      unconfigured.canActivate(
        createContext({
          timestamp: '1234567890',
          signature: 'f'.repeat(64),
          nonce: 'nonce-unconfigured-01',
        }).context,
      ),
    ).rejects.toThrow(ServiceUnavailableException);

    // Non-test environment without Redis fails closed with 503
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = 'nonce-prod-fail-closed-1';
      const originalUrl = '/internal/platform/integrations?page=1';
      const signature = signRequest({
        timestamp,
        nonce,
        method: 'GET',
        originalUrl,
      });
      await expect(
        guard.canActivate(
          createContext({ timestamp, signature, nonce, originalUrl }).context,
        ),
      ).rejects.toThrow(ServiceUnavailableException);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it('JiraController rejects spoofed body actorUserId mismatching verified header actor (SEC-BE-009)', () => {
    const ops = { testConnection: jest.fn(), reconnect: jest.fn() };
    const controller = new JiraController(
      {} as never,
      {} as never,
      ops as never,
    );
    const response = { setHeader: jest.fn() } as unknown as Response;

    expect(() =>
      controller.testPlatformIntegrationConnection(
        '651a2b3c4d5e6f7a8b9c0d1e',
        {
          actorUserId: 'ffffffffffffffffffffffff',
          idempotencyKey: 'op-1',
        },
        {
          platformOpsActorUserId: actorUserId,
        } as PlatformOpsAuthenticatedRequest,
        response,
      ),
    ).toThrow(ForbiddenException);
    expect(ops.testConnection).not.toHaveBeenCalled();
  });

  it('jira_connections schema enforces webhookSecretEncrypted and HTTPS *.atlassian.net atlassianUrl (SEC-BE-017)', () => {
    const def = JIRA_PERSISTENCE.collections.find(
      (c) => c.name === 'jira_connections',
    )!;
    const schema = createCollectionSchema(def);
    expect(schema.path('webhookSecretEncrypted')).toBeDefined();
    expect(schema.path('webhookSecret')).toBeUndefined();

    const urlPath = schema.path('atlassianUrl') as unknown as {
      validators: Array<{
        type?: string;
        message?: string;
        validator: (v: string) => boolean;
      }>;
    };
    const validator = urlPath.validators.find(
      (v) => v.type === 'user defined' && typeof v.validator === 'function',
    )!.validator;
    expect(validator('https://continuum-team.atlassian.net')).toBe(true);
    expect(validator('http://continuum-team.atlassian.net')).toBe(false);
    expect(validator('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(validator('https://localhost/jira')).toBe(false);
    expect(validator('https://evil.example.com')).toBe(false);
  });
});
