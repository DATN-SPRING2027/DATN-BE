import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  Optional,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { MetricsService } from './metrics.service';

function safeTokenEquals(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1'
  );
}

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  getMetrics(
    @Headers('authorization') authorization?: string,
    @Headers('x-metrics-token') metricsTokenHeader?: string,
    @Req() request?: Request,
  ): Promise<string> {
    const configuredToken = (
      this.config?.get<string>('METRICS_AUTH_TOKEN') ??
      process.env.METRICS_AUTH_TOKEN ??
      ''
    ).trim();

    if (configuredToken.length > 0) {
      const bearerMatch =
        typeof authorization === 'string'
          ? /^Bearer\s+(\S+)$/i.exec(authorization.trim())
          : null;
      const provided =
        (typeof metricsTokenHeader === 'string'
          ? metricsTokenHeader.trim()
          : '') ||
        bearerMatch?.[1] ||
        '';
      if (!provided || !safeTokenEquals(configuredToken, provided)) {
        throw new UnauthorizedException({
          code: 'METRICS_UNAUTHORIZED',
          message: 'Valid internal metrics credentials are required.',
        });
      }
      return this.metrics.render();
    }

    const nodeEnv =
      this.config?.get<string>('NODE_ENV') ?? process.env.NODE_ENV;
    const allowUnauthLoopback =
      (
        this.config?.get<string>('METRICS_ALLOW_UNAUTHENTICATED_LOOPBACK') ??
        process.env.METRICS_ALLOW_UNAUTHENTICATED_LOOPBACK ??
        ''
      )
        .trim()
        .toLowerCase() === 'true';

    if (nodeEnv === 'production') {
      throw new ForbiddenException({
        code: 'METRICS_PROTECTED',
        message: 'Metrics endpoint requires METRICS_AUTH_TOKEN in production.',
      });
    }

    if (!allowUnauthLoopback) {
      throw new UnauthorizedException({
        code: 'METRICS_UNAUTHORIZED',
        message: 'Valid internal metrics credentials are required.',
      });
    }

    const remoteAddress = request?.socket?.remoteAddress ?? request?.ip;
    if (!isLoopbackAddress(remoteAddress)) {
      throw new ForbiddenException({
        code: 'METRICS_LOOPBACK_ONLY',
        message: 'Metrics endpoint is restricted to internal loopback.',
      });
    }
    return this.metrics.render();
  }
}
