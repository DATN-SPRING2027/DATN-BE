import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { CaptureApplicationService } from './application/capture.service';
import { CaptureController } from './controllers/capture.controller';
import { WorkNotesController } from './controllers/work-notes.controller';
import { CaptureInfrastructureModule } from './infrastructure/capture.infrastructure.module';
import { WorkNotesAuthorizationService } from './application/work-notes-authorization.service';
import { WorkNotesService } from './application/work-notes.service';
import { WorkReportOverdueScheduler } from './application/work-report-overdue.scheduler';
import { ProjectReportRosterService } from '../iam/application/projects/project-report-roster.service';
import { IamInfrastructureModule } from '../iam/infrastructure/iam.infrastructure.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    RuntimeConfigModule,
    IamInfrastructureModule.register(),
    CaptureInfrastructureModule.register(),
    NotificationModule,
  ],
  controllers: [CaptureController, WorkNotesController],
  providers: [
    CaptureApplicationService,
    WorkNotesAuthorizationService,
    WorkNotesService,
    ProjectReportRosterService,
    WorkReportOverdueScheduler,
  ],
  exports: [WorkNotesService],
})
export class CaptureModule {}
