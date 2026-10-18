import 'dotenv/config';
import { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Transport } from '@nestjs/microservices';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Express, Request, Response } from 'express';
import mongoose, { type Connection } from 'mongoose';
import { createRedisConnection } from '../common/redis/redis-connection';
import {
  resolveServiceDatabaseName,
  type ServiceDatabaseOwner,
} from '../common/mongodb/service-database';
import { createReadinessSnapshot } from './service-readiness';

const dependencyProbeTimeoutMs = 2_000;

function isRedisWaiting(status: string): boolean {
  return status === 'wait';
}

async function probeWithinTimeout(
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
        timeout = setTimeout(() => resolve(false), dependencyProbeTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function assertStandaloneServiceDatabase(
  infraEnabled: string | undefined,
  serviceDatabase: ServiceDatabaseOwner,
  configuredDatabaseName: string | undefined,
): void {
  if (infraEnabled === 'true') {
    resolveServiceDatabaseName(serviceDatabase, configuredDatabaseName);
  }
}

export async function bootstrapService(
  serviceModule: Type<unknown>,
  serviceDatabase: ServiceDatabaseOwner,
): Promise<void> {
  assertStandaloneServiceDatabase(
    process.env.INFRA_ENABLED,
    serviceDatabase,
    process.env.SERVICE_DATABASE,
  );

  const app = await NestFactory.create(serviceModule);
  const config = app.get(ConfigService);
  app.setGlobalPrefix('internal');
  const databaseName =
    process.env.INFRA_ENABLED === 'true'
      ? resolveServiceDatabaseName(
          serviceDatabase,
          process.env.SERVICE_DATABASE,
        )
      : serviceDatabase.databaseName;
  const expressApplication = app.getHttpAdapter().getInstance() as Express;
  expressApplication.get(
    '/internal/health/ready',
    async (_request: Request, response: Response) => {
      let mongodbAvailable = false;
      let redisAvailable = false;
      if (process.env.INFRA_ENABLED === 'true') {
        mongodbAvailable = await probeWithinTimeout(async () => {
          const connection = app.get<Connection>(
            getConnectionToken(databaseName),
            { strict: false },
          );
          if (
            connection.readyState !== mongoose.ConnectionStates.connected ||
            !connection.db
          ) {
            throw new Error('Database connection is not ready');
          }
          return connection.db.admin().command({ ping: 1 });
        });

        redisAvailable = await probeWithinTimeout(async () => {
          const redis = createRedisConnection(config);
          try {
            if (isRedisWaiting(redis.status)) await redis.connect();
            return await redis.ping();
          } finally {
            redis.disconnect();
          }
        });
      }

      const snapshot = createReadinessSnapshot(
        mongodbAvailable,
        redisAvailable,
      );
      response.status(snapshot.status === 'READY' ? 200 : 503).json(snapshot);
    },
  );
  app.connectMicroservice({
    transport: Transport.REDIS,
    options: {
      host: config.get<string>('REDIS_HOST') ?? '127.0.0.1',
      port: config.get<number>('REDIS_PORT') ?? 6379,
      password: config.get<string>('REDIS_PASSWORD') || undefined,
    },
  });

  await app.startAllMicroservices();
  await app.listen(config.get<number>('SERVICE_PORT') ?? 3001);
}
