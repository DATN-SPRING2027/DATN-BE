import type { ConfigService } from '@nestjs/config';
import { HttpPlatformServiceOperationsRepository } from './platform-service-operations.repository';

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof URL
    ? input.href
    : typeof input === 'string'
      ? input
      : input.url;
}

describe('HttpPlatformServiceOperationsRepository', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('probes each configured service and returns only the safe health projection', async () => {
    const repository = new HttpPlatformServiceOperationsRepository({
      get: (key: string) =>
        key === 'CAPTURE_SERVICE_URL'
          ? 'http://capture.internal:3002'
          : undefined,
    } as unknown as ConfigService);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'READY',
          liveness: 'ALIVE',
          dependencies: { mongodb: 'AVAILABLE', redis: 'AVAILABLE' },
          credential: 'never-forward-this',
        }),
      ),
    );

    const page = await repository.listServices();

    expect(page.data).toHaveLength(8);
    expect(page.data[0]).toMatchObject({
      id: 'iam',
      name: 'Identity and Access Management',
      status: 'READY',
      liveness: 'ALIVE',
      readiness: 'READY',
      dependencies: { mongodb: 'AVAILABLE', redis: 'AVAILABLE' },
    });
    expect(JSON.stringify(page)).not.toContain('credential');
    const captureProbe = fetchSpy.mock.calls.find(
      ([target]) =>
        requestUrl(target) ===
        'http://capture.internal:3002/internal/health/ready',
    );
    expect(captureProbe).toBeDefined();
    expect(captureProbe?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a timed-out or unreachable owner as unavailable without its error text', async () => {
    const repository = new HttpPlatformServiceOperationsRepository({
      get: () => undefined,
    } as unknown as ConfigService);
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('redis password=do-not-leak'));

    const service = await repository.findService('jira');

    expect(service).toMatchObject({
      id: 'jira',
      status: 'UNAVAILABLE',
      liveness: 'UNAVAILABLE',
      readiness: 'UNAVAILABLE',
      dependencies: { mongodb: 'UNAVAILABLE', redis: 'UNAVAILABLE' },
    });
    expect(JSON.stringify(service)).not.toContain('do-not-leak');
  });

  it('falls back to /api/v1/health/ready when /internal/health/ready returns 404', async () => {
    const repository = new HttpPlatformServiceOperationsRepository({
      get: (key: string) =>
        key === 'IAM_SERVICE_URL' ? 'http://127.0.0.1:3001' : undefined,
    } as unknown as ConfigService);
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation((input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.endsWith('/internal/health/ready')) {
          return Promise.resolve(new Response('Not Found', { status: 404 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: 'READY',
              liveness: 'ALIVE',
              dependencies: { mongodb: 'AVAILABLE', redis: 'AVAILABLE' },
            }),
            { status: 200 },
          ),
        );
      });

    const service = await repository.findService('iam');

    expect(service).toMatchObject({
      id: 'iam',
      status: 'READY',
      availability: 'AVAILABLE',
      liveness: 'ALIVE',
      readiness: 'READY',
      dependencies: { mongodb: 'AVAILABLE', redis: 'AVAILABLE' },
    });
    expect(fetchSpy.mock.calls.map(([target]) => requestUrl(target))).toEqual([
      'http://127.0.0.1:3001/internal/health/ready',
      'http://127.0.0.1:3001/api/v1/health/ready',
    ]);
  });

  it('probes monolith /api/v1/health/ready once across all hosted services in monolith runtime mode', async () => {
    const repository = new HttpPlatformServiceOperationsRepository({
      get: (key: string) => {
        if (key === 'CONTINUUM_RUNTIME_MODE') return 'monolith';
        if (key === 'IAM_SERVICE_URL') return 'http://127.0.0.1:3001';
        return undefined;
      },
    } as unknown as ConfigService);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'READY',
          liveness: 'ALIVE',
          dependencies: { mongodb: 'AVAILABLE', redis: 'AVAILABLE' },
        }),
        { status: 200 },
      ),
    );

    const result = await repository.listServices();

    expect(result.data).toHaveLength(8);
    expect(result.data.every((svc) => svc.status === 'READY')).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetchSpy.mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:3001/api/v1/health/ready',
    );
  });
});
