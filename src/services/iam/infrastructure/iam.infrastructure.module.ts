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
import { IAM_PERSISTENCE, IAM_QUEUES } from './persistence';
import { DEFAULT_JOB_OPTIONS } from './queues/queue.policy';

@Module({})
export class IamInfrastructureModule {
  static register(): DynamicModule {
    const enabled = process.env.INFRA_ENABLED === 'true';
    const sharedMongoEnabled = process.env.MONGODB_ENABLED === 'true';
    const providers = [
      RedisService,
      IdempotencyService,
      R2Storage,
      ...(enabled && !sharedMongoEnabled ? [AuditService, OutboxService] : []),
    ];
    const imports: DynamicModule['imports'] = [];

    if (sharedMongoEnabled || enabled) {
      imports.push(MongoInfrastructureModule.register(IAM_PERSISTENCE));
    }

    if (enabled) {
      imports.push(
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            connection: createRedisConnection(config),
            prefix: bullmqPrefix(config),
          }),
        }),
        BullModule.registerQueue(
          ...IAM_QUEUES.map((name) => ({
            name,
            defaultJobOptions: DEFAULT_JOB_OPTIONS,
          })),
        ),
      );
    }

    return {
      module: IamInfrastructureModule,
      imports,
      providers,
      exports: providers,
    };
  }
}
