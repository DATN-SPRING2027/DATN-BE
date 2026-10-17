import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GatewayHealthController } from './gateway-health.controller';

describe('GatewayHealthController', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('routes health through the internal service HTTP endpoint', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ status: 'ok' })));
    const module = await Test.createTestingModule({
      controllers: [GatewayHealthController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) =>
              key === 'IAM_SERVICE_URL' ? 'http://iam:3001' : 1000,
          },
        },
      ],
    }).compile();

    const controller = module.get(GatewayHealthController);
    await expect(controller.getHealth()).resolves.toEqual({ status: 'ok' });
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] ?? [];
    expect(calledUrl).toBe('http://iam:3001/internal/health');
    expect(calledInit?.signal).toBeInstanceOf(AbortSignal);
    fetchMock.mockRestore();
  });

  it('uses readiness rather than liveness and preserves the degraded status', async () => {
    const snapshot = {
      status: 'DEGRADED',
      liveness: 'ALIVE',
      dependencies: { mongodb: 'AVAILABLE', redis: 'UNAVAILABLE' },
      checkedAt: '2026-10-17T00:00:00.000Z',
    };
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(snapshot), { status: 503 }),
      );
    const module = await Test.createTestingModule({
      controllers: [GatewayHealthController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) =>
              key === 'IAM_SERVICE_URL' ? 'http://iam:3001' : 1000,
          },
        },
      ],
    }).compile();
    const response = { status: jest.fn() };

    await expect(
      module.get(GatewayHealthController).getReadiness(response as never),
    ).resolves.toEqual(snapshot);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://iam:3001/internal/health/ready',
    );
  });
});
