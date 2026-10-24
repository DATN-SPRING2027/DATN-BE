import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { WorkNotesService } from './work-notes.service';
import { ProjectReportRosterService } from '../../iam/application/projects/project-report-roster.service';

@Injectable()
export class WorkReportOverdueScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WorkReportOverdueScheduler.name);
  private timer?: NodeJS.Timeout;
  private isSweeping = false;

  constructor(
    private readonly workNotes: WorkNotesService,
    private readonly roster: ProjectReportRosterService,
  ) {}

  onModuleInit(): void {
    if (process.env.INFRA_ENABLED !== 'true') return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, 60_000);
    this.timer.unref();
    void this.sweep();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async sweep(): Promise<void> {
    if (this.isSweeping) return;
    this.isSweeping = true;
    try {
      try {
        for await (const project of this.roster.activeProjects()) {
          if (project.members.length > 0)
            await this.workNotes.ensureScheduledReportObligations(project);
        }
      } catch (error) {
        this.logger.error(
          'Unable to create scheduled Work Report obligations.',
          error instanceof Error ? error.stack : undefined,
        );
      }
      try {
        await this.workNotes.sweepOverdueReports();
      } catch (error) {
        this.logger.error(
          'Unable to update overdue Work Reports.',
          error instanceof Error ? error.stack : undefined,
        );
      }
    } finally {
      this.isSweeping = false;
    }
  }
}
