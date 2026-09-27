import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import {
  auditSchema,
  createCollectionSchema,
  OUTBOX_COLLECTION,
  outboxSchema,
} from './mongodb.schemas';
import type { ServicePersistenceDefinition } from './mongodb.types';

@Module({})
export class MongoInfrastructureModule {
  static register(definition: ServicePersistenceDefinition): DynamicModule {
    const sharedMongoEnabled = process.env.MONGODB_ENABLED === 'true';
    const infrastructureEnabled = process.env.INFRA_ENABLED === 'true';

    if (!sharedMongoEnabled && !infrastructureEnabled) {
      return { module: MongoInfrastructureModule };
    }

    const collectionModels = definition.collections.map((collection) => ({
      name: `${definition.databaseName}_${collection.name}`,
      schema: createCollectionSchema(collection),
    }));

    if (sharedMongoEnabled) {
      return {
        module: MongoInfrastructureModule,
        imports: [MongooseModule.forFeature(collectionModels)],
      };
    }

    const models = [
      ...collectionModels,
      {
        name: `${definition.databaseName}_${OUTBOX_COLLECTION}`,
        schema: outboxSchema,
      },
    ];

    return {
      module: MongoInfrastructureModule,
      imports: [
        ConfigModule,
        MongooseModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            uri: config.getOrThrow<string>('MONGODB_URI'),
            dbName: definition.databaseName,
            autoIndex: config.get<boolean>('MONGODB_AUTO_INDEX') ?? false,
            serverSelectionTimeoutMS: 5000,
          }),
        }),
        MongooseModule.forRootAsync({
          imports: [ConfigModule],
          connectionName: 'audit',
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            uri: config.getOrThrow<string>('MONGODB_URI'),
            dbName: config.get<string>('AUDIT_DATABASE') ?? 'continuum_audit',
            autoIndex: config.get<boolean>('MONGODB_AUTO_INDEX') ?? false,
            serverSelectionTimeoutMS: 5000,
          }),
        }),
        MongooseModule.forFeature(models),
        MongooseModule.forFeature(
          [{ name: 'audit_logs', schema: auditSchema }],
          'audit',
        ),
      ],
    };
  }
}
