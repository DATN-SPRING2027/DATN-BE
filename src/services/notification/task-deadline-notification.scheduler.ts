import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  Inject,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../iam/infrastructure/redis/redis.service';
import {
  TASK_WORKSPACE_REPOSITORY,
  TaskWorkspaceRepository,
  type DeadlineNotificationTaskCursor,
} from '../task/workspace/task-workspace.repository';
import { NotificationService } from './notification.service';

export const DEADLINE_APPROACHING_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEADLINE_SCAN_BATCH_SIZE = 200;
const SCHEDULER_INTERVAL_MS = 60 * 1000;
const SCHEDULER_LOCK_TTL_SECONDS = 120;
const SCHEDULER_LOCK_RENEW_MS = 30 * 1000;
const SCHEDULER_LOCK_KEY = `${process.env.BULLMQ_PREFIX ?? 'continuum'}:notification:task-deadline-scan:v1`;

export interface EvaluableTaskRecord {
  id: string;
  organizationId: string;
  projectId: string;
  title: string;
  status: string;
  assigneeId: string | null;
  dueDate: Date | string | null;
  deletedAt?: Date | null;
}

@Injectable()
export class TaskDeadlineNotificationScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TaskDeadlineNotificationScheduler.name);
  private intervalHandle?: NodeJS.Timeout;
  private leaseRenewHandle?: NodeJS.Timeout;
  private scanRunning = false;
  private leaseLost = false;

  constructor(
    private readonly notificationService: NotificationService,
    @Optional()
    @Inject(TASK_WORKSPACE_REPOSITORY)
    private readonly taskRepository?: TaskWorkspaceRepository,
    @Optional()
    private readonly redis?: RedisService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !this.taskRepository) {
      return;
    }
    this.intervalHandle = setInterval(() => {
      void this.runScheduledScan();
    }, SCHEDULER_INTERVAL_MS);
    this.intervalHandle.unref();
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
    if (this.leaseRenewHandle) clearInterval(this.leaseRenewHandle);
  }

  private async runScheduledScan(): Promise<void> {
    if (this.scanRunning || !this.taskRepository) return;
    this.scanRunning = true;
    this.leaseLost = false;
    const owner = randomUUID();
    const distributedRuntime = process.env.INFRA_ENABLED === 'true';
    let lockAcquired = false;

    try {
      if (distributedRuntime) {
        if (!this.redis) return;
        lockAcquired = await this.redis.acquireLock(
          SCHEDULER_LOCK_KEY,
          owner,
          SCHEDULER_LOCK_TTL_SECONDS,
        );
        if (!lockAcquired) return;
        this.leaseRenewHandle = setInterval(() => {
          void this.redis
            ?.extendLock(SCHEDULER_LOCK_KEY, owner, SCHEDULER_LOCK_TTL_SECONDS)
            .then((extended) => {
              if (!extended) this.leaseLost = true;
            })
            .catch(() => {
              this.leaseLost = true;
            });
        }, SCHEDULER_LOCK_RENEW_MS);
        this.leaseRenewHandle.unref();
      }

      await this.evaluateTaskDeadlines({
        shouldContinue: () => !this.leaseLost,
      });
    } catch (err) {
      this.logger.warn(
        `Deadline notification scan error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      if (this.leaseRenewHandle) {
        clearInterval(this.leaseRenewHandle);
        this.leaseRenewHandle = undefined;
      }
      if (lockAcquired) {
        await this.redis
          ?.releaseLock(SCHEDULER_LOCK_KEY, owner)
          .catch((error: unknown) => {
            this.logger.warn(
              `Deadline notification lease release failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      }
      this.scanRunning = false;
    }
  }

  async evaluateSingleTask(
    task: EvaluableTaskRecord,
    now = new Date(),
  ): Promise<void> {
    if (!task.assigneeId || !task.dueDate) return;
    if (task.deletedAt) return;
    const terminalStatuses = new Set(['DONE', 'CANCELLED']);
    if (terminalStatuses.has(task.status.toUpperCase())) return;

    const dueDate =
      task.dueDate instanceof Date ? task.dueDate : new Date(task.dueDate);
    if (Number.isNaN(dueDate.getTime())) return;

    const dueTime = dueDate.getTime();
    const nowTime = now.getTime();
    const dueDateIso = dueDate.toISOString();

    if (dueTime <= nowTime) {
      await this.notificationService.notifyTaskDeadlineOverdue({
        assigneeUserId: task.assigneeId,
        organizationId: task.organizationId,
        projectId: task.projectId,
        taskId: task.id,
        taskTitle: task.title,
        dueDateIso,
      });
      return;
    }

    if (dueTime <= nowTime + DEADLINE_APPROACHING_WINDOW_MS) {
      await this.notificationService.notifyTaskDeadlineApproaching({
        assigneeUserId: task.assigneeId,
        organizationId: task.organizationId,
        projectId: task.projectId,
        taskId: task.id,
        taskTitle: task.title,
        dueDateIso,
      });
    }
  }

  async evaluateTaskDeadlines(options?: {
    now?: Date;
    shouldContinue?: () => boolean;
  }): Promise<number> {
    if (!this.taskRepository) return 0;

    const now = options?.now ?? new Date();
    const horizon = new Date(now.getTime() + DEADLINE_APPROACHING_WINDOW_MS);
    let cursor: DeadlineNotificationTaskCursor | undefined;
    let totalProcessed = 0;

    while (true) {
      if (options?.shouldContinue?.() === false) break;
      const batch = await this.taskRepository.listTasksForDeadlineNotifications(
        {
          through: horizon,
          after: cursor,
          limit: DEADLINE_SCAN_BATCH_SIZE,
        },
      );
      if (batch.length === 0) {
        break;
      }

      for (const raw of batch) {
        if (options?.shouldContinue?.() === false) break;
        const rawIdStr = String(raw._id);
        if (!raw.assigneeId || !raw.dueDate) continue;
        await this.evaluateSingleTask(
          {
            id: rawIdStr,
            organizationId: String(raw.organizationId),
            projectId: String(raw.projectId),
            title: typeof raw.title === 'string' ? raw.title : 'Task',
            status: typeof raw.status === 'string' ? raw.status : 'TODO',
            assigneeId: String(raw.assigneeId),
            dueDate: raw.dueDate,
            deletedAt: raw.deletedAt ?? null,
          },
          now,
        );
        totalProcessed += 1;
      }

      const last = batch.at(-1);
      if (!last) break;
      cursor = { dueDate: last.dueDate, id: last._id };
      if (batch.length < DEADLINE_SCAN_BATCH_SIZE) break;
    }

    return totalProcessed;
  }
}
