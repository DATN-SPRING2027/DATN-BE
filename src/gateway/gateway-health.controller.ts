import {
  Controller,
  GatewayTimeoutException,
  Get,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthResponse } from '../health/health.response';
import type { ServiceReadinessSnapshot } from '../services/service-readiness';

@ApiTags('Health')
@Controller('health')
export class GatewayHealthController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  @ApiOperation({ summary: 'Check whether the backend service is reachable' })
  @ApiOkResponse({ type: HealthResponse })
  async getHealth(): Promise<HealthResponse> {
    return this.requestServiceHealth();
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Check IAM service and its configured dependencies are ready',
    description:
      'Forwards the IAM readiness projection. This endpoint does not label IAM liveness as platform readiness.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['status', 'liveness', 'dependencies', 'checkedAt'],
      properties: {
        status: { type: 'string', enum: ['READY', 'DEGRADED', 'UNAVAILABLE'] },
        liveness: { type: 'string', enum: ['ALIVE'] },
        dependencies: {
          type: 'object',
          required: ['mongodb', 'redis'],
          properties: {
            mongodb: { type: 'string', enum: ['AVAILABLE', 'UNAVAILABLE'] },
            redis: { type: 'string', enum: ['AVAILABLE', 'UNAVAILABLE'] },
          },
        },
        checkedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  async getReadiness(
    @Res({ passthrough: true }) response: Response,
  ): Promise<ServiceReadinessSnapshot> {
    const result = await this.requestServiceReadiness();
    response.status(result.status === 'READY' ? 200 : 503);
    return result;
  }

  private async requestServiceHealth(): Promise<HealthResponse> {
    const url = `${this.config
      .getOrThrow<string>('IAM_SERVICE_URL')
      .replace(/\/$/, '')}/internal/health`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(
        this.config.getOrThrow<number>('BACKEND_TIMEOUT_MS'),
      ),
    });

    if (!response.ok) {
      throw new Error(`IAM service returned HTTP ${response.status}`);
    }

    return (await response.json()) as HealthResponse;
  }

  private async requestServiceReadiness(): Promise<ServiceReadinessSnapshot> {
    const url = `${this.config
      .getOrThrow<string>('IAM_SERVICE_URL')
      .replace(/\/$/, '')}/internal/health/ready`;
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(url, {
        signal: AbortSignal.timeout(
          this.config.getOrThrow<number>('BACKEND_TIMEOUT_MS'),
        ),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new GatewayTimeoutException('IAM readiness check timed out');
      }
      throw new ServiceUnavailableException('IAM readiness unavailable');
    }

    let payload: unknown;
    try {
      payload = await upstream.json();
    } catch {
      throw new ServiceUnavailableException('IAM readiness unavailable');
    }
    const snapshot = parseServiceReadinessSnapshot(payload);
    if (!snapshot) {
      throw new ServiceUnavailableException('IAM readiness unavailable');
    }
    if (!upstream.ok && snapshot.status === 'READY') {
      throw new ServiceUnavailableException('IAM readiness unavailable');
    }
    return snapshot;
  }
}

function parseServiceReadinessSnapshot(
  value: unknown,
): ServiceReadinessSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const snapshot = value as Record<string, unknown>;
  const dependencies = snapshot.dependencies;
  if (
    !['READY', 'DEGRADED', 'UNAVAILABLE'].includes(String(snapshot.status)) ||
    snapshot.liveness !== 'ALIVE' ||
    typeof dependencies !== 'object' ||
    dependencies === null ||
    Array.isArray(dependencies) ||
    !['AVAILABLE', 'UNAVAILABLE'].includes(
      String((dependencies as Record<string, unknown>).mongodb),
    ) ||
    !['AVAILABLE', 'UNAVAILABLE'].includes(
      String((dependencies as Record<string, unknown>).redis),
    ) ||
    typeof snapshot.checkedAt !== 'string' ||
    !Number.isFinite(Date.parse(snapshot.checkedAt))
  ) {
    return null;
  }
  const safeDependencies = dependencies as Record<string, unknown>;
  return {
    status: snapshot.status as ServiceReadinessSnapshot['status'],
    liveness: 'ALIVE',
    dependencies: {
      mongodb: safeDependencies.mongodb as 'AVAILABLE' | 'UNAVAILABLE',
      redis: safeDependencies.redis as 'AVAILABLE' | 'UNAVAILABLE',
    },
    checkedAt: snapshot.checkedAt,
  };
}
