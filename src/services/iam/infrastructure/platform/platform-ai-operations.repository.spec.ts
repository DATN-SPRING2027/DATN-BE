import type { ConfigService } from '@nestjs/config';
import { SagPlatformAiOperationsRepository } from './platform-ai-operations.repository';

describe('SagPlatformAiOperationsRepository', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('reads SAG liveness and readiness separately and projects only safe operational state', async () => {
    const repository = new SagPlatformAiOperationsRepository({
      get: () => 'http://sag-api:8000',
    } as unknown as ConfigService);
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url =
        input instanceof URL
          ? input.href
          : typeof input === 'string'
            ? input
            : input.url;
      return Promise.resolve(
        url.endsWith('/health')
          ? new Response(JSON.stringify({ status: 'ok' }))
          : new Response(
              JSON.stringify({
                status: 'unavailable',
                db: true,
                credential: 'must-not-escape',
              }),
              { status: 503 },
            ),
      );
    });

    const status = await repository.getStatus();

    expect(status).toMatchObject({
      id: 'sag',
      status: 'DEGRADED',
      availability: 'AVAILABLE',
      liveness: 'ALIVE',
      readiness: 'UNAVAILABLE',
      dependencies: {
        database: 'AVAILABLE',
        knowledgeRuntime: 'UNAVAILABLE',
        modelProvider: 'NOT_EXPOSED',
      },
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(status)).not.toContain('credential');
  });

  it('returns an unavailable summary without forwarding external error text', async () => {
    const repository = new SagPlatformAiOperationsRepository({
      get: () => undefined,
    } as unknown as ConfigService);
    global.fetch = jest.fn().mockRejectedValue(new Error('api_key=private'));

    const status = await repository.getStatus();

    expect(status).toMatchObject({
      status: 'UNAVAILABLE',
      availability: 'UNAVAILABLE',
      liveness: 'UNAVAILABLE',
      readiness: 'UNAVAILABLE',
    });
    expect(JSON.stringify(status)).not.toContain('private');
  });
});
