import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { AiEngineModule } from './integrations/ai-engine/ai-engine.module';
import { CaptureModule } from './modules/capture/capture.module';
import { ChatModule } from './modules/chat/chat.module';
import { HandoverModule } from './modules/handover/handover.module';
import { IamModule } from './modules/iam/iam.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { JiraModule } from './modules/jira/jira.module';
import { LifecycleModule } from './modules/lifecycle/lifecycle.module';
import { NotificationModule } from './modules/notification/notification.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      validate: validateEnvironment,
    }),
    HealthModule,
    IamModule,
    CaptureModule,
    JiraModule,
    LifecycleModule,
    ChatModule,
    HandoverModule,
    IngestionModule,
    NotificationModule,
    AiEngineModule,
  ],
})
export class AppModule {}
