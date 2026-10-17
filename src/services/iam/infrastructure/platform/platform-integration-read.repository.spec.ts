import type { ConfigService } from '@nestjs/config';
import { PlatformIntegrationReadHttpRepository } from './platform-integration-read.repository';

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof URL
    ? input.href
    : typeof input === 'string'
      ? input
      : input.url;
}

describe('PlatformIntegrationReadHttpRepository', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls the Jira owner boundary with a signed request and returns safe metadata only', async () => {
    const repository = new PlatformIntegrationReadHttpRepository({
      get: (key: string) =>
        key === 'JIRA_SERVICE_URL'
          ? 'http://jira:3003'
          : key === 'PLATFORM_SERVICE_OPS_SECRET'
            ? 'a'.repeat(48)
            : undefined,
    } as unknown as ConfigService);
    const summary = {
      id: 'a'.repeat(24),
      provider: 'JIRA',
      organizationId: 'b'.repeat(24),
      projectId: 'c'.repeat(24),
      status: 'CONNECTED',
      lastSyncAt: null,
      lastFailureAt: null,
      lastFailureSummary: null,
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z',
      credentialsEncrypted: 'never-forward-this',
    };
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [summary],
          pagination: {
            page: 2,
            pageSize: 5,
            totalItems: 1,
            totalPages: 1,
          },
        }),
      ),
    );

    const page = await repository.list({
      page: 2,
      pageSize: 5,
      organizationId: 'b'.repeat(24),
      status: 'CONNECTED',
    });

    expect(page.data[0]).not.toHaveProperty('credentialsEncrypted');
    expect(page.data[0]).toMatchObject({
      provider: 'JIRA',
      status: 'CONNECTED',
    });
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] ?? [];
    expect(requestUrl(calledUrl)).toBe(
      'http://jira:3003/internal/platform/integrations?page=2&pageSize=5&organizationId=' +
        'b'.repeat(24) +
        '&status=CONNECTED',
    );
    expect(
      new Headers(calledInit?.headers).get('x-platform-ops-signature'),
    ).toMatch(/^[a-f\d]{64}$/i);
    expect(calledInit?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(page)).not.toContain('credentialsEncrypted');
  });

  it('maps unavailable Jira responses to a safe dependency error', async () => {
    const repository = new PlatformIntegrationReadHttpRepository({
      get: (key: string) =>
        key === 'PLATFORM_SERVICE_OPS_SECRET'
          ? 'a'.repeat(48)
          : 'http://jira:3003',
    } as unknown as ConfigService);
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('secret=do-not-leak'));

    await expect(repository.list({ page: 1, pageSize: 20 })).rejects.toThrow(
      'Platform integration owner unavailable',
    );
  });
});
