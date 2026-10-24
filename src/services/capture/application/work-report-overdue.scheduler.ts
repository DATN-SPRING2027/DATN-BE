import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { WorkNotesService } from './work-notes.service';

@Injectable()
export class WorkReportOverdueScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WorkReportOverdueScheduler.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly workNotes: WorkNotesService) {}

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
    try {
      await this.workNotes.sweepOverdueReports();
    } catch (error) {
      this.logger.error(
        'Unable to update overdue Work Reports.',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
