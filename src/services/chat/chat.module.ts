import { ChatFeaturesService } from './application/chat-features.service';
import { ChatFeaturesController } from './controllers/chat-features.controller';
import { ChatTrafficGuard } from './controllers/chat-traffic.guard';
import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { AI_ENGINE_CLIENT } from '../../integrations/ai-engine/ai-engine.port';
import { HttpAiEngineClient } from '../../integrations/ai-engine/http-ai-engine.client';
import { ChatApplicationService } from './application/chat.service';
import { ChatController } from './controllers/chat.controller';
import { ChatHealthController } from './controllers/chat-health.controller';
import { ChatRealtimeGateway } from './controllers/chat-realtime.gateway';
import { ChatInfrastructureModule } from './infrastructure/chat.infrastructure.module';
import { ChatIamClient } from './application/chat-iam.client';
import { ChatHistoryCacheInvalidator } from './application/chat-history-cache';
import { ChatRealtimeService } from './application/chat-realtime.service';
import { CHAT_ORG_MEMBERSHIP_CHECKER } from './application/chat-dm-assistant.types';
import { DmAssistantRetrievalService } from './application/chat-dm-assistant-retrieval.service';
import { ChatDmAssistantWorkerService } from './application/chat-dm-assistant.worker';
import { MongoChatOrgMembershipChecker } from './infrastructure/mongodb/mongo-chat-org-membership.checker';
import { NotificationCenterRepository } from '../notification/infrastructure/mongodb/notification-center.repository';
import {
  NOTIFICATION_REALTIME_PUBLISHER,
  NotificationRealtimeBus,
} from '../notification/notification-realtime.bus';
import { NotificationService } from '../notification/notification.service';
import { RedisService } from './infrastructure/redis/redis.service';

@Module({
  imports: [RuntimeConfigModule, ChatInfrastructureModule.register()],
  controllers: [ChatController, ChatFeaturesController, ChatHealthController],
  providers: [
    ChatApplicationService,
    ChatFeaturesService,
    ChatTrafficGuard,
    ChatIamClient,
    ChatHistoryCacheInvalidator,
    ChatRealtimeService,
    ChatRealtimeGateway,
    { provide: AI_ENGINE_CLIENT, useClass: HttpAiEngineClient },
    {
      provide: CHAT_ORG_MEMBERSHIP_CHECKER,
      useClass: MongoChatOrgMembershipChecker,
    },
    DmAssistantRetrievalService,
    ChatDmAssistantWorkerService,
    NotificationCenterRepository,
    { provide: NOTIFICATION_REALTIME_PUBLISHER, useExisting: RedisService },
    NotificationRealtimeBus,
    NotificationService,
  ],
  exports: [
    ChatApplicationService,
    ChatFeaturesService,
    ChatDmAssistantWorkerService,
  ],
})
export class ChatModule {}
