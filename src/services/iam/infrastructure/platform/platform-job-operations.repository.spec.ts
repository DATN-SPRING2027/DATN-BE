import type {
  PlatformBullMqQueueClientFactory,
  PlatformBullMqQueueClient,
} from '../../application/platform/platform-job-operations.repository';
import { BullMqPlatformJobOperationsRepository } from './platform-job-operations.repository';

describe('BullMqPlatformJobOperationsRepository', () => {
  function createRepository(queueOverrides: Record<string, object> = {}) {
    const queue = (id: string) => ({
      getJobCounts: jest.fn().mockResolvedValue({
        waiting: 2,
        active: 1,
        completed: 4,
        failed: 1,
        delayed: 0,
        paused: 0,
        'waiting-children': 0,
      }),
      isPaused: jest.fn().mockResolvedValue(false),
      getWorkersCount: jest.fn().mockResolvedValue(1),
      getJobs: jest.fn().mockResolvedValue([]),
      getJob: jest.fn().mockResolvedValue(undefined),
      ...queueOverrides[id],
    });
    const clients = new Map<string, PlatformBullMqQueueClient>();
    const factory = {
      get: jest.fn((id: string) => {
        if (!clients.has(id)) clients.set(id, queue(id));
        return clients.get(id)!;
      }),
    } as unknown as PlatformBullMqQueueClientFactory;
    return {
      repository: new BullMqPlatformJobOperationsRepository(factory),
      factory,
      clients,
    };
  }

  it('reads real queue counters without treating an unavailable queue as empty', async () => {
    const { repository, clients } = createRepository({
      'jira-sync-queue': {
        getJobCounts: jest
          .fn()
          .mockRejectedValue(new Error('redis password=secret')),
      },
    });

    const queues = await repository.listQueues();
    const jira = queues.data.find((item) => item.id === 'jira-sync-queue');
    const ingestion = queues.data.find((item) => item.id === 'ingestion-queue');

    expect(queues.data.length).toBeGreaterThan(1);
    expect(jira).toMatchObject({
      status: 'UNAVAILABLE',
      availability: 'UNAVAILABLE',
      workers: null,
      counts: null,
      depth: null,
    });
    expect(ingestion).toMatchObject({
      status: 'READY',
      availability: 'AVAILABLE',
      workers: 1,
      depth: 3,
      counts: { waiting: 2, active: 1, completed: 4, failed: 1 },
    });
    expect(JSON.stringify(queues)).not.toContain('secret');
    expect(clients.size).toBe(6);
  });

  it('projects job metadata only and redacts BullMQ payload and failure text', async () => {
    const job = {
      id: 'job-1',
      data: { organizationId: 'tenant-1', token: 'private-token' },
      failedReason: 'password=private-password',
      attemptsMade: 2,
      opts: { attempts: 3 },
      timestamp: 1_760_000_000_000,
      processedOn: 1_760_000_001_000,
      finishedOn: 1_760_000_002_000,
      getState: jest.fn().mockResolvedValue('failed'),
    };
    const { repository } = createRepository({
      'ingestion-queue': {
        getJobs: jest.fn().mockResolvedValue([job]),
        getJob: jest.fn().mockResolvedValue(job),
      },
    });

    const page = await repository.listJobs({
      page: 1,
      pageSize: 10,
      queueId: 'ingestion-queue',
      status: 'FAILED',
    });
    const detail = await repository.findJob('ingestion-queue', 'job-1');

    expect(page.data[0]).toMatchObject({
      id: 'job-1',
      queueId: 'ingestion-queue',
      status: 'FAILED',
      attemptsMade: 2,
      attempts: 3,
      failureSummary: 'Job failed. Raw failure details are withheld.',
    });
    expect(detail).toEqual(page.data[0]);
    expect(JSON.stringify({ page, detail })).not.toMatch(
      /tenant-1|private-token|private-password|organizationId|failedReason|data:/,
    );
  });
});
