import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { HandoverApplicationService } from './application/handover.service';
import { HandoverController } from './controllers/handover.controller';
import { HandoverInfrastructureModule } from './infrastructure/handover.infrastructure.module';

@Module({
  imports: [RuntimeConfigModule, HandoverInfrastructureModule.register()],
  controllers: [HandoverController],
  providers: [HandoverApplicationService],
})
export class HandoverModule {}
