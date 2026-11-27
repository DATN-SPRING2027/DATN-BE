import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { getOwnedServiceDatabaseName } from '../../../../common/mongodb/service-database';
import { MongoAuditModule } from '../../../../common/mongodb/mongo-audit.module';
import {
  createCollectionSchema,
  OUTBOX_COLLECTION,
  outboxSchema,
} from './mongodb.schemas';
import type { ServicePersistenceDefinition } from './mongodb.types';

@Module({})
export class MongoInfrastructureModule {
  static register(definition: ServicePersistenceDefinition): DynamicModule {
    if (process.env.INFRA_ENABLED !== 'true') {
      return { module: MongoInfrastructureModule };
    }
    const serviceDatabaseName = getOwnedServiceDatabaseName(definition);

    const models = [
      ...definition.collections.map((collection) => ({
        name: `${serviceDatabaseName}_${collection.name}`,
        schema: createCollectionSchema(collection),
      })),
      {
        name: `${serviceDatabaseName}_${OUTBOX_COLLECTION}`,
        schema: outboxSchema,
      },
    ];

    return {
      module: MongoInfrastructureModule,
      imports: [
        MongoAuditModule,
        ConfigModule,
        MongooseModule.forRootAsync({
          imports: [ConfigModule],
          connectionName: serviceDatabaseName,
          inject: [ConfigService],
          useFactory: (config: ConfigService) => {
            const rawPoolSize = Number(config.get('MONGODB_MAX_POOL_SIZE'));
            return {
              uri: config.getOrThrow<string>('MONGODB_URI'),
              dbName: serviceDatabaseName,
              autoIndex: config.get<boolean>('MONGODB_AUTO_INDEX') ?? false,
              serverSelectionTimeoutMS: 5000,
              maxPoolSize:
                Number.isFinite(rawPoolSize) && rawPoolSize > 0
                  ? Math.trunc(rawPoolSize)
                  : 15,
            };
          },
        }),
        MongooseModule.forFeature(models, serviceDatabaseName),
      ],
    };
  }
}
