/* eslint-disable @typescript-eslint/unbound-method -- Assertions inspect Jest mock methods. */
import { UnprocessableEntityException } from '@nestjs/common';
import type {
  PlatformJobCommandInput,
  PlatformJobOperationsRepository,
} from './platform-job-operations.repository';
import { PlatformJobOperationsService } from './platform-job-operations.service';

describe('PlatformJobOperationsService commands', () => {
  it('validates the command contract before delegating to the live queue adapter', async () => {
    const repository = {
      listQueues: jest.fn(),
      findQueue: jest.fn(),
      listJobs: jest.fn(),
      findJob: jest.fn(),
      execute: jest.fn().mockResolvedValue({
        body: {
          queueId: 'ingestion-queue',
          jobId: 'job-1',
          command: 'RETRY',
          outcome: 'RETRY_QUEUED',
          completedAt: '2026-10-17T09:00:00.000Z',
        },
        replayed: false,
      }),
    } as unknown as jest.Mocked<PlatformJobOperationsRepository>;
    const service = new PlatformJobOperationsService(repository);
    const input = {
      actorUserId: '651a2b3c4d5e6f7a8b9c0d1f',
      queueId: 'ingestion-queue' as const,
      jobId: 'job-1',
      idempotencyKey: 'operator-command-001',
      command: { command: 'RETRY' as const, expectedStatus: 'FAILED' as const },
    };

    await expect(service.execute(input)).resolves.toMatchObject({
      replayed: false,
      body: { outcome: 'RETRY_QUEUED' },
    });
    expect(repository.execute).toHaveBeenCalledWith(input);
  });

  it.each([
    { queueId: 'unknown-queue', jobId: 'job-1' },
    { queueId: 'ingestion-queue', jobId: '../unsafe' },
    { queueId: 'ingestion-queue', jobId: 'job-1', idempotencyKey: 'short' },
  ])(
    'rejects invalid job command input %# before queue access',
    async (overrides) => {
      const repository = {
        listQueues: jest.fn(),
        findQueue: jest.fn(),
        listJobs: jest.fn(),
        findJob: jest.fn(),
        execute: jest.fn(),
      } as unknown as jest.Mocked<PlatformJobOperationsRepository>;
      const service = new PlatformJobOperationsService(repository);
      const input = Object.assign(
        {
          actorUserId: '651a2b3c4d5e6f7a8b9c0d1f',
          queueId: 'ingestion-queue' as const,
          jobId: 'job-1',
          idempotencyKey: 'operator-command-001',
          command: {
            command: 'RETRY' as const,
            expectedStatus: 'FAILED' as const,
          },
        },
        overrides,
      ) as PlatformJobCommandInput;

      await expect(service.execute(input)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(repository.execute).not.toHaveBeenCalled();
    },
  );
});
