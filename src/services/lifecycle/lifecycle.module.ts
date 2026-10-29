import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { LifecycleApplicationService } from './application/lifecycle.service';
import { HandoverLifecycleSourceService } from './application/handover-lifecycle-source.service';
import { LifecycleController } from './controllers/lifecycle.controller';
import { LifecycleInfrastructureModule } from './infrastructure/lifecycle.infrastructure.module';

@Module({
  imports: [RuntimeConfigModule, LifecycleInfrastructureModule.register()],
  controllers: [LifecycleController],
  providers: [LifecycleApplicationService, HandoverLifecycleSourceService],
  exports: [HandoverLifecycleSourceService],
})
export class LifecycleModule {}
