/* eslint-disable @typescript-eslint/unbound-method -- Assertions inspect Jest mock methods. */
import {
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PlatformAuditRepository } from './platform-audit.repository';
import { PlatformAuditService } from './platform-audit.service';

describe('PlatformAuditService request trace lookup', () => {
  let repository: jest.Mocked<PlatformAuditRepository>;
  let service: PlatformAuditService;

  beforeEach(() => {
    repository = {
      listOperationalMetadata: jest.fn().mockResolvedValue([]),
      listEvents: jest.fn(),
      findRequestTrace: jest.fn().mockResolvedValue({
        requestId: 'trace-001',
        events: [
          {
            eventId: 'event-001',
            occurredAt: '2026-10-17T09:00:00.000Z',
            actorUserId: '651a2b3c4d5e6f7a8b9c0d1f',
            action: 'platform.incident.created',
            resourceType: 'INCIDENT',
            resourceId: '751a2b3c4d5e6f7a8b9c0d1f',
            scope: 'PLATFORM',
            result: 'SUCCESS',
            requestId: 'trace-001',
          },
        ],
        truncated: false,
      }),
      findEvent: jest.fn(),
      listResourceHistory: jest.fn(),
    };
    service = new PlatformAuditService(repository);
  });

  it('validates and delegates an exact bounded request ID', async () => {
    const result = await service.findRequestTrace('trace-001');
    expect(repository.findRequestTrace).toHaveBeenCalledWith('trace-001');
    expect(result.events).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });

  it('rejects malformed IDs before reaching the repository', async () => {
    await expect(
      service.findRequestTrace('trace/unsafe'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.findRequestTrace).not.toHaveBeenCalled();
  });

  it('returns not found when the audit source has no matching trace', async () => {
    repository.findRequestTrace.mockResolvedValueOnce({
      requestId: 'trace-001',
      events: [],
      truncated: false,
    });
    await expect(service.findRequestTrace('trace-001')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('hides raw audit-store failures behind a safe dependency error', async () => {
    repository.findRequestTrace.mockRejectedValueOnce(
      new Error('secret Mongo topology details'),
    );
    await expect(service.findRequestTrace('trace-001')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('PlatformAuditService job audit filters', () => {
  it('accepts job actions and queue-qualified job resource identifiers', async () => {
    const repository = {
      listOperationalMetadata: jest.fn(),
      listEvents: jest.fn().mockResolvedValue({
        data: [],
        pagination: { page: 1, pageSize: 10, totalItems: 0, totalPages: 0 },
      }),
      findRequestTrace: jest.fn(),
      findEvent: jest.fn(),
      listResourceHistory: jest.fn().mockResolvedValue({
        data: [],
        pagination: { page: 1, pageSize: 10, totalItems: 0, totalPages: 0 },
      }),
    } as unknown as jest.Mocked<PlatformAuditRepository>;
    const service = new PlatformAuditService(repository);

    await service.listEvents({
      page: 1,
      pageSize: 10,
      action: 'platform.job.retry',
      resourceType: 'JOB',
      resourceId: 'ingestion-queue:job-1',
    });
    await service.listResourceHistory({
      page: 1,
      pageSize: 10,
      resourceType: 'JOB',
      resourceId: 'ingestion-queue:job-1',
    });

    expect(repository.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.job.retry',
        resourceType: 'JOB',
        resourceId: 'ingestion-queue:job-1',
      }),
    );
    expect(repository.listResourceHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'JOB',
        resourceId: 'ingestion-queue:job-1',
      }),
    );
  });
});
