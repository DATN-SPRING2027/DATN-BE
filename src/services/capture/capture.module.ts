import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { CaptureApplicationService } from './application/capture.service';
import { CaptureController } from './controllers/capture.controller';
import { CaptureInfrastructureModule } from './infrastructure/capture.infrastructure.module';

@Module({
  imports: [RuntimeConfigModule, CaptureInfrastructureModule.register()],
  controllers: [CaptureController],
  providers: [CaptureApplicationService],
})
export class CaptureModule {}
