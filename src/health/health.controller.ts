import { Controller, Get, Optional, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MessagePattern } from '@nestjs/microservices';
import type { Response } from 'express';
import mongoose, { type Connection } from 'mongoose';
import { BACKEND_PATTERNS } from '../contracts/internal/backend.contract';
import { getSharedHttpRedisConnection } from '../common/redis/redis-connection';
import { IAM_PERSISTENCE } from '../services/iam/infrastructure/persistence';
import {
  createReadinessSnapshot,
  type ServiceReadinessSnapshot,
} from '../services/service-readiness';
import { HealthResponse } from './health.response';

const READINESS_PROBE_TIMEOUT_MS = 2_000;

async function probeWithTimeout(
  probe: () => Promise<unknown>,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      probe().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), READINESS_PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    @Optional() private readonly config?: ConfigService,
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly iamConnection?: Connection,
  ) {}

  @Get()
  @MessagePattern(BACKEND_PATTERNS.health)
  @ApiOperation({ summary: 'Check whether backend-core is running' })
  @ApiOkResponse({ type: HealthResponse })
  getHealth(): HealthResponse {
    return { status: 'ok' };
  }

  /**
   * OBS-005: Monolith readiness probe checking MongoDB connectivity and pooled Redis ping.
   */
  @Get('ready')
  @ApiOperation({
    summary:
      'Check whether backend-core dependencies (MongoDB, Redis) are ready',
  })
  async getReadiness(
    @Res({ passthrough: true }) response: Response,
  ): Promise<ServiceReadinessSnapshot> {
    let mongodbAvailable = false;
    let redisAvailable = false;

    const infraEnabled =
      this.config?.get<boolean>('INFRA_ENABLED') === true ||
      process.env.INFRA_ENABLED === 'true';

    if (infraEnabled) {
      mongodbAvailable = await probeWithTimeout(async () => {
        if (
          !this.iamConnection ||
          this.iamConnection.readyState !==
            mongoose.ConnectionStates.connected ||
          !this.iamConnection.db
        ) {
          throw new Error('MongoDB connection is not ready');
        }
        return this.iamConnection.db.admin().command({ ping: 1 });
      });

      redisAvailable = await probeWithTimeout(async () => {
        if (!this.config) {
          throw new Error('ConfigService unavailable');
        }
        const redis = getSharedHttpRedisConnection(this.config);
        if (redis.status === 'wait') {
          await redis.connect();
        }
        return redis.ping();
      });
    }

    const snapshot = createReadinessSnapshot(mongodbAvailable, redisAvailable);
    response.status(snapshot.status === 'READY' ? 200 : 503);
    return snapshot;
  }
}
