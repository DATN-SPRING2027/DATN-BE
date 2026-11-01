import { WorkReportReminderService } from './work-report-reminder.service';
import {
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { WorkNotesService } from './work-notes.service';
import {
  ProjectReportRosterService,
  type ReportingProjectMembers,
} from '../../iam/application/projects/project-report-roster.service';

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
    @Optional() private readonly reminders?: WorkReportReminderService,
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
      const activeRosters: ReportingProjectMembers[] = [];
      let rosterAvailable = true;
      try {
        for await (const project of this.roster.activeProjects()) {
          activeRosters.push(project);
          if (
            project.members.length > 0 ||
            (project.leaders?.length ?? 0) > 0
          ) {
            try {
              await this.workNotes.ensureScheduledReportObligations(project);
            } catch (error) {
              this.logger.error(
                'Unable to create scheduled Work Report obligations.',
                error instanceof Error ? error.stack : undefined,
              );
            }
          }
        }
      } catch (error) {
        rosterAvailable = false;
        this.logger.error(
          'Unable to load active project rosters for Work Reports.',
          error instanceof Error ? error.stack : undefined,
        );
      }
      if (!rosterAvailable) return;
      await this.reminders?.sweep(activeRosters);
      try {
        await this.workNotes.sweepOverdueReports(activeRosters);
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
