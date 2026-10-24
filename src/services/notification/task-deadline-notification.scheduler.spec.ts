import { TaskDeadlineNotificationScheduler } from './task-deadline-notification.scheduler';
import type { NotificationService } from './notification.service';
import type { TaskWorkspaceRepository } from '../task/workspace/task-workspace.repository';
import type { RedisService } from '../iam/infrastructure/redis/redis.service';

describe('TaskDeadlineNotificationScheduler', () => {
  const originalInfraEnabled = process.env.INFRA_ENABLED;

  afterEach(() => {
    if (originalInfraEnabled === undefined) delete process.env.INFRA_ENABLED;
    else process.env.INFRA_ENABLED = originalInfraEnabled;
  });

  it('uses a shared renewable Redis lease before a distributed scan', async () => {
    process.env.INFRA_ENABLED = 'true';
    const listTasksForDeadlineNotifications = jest.fn().mockResolvedValue([]);
    const acquireLock = jest.fn().mockResolvedValue(true);
    const releaseLock = jest.fn().mockResolvedValue(true);
    const repository = {
      listTasksForDeadlineNotifications,
    } as unknown as TaskWorkspaceRepository;
    const redis = {
      acquireLock,
      releaseLock,
    } as unknown as RedisService;
    const scheduler = new TaskDeadlineNotificationScheduler(
      {} as NotificationService,
      repository,
      redis,
    );

    await (
      scheduler as unknown as { runScheduledScan: () => Promise<void> }
    ).runScheduledScan();

    expect(acquireLock).toHaveBeenCalledWith(
      expect.stringContaining('task-deadline-scan'),
      expect.any(String),
      120,
    );
    expect(listTasksForDeadlineNotifications).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledWith(
      expect.stringContaining('task-deadline-scan'),
      expect.any(String),
    );
  });

  it('skips the scan when another IAM instance holds the lease', async () => {
    process.env.INFRA_ENABLED = 'true';
    const listTasksForDeadlineNotifications = jest.fn().mockResolvedValue([]);
    const acquireLock = jest.fn().mockResolvedValue(false);
    const releaseLock = jest.fn().mockResolvedValue(true);
    const repository = {
      listTasksForDeadlineNotifications,
    } as unknown as TaskWorkspaceRepository;
    const redis = {
      acquireLock,
      releaseLock,
    } as unknown as RedisService;
    const scheduler = new TaskDeadlineNotificationScheduler(
      {} as NotificationService,
      repository,
      redis,
    );

    await (
      scheduler as unknown as { runScheduledScan: () => Promise<void> }
    ).runScheduledScan();

    expect(listTasksForDeadlineNotifications).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
  });
});
