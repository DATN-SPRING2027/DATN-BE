import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { NotificationApplicationService } from './application/notification.service';
import { NotificationController } from './controllers/notification.controller';
import { NotificationInfrastructureModule } from './infrastructure/notification.infrastructure.module';
import { NotificationCenterRepository } from './infrastructure/mongodb/notification-center.repository';
import {
  NOTIFICATION_REALTIME_PUBLISHER,
  NotificationRealtimeBus,
} from './notification-realtime.bus';
import { NotificationService } from './notification.service';
import { RedisService } from './infrastructure/redis/redis.service';

@Module({
  imports: [RuntimeConfigModule, NotificationInfrastructureModule.register()],
  controllers: [NotificationController],
  providers: [
    NotificationApplicationService,
    NotificationCenterRepository,
    { provide: NOTIFICATION_REALTIME_PUBLISHER, useExisting: RedisService },
    NotificationRealtimeBus,
    NotificationService,
  ],
  exports: [
    NotificationCenterRepository,
    NotificationRealtimeBus,
    NotificationService,
  ],
})
export class NotificationModule {}
