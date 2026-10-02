import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from './config/runtime-config.module';
import { HealthModule } from './health/health.module';
import { AiEngineModule } from './integrations/ai-engine/ai-engine.module';
import { CaptureModule } from './services/capture/capture.module';
import { ChatModule } from './services/chat/chat.module';
import { HandoverModule } from './services/handover/handover.module';
import { IamModule } from './services/iam/iam.module';
import { IngestionModule } from './services/ingestion/ingestion.module';
import { JiraModule } from './services/jira/jira.module';
import { LifecycleModule } from './services/lifecycle/lifecycle.module';
import { NotificationModule } from './services/notification/notification.module';

@Module({
  imports: [
    RuntimeConfigModule,
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
