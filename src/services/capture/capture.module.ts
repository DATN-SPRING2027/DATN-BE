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
import { WorkNoteAgentController } from './controllers/work-note-agent.controller';
import { WorkNoteAgentDraftsService } from './application/work-note-agent/work-note-agent-drafts.service';
import { WorkNoteAgentModel } from './infrastructure/ai/work-note-agent.model';
import { WorkNoteEditorService } from './application/work-note-agent/work-note-editor.service';
import { WorkNoteEditorController } from './controllers/work-note-editor.controller';
import { WorkNoteAssessmentController } from './controllers/work-note-assessment.controller';
import { WorkNoteAssessmentService } from './application/work-note-agent/work-note-assessment.service';

@Module({
  imports: [
    RuntimeConfigModule,
    IamInfrastructureModule.register(),
    CaptureInfrastructureModule.register(),
    NotificationModule,
  ],
  controllers: [
    CaptureController,
    WorkNotesController,
    WorkNoteAgentController,
    WorkNoteEditorController,
    WorkNoteAssessmentController,
  ],
  providers: [
    CaptureApplicationService,
    WorkNotesAuthorizationService,
    WorkNotesService,
    WorkNoteAgentDraftsService,
    WorkNoteAgentModel,
    WorkNoteEditorService,
    WorkNoteAssessmentService,
    ProjectReportRosterService,
    WorkReportOverdueScheduler,
  ],
  exports: [WorkNotesService],
})
export class CaptureModule {}
