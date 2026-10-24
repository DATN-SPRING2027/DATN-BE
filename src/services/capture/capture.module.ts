import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { CaptureApplicationService } from './application/capture.service';
import { CaptureController } from './controllers/capture.controller';
import { WorkNotesController } from './controllers/work-notes.controller';
import { CaptureInfrastructureModule } from './infrastructure/capture.infrastructure.module';
import { WorkNotesAuthorizationService } from './application/work-notes-authorization.service';
import { WorkNotesService } from './application/work-notes.service';
import { WorkReportOverdueScheduler } from './application/work-report-overdue.scheduler';

@Module({
  imports: [RuntimeConfigModule, CaptureInfrastructureModule.register()],
  controllers: [CaptureController, WorkNotesController],
  providers: [
    CaptureApplicationService,
    WorkNotesAuthorizationService,
    WorkNotesService,
    WorkReportOverdueScheduler,
  ],
})
export class CaptureModule {}
