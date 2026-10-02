import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AUDIT_CONNECTION_NAME, AUDIT_DATABASE_NAME } from './database-names';

@Global()
@Module({
  imports: [
    ConfigModule,
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      connectionName: AUDIT_CONNECTION_NAME,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGODB_URI'),
        dbName: AUDIT_DATABASE_NAME,
        autoIndex: config.get<boolean>('MONGODB_AUTO_INDEX') ?? false,
        serverSelectionTimeoutMS: 5000,
      }),
    }),
  ],
  exports: [MongooseModule],
})
export class MongoAuditModule {}
