import { DynamicModule, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  bullmqPrefix,
  createRedisConnection,
} from '../../../common/redis/redis-connection';
import { AuditService } from './audit/audit.service';
import { MongoInfrastructureModule } from './mongodb/mongodb.module';
import { OutboxService } from './outbox/outbox.service';
import { IdempotencyService } from './redis/idempotency.service';
import { RedisService } from './redis/redis.service';
import { R2Storage } from './storage/r2.storage';
import { CAPTURE_PERSISTENCE, CAPTURE_QUEUES } from './persistence';
import { DEFAULT_JOB_OPTIONS } from './queues/queue.policy';
import { QueueRuntime } from './queues/queue-runtime';

@Module({})
export class CaptureInfrastructureModule {
  static register(): DynamicModule {
    const enabled = process.env.INFRA_ENABLED === 'true';
    const providers = [
      RedisService,
      IdempotencyService,
      R2Storage,
      ...(enabled ? [AuditService, OutboxService] : []),
      ...(enabled
        ? [
            {
              provide: QueueRuntime,
              inject: [ConfigService],
              useFactory: (config: ConfigService) =>
                new QueueRuntime(config, CAPTURE_QUEUES),
            },
          ]
        : []),
    ];
    const imports: DynamicModule['imports'] = [];

    if (enabled) {
      imports.push(
        MongoInfrastructureModule.register(CAPTURE_PERSISTENCE),
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            connection: createRedisConnection(config),
            prefix: bullmqPrefix(config),
          }),
        }),
        BullModule.registerQueue(
          ...CAPTURE_QUEUES.map((name) => ({
            name,
            defaultJobOptions: DEFAULT_JOB_OPTIONS,
          })),
        ),
      );
    }

    return {
      module: CaptureInfrastructureModule,
      imports,
      providers,
      exports: providers,
    };
  }
}
