import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'node:crypto';
import { PlatformIntegrationOperationsHttpRepository } from './platform-integration-operations.repository';

describe('PlatformIntegrationOperationsHttpRepository', () => {
  const integrationId = '507f1f77bcf86cd799439011';
  const actorUserId = '507f1f77bcf86cd799439012';
  const baseConfig = {
    get: jest.fn((key: string) => {
      if (key === 'JIRA_SERVICE_URL') return 'http://jira.internal';
      if (key === 'PLATFORM_SERVICE_OPS_SECRET') return 's'.repeat(48);
      return undefined;
    }),
  } as unknown as ConfigService;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fails closed when the Jira owner returns its blocked provider status', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ code: 'JIRA_INTEGRATION_PROVIDER_UNAVAILABLE' }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        ),
      );
    const repository = new PlatformIntegrationOperationsHttpRepository(
      baseConfig,
    );

    await expect(
      repository.testConnection({
        actorUserId,
        integrationId,
        idempotencyKey: 'integration-test-key-00001',
      }),
    ).rejects.toMatchObject({
      response: { code: 'PLATFORM_INTEGRATION_OPERATION_UNAVAILABLE' },
    });
  });

  it('does not expose provider failure details in a test result', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          integrationId,
          status: 'FAILED',
          testedAt: '2026-10-17T10:00:00.000Z',
          failureSummary: 'token=secret@example.test',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const repository = new PlatformIntegrationOperationsHttpRepository(
      baseConfig,
    );

    await expect(
      repository.testConnection({
        actorUserId,
        integrationId,
        idempotencyKey: 'integration-test-key-00002',
      }),
    ).resolves.toEqual({
      integrationId,
      status: 'FAILED',
      testedAt: '2026-10-17T10:00:00.000Z',
      failureSummary:
        'Jira connection test failed. Provider details are withheld.',
    });
  });

  it('does not call Jira when signed service configuration is missing', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    const config = {
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;
    const repository = new PlatformIntegrationOperationsHttpRepository(config);

    await expect(
      repository.reconnect({
        actorUserId,
        integrationId,
        idempotencyKey: 'integration-reconnect-key-01',
        expectedUpdatedAt: new Date('2026-10-17T10:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('signs the exact serialized POST body for the Jira owner', async () => {
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 503 }));
    const repository = new PlatformIntegrationOperationsHttpRepository(
      baseConfig,
    );

    await expect(
      repository.testConnection({
        actorUserId,
        integrationId,
        idempotencyKey: 'integration-test-signature-01',
      }),
    ).rejects.toMatchObject({
      response: { code: 'PLATFORM_INTEGRATION_OPERATION_UNAVAILABLE' },
    });
    const [target, request] = fetch.mock.calls[0];
    const body = typeof request?.body === 'string' ? request.body : '';
    const headers = request?.headers as Record<string, string>;
    const timestamp = headers['x-platform-ops-timestamp'];
    const url =
      target instanceof URL
        ? target
        : new URL(typeof target === 'string' ? target : target.url);
    const canonical = `${timestamp}\nPOST\n${url.pathname}${url.search}\n${createHash('sha256').update(body).digest('hex')}`;

    expect(headers['x-platform-ops-signature']).toBe(
      createHmac('sha256', 's'.repeat(48)).update(canonical).digest('hex'),
    );
  });
});
