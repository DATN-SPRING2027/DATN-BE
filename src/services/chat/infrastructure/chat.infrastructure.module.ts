import { DynamicModule, Module } from '@nestjs/common';
import { createBullMqTelemetry } from '../../../common/observability/bullmq-telemetry';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
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
import { S3Storage } from './storage/s3.storage';
import { CHAT_PERSISTENCE, CHAT_QUEUES } from './persistence';
import { DEFAULT_JOB_OPTIONS } from './queues/queue.policy';
import { CHAT_REPOSITORY } from '../application/chat.repository';
import { MongoChatRepository } from './mongodb/mongo-chat.repository';
import { UnavailableChatRepository } from './mongodb/unavailable-chat.repository';
import { getOwnedServiceDatabaseName } from '../../../common/mongodb/service-database';
import { cachedChatRepository } from './redis/chat-cache.repository';

@Module({})
export class ChatInfrastructureModule {
  static register(): DynamicModule {
    const enabled = process.env.INFRA_ENABLED === 'true';
    const providers = [
      RedisService,
      IdempotencyService,
      R2Storage,
      S3Storage,
      UnavailableChatRepository,
      ...(enabled
        ? [
            {
              provide: CHAT_REPOSITORY,
              useFactory: (
                connection: Connection,
                redis: RedisService,
                config: ConfigService,
              ) =>
                cachedChatRepository(
                  new MongoChatRepository(connection),
                  redis,
                  config.get<string>('BULLMQ_PREFIX') ?? 'continuum',
                ),
              inject: [
                getConnectionToken(
                  getOwnedServiceDatabaseName(CHAT_PERSISTENCE),
                ),
                RedisService,
                ConfigService,
              ],
            },
          ]
        : [
            {
              provide: CHAT_REPOSITORY,
              useExisting: UnavailableChatRepository,
            },
          ]),
      ...(enabled ? [AuditService, OutboxService] : []),
    ];
    const imports: DynamicModule['imports'] = [];

    if (enabled) {
      imports.push(
        MongoInfrastructureModule.register(CHAT_PERSISTENCE),
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            connection: createRedisConnection(config),
            prefix: bullmqPrefix(config),
            telemetry: createBullMqTelemetry(),
          }),
        }),
        BullModule.registerQueue(
          ...CHAT_QUEUES.map((name) => ({
            name,
            defaultJobOptions: DEFAULT_JOB_OPTIONS,
          })),
        ),
      );
    }

    return {
      module: ChatInfrastructureModule,
      imports,
      providers,
      exports: providers,
    };
  }
}
