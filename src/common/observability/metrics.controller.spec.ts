import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { MetricsController } from './metrics.controller';
import type { MetricsService } from './metrics.service';

describe('MetricsController (OBS-002 / SEC-BE-006)', () => {
  const render = jest.fn(() =>
    Promise.resolve('# TYPE http_requests counter\n'),
  );
  const metrics = { render } as unknown as MetricsService;

  beforeEach(() => {
    render.mockClear();
  });

  it('fails closed with 401 when METRICS_AUTH_TOKEN is unset even on localhost in development', () => {
    const config = new ConfigService({
      NODE_ENV: 'development',
      METRICS_AUTH_TOKEN: '',
    });
    const controller = new MetricsController(metrics, config);
    const req = {
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;

    expect(() => controller.getMetrics(undefined, undefined, req)).toThrow(
      UnauthorizedException,
    );
    expect(render).not.toHaveBeenCalled();
  });

  it('fails closed with 403 in production when METRICS_AUTH_TOKEN is unset even if loopback opt-in is set', () => {
    const config = new ConfigService({
      NODE_ENV: 'production',
      METRICS_AUTH_TOKEN: '',
      METRICS_ALLOW_UNAUTHENTICATED_LOOPBACK: 'true',
    });
    const controller = new MetricsController(metrics, config);
    const req = {
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;

    expect(() => controller.getMetrics(undefined, undefined, req)).toThrow(
      ForbiddenException,
    );
    expect(render).not.toHaveBeenCalled();
  });

  it('rejects wrong token and accepts valid Bearer or X-Metrics-Token credentials', async () => {
    const config = new ConfigService({
      NODE_ENV: 'production',
      METRICS_AUTH_TOKEN: 'super-secret-metrics-token-123456',
    });
    const controller = new MetricsController(metrics, config);

    expect(() =>
      controller.getMetrics('Bearer wrong-token', undefined, undefined),
    ).toThrow(UnauthorizedException);

    await expect(
      controller.getMetrics(
        'Bearer super-secret-metrics-token-123456',
        undefined,
        undefined,
      ),
    ).resolves.toContain('http_requests');

    await expect(
      controller.getMetrics(
        undefined,
        'super-secret-metrics-token-123456',
        undefined,
      ),
    ).resolves.toContain('http_requests');
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('allows explicit dev loopback opt-in only from loopback addresses', async () => {
    const config = new ConfigService({
      NODE_ENV: 'development',
      METRICS_AUTH_TOKEN: '',
      METRICS_ALLOW_UNAUTHENTICATED_LOOPBACK: 'true',
    });
    const controller = new MetricsController(metrics, config);

    expect(() =>
      controller.getMetrics(undefined, undefined, {
        socket: { remoteAddress: '10.0.0.42' },
      } as unknown as Request),
    ).toThrow(ForbiddenException);

    await expect(
      controller.getMetrics(undefined, undefined, {
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as Request),
    ).resolves.toContain('http_requests');
  });
});
