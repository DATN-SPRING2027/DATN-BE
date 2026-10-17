/* eslint-disable @typescript-eslint/unbound-method -- Assertions inspect Jest mock methods. */
import {
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { JiraPlatformIntegrationOperationsProvider } from './platform-integration-operations.repository';
import { PlatformIntegrationOperationsService } from './platform-integration-operations.service';

describe('Jira PlatformIntegrationOperationsService', () => {
  it('validates IDs, idempotency, and expected timestamps before delegating', async () => {
    const provider = {
      testConnection: jest.fn(),
      reconnect: jest.fn(),
    } as jest.Mocked<JiraPlatformIntegrationOperationsProvider>;
    const service = new PlatformIntegrationOperationsService(provider);

    await expect(
      service.reconnect({
        integrationId: 'not-an-id',
        actorUserId: '651a2b3c4d5e6f7a8b9c0d1f',
        idempotencyKey: 'integration-reconnect-001',
        expectedUpdatedAt: '2026-10-17T09:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(provider.reconnect).not.toHaveBeenCalled();
  });

  it('returns a safe unavailable error when the Jira credential provider is absent', async () => {
    const provider: JiraPlatformIntegrationOperationsProvider = {
      testConnection: jest.fn().mockRejectedValue(
        new ServiceUnavailableException({
          code: 'JIRA_INTEGRATION_PROVIDER_UNAVAILABLE',
        }),
      ),
      reconnect: jest.fn().mockRejectedValue(
        new ServiceUnavailableException({
          code: 'JIRA_INTEGRATION_PROVIDER_UNAVAILABLE',
        }),
      ),
    };
    const service = new PlatformIntegrationOperationsService(provider);

    await expect(
      service.testConnection({
        integrationId: '651a2b3c4d5e6f7a8b9c0d1f',
        actorUserId: '751a2b3c4d5e6f7a8b9c0d1f',
        idempotencyKey: 'integration-test-connection-001',
      }),
    ).rejects.toMatchObject({
      response: { code: 'JIRA_INTEGRATION_PROVIDER_UNAVAILABLE' },
    });
    await expect(
      service.reconnect({
        integrationId: '651a2b3c4d5e6f7a8b9c0d1f',
        actorUserId: '751a2b3c4d5e6f7a8b9c0d1f',
        idempotencyKey: 'integration-reconnect-001',
        expectedUpdatedAt: '2026-10-17T09:00:00.000Z',
      }),
    ).rejects.toMatchObject({
      response: { code: 'JIRA_INTEGRATION_PROVIDER_UNAVAILABLE' },
    });
    expect(provider.testConnection).toHaveBeenCalledTimes(1);
    expect(provider.reconnect).toHaveBeenCalledTimes(1);
  });
});
