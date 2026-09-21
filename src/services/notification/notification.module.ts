import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { NotificationApplicationService } from './application/notification.service';
import { NotificationController } from './controllers/notification.controller';
import { NotificationInfrastructureModule } from './infrastructure/notification.infrastructure.module';

@Module({
  imports: [RuntimeConfigModule, NotificationInfrastructureModule.register()],
  controllers: [NotificationController],
  providers: [NotificationApplicationService],
})
export class NotificationModule {}
