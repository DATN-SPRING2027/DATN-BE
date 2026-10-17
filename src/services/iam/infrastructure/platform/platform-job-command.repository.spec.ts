/* eslint-disable @typescript-eslint/unbound-method -- Assertions inspect Jest mock methods. */
import type {
  PlatformBullMqJobClient,
  PlatformBullMqQueueClient,
  PlatformBullMqQueueClientFactory,
  PlatformJobOperationStore,
} from '../../application/platform/platform-job-operations.repository';
import type { Connection } from 'mongoose';
import { BullMqPlatformJobOperationsRepository } from './platform-job-operations.repository';

describe('BullMqPlatformJobOperationsRepository commands', () => {
  function setup(initialState = 'failed') {
    const operationValues = new Map<string, string>();
    const store: PlatformJobOperationStore = {
      get: jest.fn((key) => Promise.resolve(operationValues.get(key) ?? null)),
      setIfAbsent: jest.fn((key, value) => {
        if (operationValues.has(key)) return Promise.resolve(false);
        operationValues.set(key, value);
        return Promise.resolve(true);
      }),
      set: jest.fn((key, value) => {
        operationValues.set(key, value);
        return Promise.resolve();
      }),
      releaseLock: jest.fn((key, owner) => {
        if (operationValues.get(key) === owner) operationValues.delete(key);
        return Promise.resolve();
      }),
    };
    let state = initialState;
    const job: PlatformBullMqJobClient = {
      id: 'job-1',
      attemptsMade: 2,
      opts: { attempts: 3 },
      timestamp: 1_760_000_000_000,
      getState: jest.fn(() => Promise.resolve(state)),
      retry: jest.fn(() => {
        state = 'waiting';
        return Promise.resolve();
      }),
      remove: jest.fn(() => {
        state = 'unknown';
        return Promise.resolve();
      }),
    };
    const queue = {
      getJob: jest.fn(() => Promise.resolve(job)),
    } as unknown as PlatformBullMqQueueClient;
    const factory = {
      get: jest.fn(() => queue),
      getOperationStore: jest.fn(() => store),
    } as unknown as PlatformBullMqQueueClientFactory;
    const auditEvents = new Map<string, Record<string, unknown>>();
    const auditCollection = {
      findOne: jest.fn((filter: { eventId: string }) =>
        Promise.resolve(auditEvents.get(filter.eventId) ?? null),
      ),
      updateOne: jest.fn(
        (
          filter: { eventId: string },
          update: { $setOnInsert: Record<string, unknown> },
        ) => {
          if (!auditEvents.has(filter.eventId))
            auditEvents.set(filter.eventId, update.$setOnInsert);
          return Promise.resolve({ acknowledged: true, upsertedCount: 1 });
        },
      ),
    };
    const connection = {
      useDb: jest.fn(() => ({ collection: jest.fn(() => auditCollection) })),
    } as unknown as Connection;
    const repository = new BullMqPlatformJobOperationsRepository(
      factory,
      connection,
      'continuum_audit',
    );
    return { repository, job, store, auditEvents, auditCollection };
  }

  const input = {
    actorUserId: '651a2b3c4d5e6f7a8b9c0d1f',
    queueId: 'ingestion-queue' as const,
    jobId: 'job-1',
    idempotencyKey: 'operator-command-001',
    command: { command: 'RETRY' as const, expectedStatus: 'FAILED' as const },
    correlationId: 'request-001',
  };

  it('retries a failed job, writes a safe audit event, and exactly replays', async () => {
    const { repository, job, auditEvents } = setup();

    const first = await repository.execute(input);
    const replay = await repository.execute(input);

    expect(job.retry).toHaveBeenCalledTimes(1);
    expect(job.retry).toHaveBeenCalledWith('failed');
    expect(first).toMatchObject({
      replayed: false,
      body: {
        queueId: 'ingestion-queue',
        jobId: 'job-1',
        command: 'RETRY',
        outcome: 'RETRY_QUEUED',
      },
    });
    expect(replay).toEqual({ ...first, replayed: true });
    const [audit] = [...auditEvents.values()];
    expect(audit).toMatchObject({
      action: 'platform.job.retry',
      targetResource: 'JOB',
      targetResourceId: 'ingestion-queue:job-1',
      actorUserId: input.actorUserId,
      scope: 'PLATFORM',
      result: 'SUCCESS',
      requestId: 'request-001',
    });
    expect(JSON.stringify(audit)).not.toMatch(
      /password|token|payload|failedReason/i,
    );
  });

  it('rejects stale expected state without changing the job', async () => {
    const { repository, job } = setup('waiting');

    await expect(repository.execute(input)).rejects.toMatchObject({
      response: { code: 'PLATFORM_JOB_STATE_CONFLICT' },
    });
    expect(job.retry).not.toHaveBeenCalled();
  });

  it('removes a delayed job only after checking the expected state', async () => {
    const { repository, job } = setup('delayed');
    const cancelInput = {
      ...input,
      idempotencyKey: 'operator-cancel-command-001',
      command: {
        command: 'CANCEL' as const,
        expectedStatus: 'DELAYED' as const,
      },
    };

    await expect(repository.execute(cancelInput)).resolves.toMatchObject({
      replayed: false,
      body: { command: 'CANCEL', outcome: 'CANCELLED' },
    });
    expect(job.remove).toHaveBeenCalledTimes(1);
    expect(job.retry).not.toHaveBeenCalled();
  });

  it('reconciles a confirmed queue mutation when its audit write was unavailable', async () => {
    const { repository, job, auditCollection } = setup();
    auditCollection.updateOne.mockRejectedValueOnce(
      new Error('audit unavailable'),
    );

    await expect(repository.execute(input)).rejects.toMatchObject({
      response: { code: 'PLATFORM_JOB_OPERATION_UNCERTAIN' },
    });
    await expect(repository.execute(input)).resolves.toMatchObject({
      replayed: true,
      body: { outcome: 'RETRY_QUEUED' },
    });
    expect(job.retry).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of an idempotency key for a different command', async () => {
    const { repository } = setup();
    await repository.execute(input);

    await expect(
      repository.execute({
        ...input,
        command: { command: 'CANCEL', expectedStatus: 'WAITING' },
      }),
    ).rejects.toMatchObject({
      response: { code: 'PLATFORM_JOB_IDEMPOTENCY_CONFLICT' },
    });
  });
});
