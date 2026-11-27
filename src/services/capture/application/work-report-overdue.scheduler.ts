import { randomUUID } from 'node:crypto';
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
import { RedisService } from '../infrastructure/redis/redis.service';

const SWEEP_LOCK_KEY = 'capture:work-report-overdue-sweep';
const SWEEP_LOCK_TTL_SECONDS = 55;

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
    @Optional() private readonly redis?: RedisService,
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
    const lockOwner = randomUUID();
    let lockAcquired = false;
    try {
      if (this.redis && typeof this.redis.acquireLock === 'function') {
        try {
          lockAcquired = await this.redis.acquireLock(
            SWEEP_LOCK_KEY,
            lockOwner,
            SWEEP_LOCK_TTL_SECONDS,
          );
          if (!lockAcquired) {
            return;
          }
        } catch (error) {
          this.logger.warn(
            `Unable to acquire distributed scheduler lock; skipping tick to prevent duplicate sweeps: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
          return;
        }
      }
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
      if (
        lockAcquired &&
        this.redis &&
        typeof this.redis.releaseLock === 'function'
      ) {
        await this.redis.releaseLock(SWEEP_LOCK_KEY, lockOwner).catch(() => {
          // TTL expires automatically
        });
      }
      this.isSweeping = false;
    }
  }
}
