import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import {
  workItemCommentSchema,
  workItemEventSchema,
  workItemSchema,
} from './work-management.schemas';

export const WORK_MANAGEMENT_CONNECTION = 'continuum-work';

@Module({})
export class WorkManagementMongoModule {
  static register(): DynamicModule {
    if (process.env.INFRA_ENABLED !== 'true') {
      return { module: WorkManagementMongoModule };
    }

    return {
      module: WorkManagementMongoModule,
      imports: [
        ConfigModule,
        MongooseModule.forRootAsync({
          imports: [ConfigModule],
          connectionName: WORK_MANAGEMENT_CONNECTION,
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            uri: config.getOrThrow<string>('MONGODB_URI'),
            dbName: 'continuum_work',
            autoIndex: config.get<boolean>('MONGODB_AUTO_INDEX') ?? false,
            serverSelectionTimeoutMS: 5000,
          }),
        }),
        MongooseModule.forFeature(
          [
            { name: 'work_items', schema: workItemSchema },
            { name: 'work_item_comments', schema: workItemCommentSchema },
            { name: 'work_item_events', schema: workItemEventSchema },
          ],
          WORK_MANAGEMENT_CONNECTION,
        ),
      ],
      exports: [MongooseModule],
    };
  }
}
