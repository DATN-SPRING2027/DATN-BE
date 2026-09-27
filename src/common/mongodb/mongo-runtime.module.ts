import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { buildSharedMongoConnectionOptions } from './mongo-connection-options';

@Module({})
export class MongoRuntimeModule {
  static register(
    enabled = process.env.NODE_ENV !== 'test' &&
      process.env.MONGODB_ENABLED === 'true',
  ): DynamicModule {
    if (!enabled) {
      return { module: MongoRuntimeModule };
    }

    return {
      module: MongoRuntimeModule,
      imports: [
        ConfigModule,
        MongooseModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) =>
            buildSharedMongoConnectionOptions({
              uri: config.getOrThrow<string>('MONGODB_URI'),
              databaseName: config.getOrThrow<string>('MONGODB_DATABASE'),
              autoIndex: config.get<boolean>('MONGODB_AUTO_INDEX') ?? false,
            }),
        }),
      ],
    };
  }
}
