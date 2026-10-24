import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { NotificationApplicationService } from './application/notification.service';
import { NotificationController } from './controllers/notification.controller';
import { NotificationInfrastructureModule } from './infrastructure/notification.infrastructure.module';
import { NotificationCenterRepository } from './infrastructure/mongodb/notification-center.repository';
import { NotificationRealtimeBus } from './notification-realtime.bus';
import { NotificationService } from './notification.service';
import { TaskDeadlineNotificationScheduler } from './task-deadline-notification.scheduler';

@Module({
  imports: [RuntimeConfigModule, NotificationInfrastructureModule.register()],
  controllers: [NotificationController],
  providers: [
    NotificationApplicationService,
    NotificationCenterRepository,
    NotificationRealtimeBus,
    NotificationService,
    TaskDeadlineNotificationScheduler,
  ],
  exports: [
    NotificationCenterRepository,
    NotificationRealtimeBus,
    NotificationService,
    TaskDeadlineNotificationScheduler,
  ],
})
export class NotificationModule {}
