import { ChatFeaturesService } from './application/chat-features.service';
import { ChatFeaturesController } from './controllers/chat-features.controller';
import { ChatTrafficGuard } from './controllers/chat-traffic.guard';
import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { ChatApplicationService } from './application/chat.service';
import { ChatController } from './controllers/chat.controller';
import { ChatHealthController } from './controllers/chat-health.controller';
import { ChatRealtimeGateway } from './controllers/chat-realtime.gateway';
import { ChatInfrastructureModule } from './infrastructure/chat.infrastructure.module';
import { ChatIamClient } from './application/chat-iam.client';
import { ChatRealtimeService } from './application/chat-realtime.service';
import { NotificationCenterRepository } from '../notification/infrastructure/mongodb/notification-center.repository';
import { NotificationRealtimeBus } from '../notification/notification-realtime.bus';
import { NotificationService } from '../notification/notification.service';

@Module({
  imports: [RuntimeConfigModule, ChatInfrastructureModule.register()],
  controllers: [ChatController, ChatFeaturesController, ChatHealthController],
  providers: [
    ChatApplicationService,
    ChatFeaturesService,
    ChatTrafficGuard,
    ChatIamClient,
    ChatRealtimeService,
    ChatRealtimeGateway,
    NotificationCenterRepository,
    NotificationRealtimeBus,
    NotificationService,
  ],
})
export class ChatModule {}
