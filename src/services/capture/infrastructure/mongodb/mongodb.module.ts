import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { resolveServiceDatabaseName } from '../../../../common/mongodb/service-database';
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
    const serviceDatabaseName = resolveServiceDatabaseName(
      definition,
      process.env.SERVICE_DATABASE,
    );

    const models = [
      ...definition.collections.map((collection) => ({
        name: `${definition.databaseName}_${collection.name}`,
        schema: createCollectionSchema(collection),
      })),
      {
        name: `${definition.databaseName}_${OUTBOX_COLLECTION}`,
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
          connectionName: definition.databaseName,
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            uri: config.getOrThrow<string>('MONGODB_URI'),
            dbName: serviceDatabaseName,
            autoIndex: config.get<boolean>('MONGODB_AUTO_INDEX') ?? false,
            serverSelectionTimeoutMS: 5000,
          }),
        }),
        MongooseModule.forFeature(models, definition.databaseName),
      ],
    };
  }
}
