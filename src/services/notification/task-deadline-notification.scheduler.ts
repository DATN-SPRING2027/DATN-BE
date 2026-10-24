import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { IAM_PERSISTENCE } from '../iam/infrastructure/persistence';
import { NOTIFICATION_PERSISTENCE } from './infrastructure/persistence';
import { NotificationService } from './notification.service';

export const DEADLINE_APPROACHING_WINDOW_MS = 24 * 60 * 60 * 1000;
const SCHEDULER_INTERVAL_MS = 60 * 1000;

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

  constructor(
    private readonly notificationService: NotificationService,
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly iamConnection?: Connection,
    @Optional()
    @InjectConnection(NOTIFICATION_PERSISTENCE.databaseName)
    private readonly notificationConnection?: Connection,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.intervalHandle = setInterval(() => {
      void this.evaluateTaskDeadlines().catch((err) => {
        this.logger.warn(
          `Deadline notification scan error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, SCHEDULER_INTERVAL_MS);
    this.intervalHandle.unref();
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
  }

  private tasksCollection() {
    const conn = this.iamConnection ?? this.notificationConnection;
    if (!conn || typeof conn.useDb !== 'function') return null;
    const db = conn.useDb('continuum_task', { useCache: true }).db;
    if (!db) return null;
    return db.collection('tasks');
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
    assigneeId?: string;
    taskId?: string;
    now?: Date;
  }): Promise<number> {
    const collection = this.tasksCollection();
    if (!collection) return 0;

    const now = options?.now ?? new Date();
    const horizon = new Date(now.getTime() + DEADLINE_APPROACHING_WINDOW_MS);

    const filter: Record<string, unknown> = {
      dueDate: { $ne: null, $lte: horizon },
      status: { $nin: ['DONE', 'CANCELLED'] },
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    };

    if (options?.assigneeId && Types.ObjectId.isValid(options.assigneeId)) {
      filter.assigneeId = new Types.ObjectId(options.assigneeId);
    } else {
      filter.assigneeId = { $ne: null };
    }

    if (options?.taskId && Types.ObjectId.isValid(options.taskId)) {
      filter._id = new Types.ObjectId(options.taskId);
    }

    const tasks = await collection
      .find(filter, {
        projection: {
          _id: 1,
          organizationId: 1,
          projectId: 1,
          title: 1,
          status: 1,
          assigneeId: 1,
          dueDate: 1,
          deletedAt: 1,
        },
      })
      .limit(200)
      .toArray();

    for (const raw of tasks) {
      if (!raw._id || !raw.assigneeId || !raw.dueDate) continue;
      await this.evaluateSingleTask(
        {
          id: String(raw._id),
          organizationId: String(raw.organizationId ?? ''),
          projectId: String(raw.projectId ?? ''),
          title: typeof raw.title === 'string' ? raw.title : 'Task',
          status: typeof raw.status === 'string' ? raw.status : 'TODO',
          assigneeId: String(raw.assigneeId),
          dueDate: raw.dueDate as Date,
          deletedAt: (raw.deletedAt as Date | null | undefined) ?? null,
        },
        now,
      );
    }

    return tasks.length;
  }
}
