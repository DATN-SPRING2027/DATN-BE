/* eslint-disable @typescript-eslint/unbound-method -- Assertions inspect Jest mock methods. */
import {
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  PlatformIncidentCommand,
  PlatformIncidentRepository,
} from './platform-incident.repository';
import { PlatformIncidentService } from './platform-incident.service';

const actorUserId = '651a2b3c4d5e6f7a8b9c0d1f';
const incidentId = '751a2b3c4d5e6f7a8b9c0d1f';
const summary = {
  id: incidentId,
  title: 'Ingestion worker unavailable',
  severity: 'HIGH' as const,
  status: 'OPEN' as const,
  affectedServiceId: 'ingestion' as const,
  version: 1,
  createdAt: '2026-10-17T08:00:00.000Z',
  updatedAt: '2026-10-17T08:00:00.000Z',
  createdBy: actorUserId,
  updatedBy: actorUserId,
  acknowledgedAt: null,
  resolvedAt: null,
};

describe('PlatformIncidentService', () => {
  let repository: jest.Mocked<PlatformIncidentRepository>;
  let service: PlatformIncidentService;

  beforeEach(() => {
    repository = {
      list: jest.fn().mockResolvedValue({
        data: [],
        pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      }),
      find: jest.fn().mockResolvedValue(summary),
      listHistory: jest.fn().mockResolvedValue({
        data: [],
        pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      }),
      execute: jest.fn().mockResolvedValue({
        httpStatus: 201,
        replayed: false,
        body: summary,
      }),
    };
    service = new PlatformIncidentService(repository);
  });

  it('validates and delegates stable, bounded list filters', async () => {
    await service.list({
      page: 2,
      pageSize: 50,
      status: 'ACKNOWLEDGED',
      severity: 'HIGH',
      affectedServiceId: 'ingestion',
    });
    expect(repository.list).toHaveBeenCalledWith({
      page: 2,
      pageSize: 50,
      status: 'ACKNOWLEDGED',
      severity: 'HIGH',
      affectedServiceId: 'ingestion',
    });
    await expect(
      service.list({ page: 1, pageSize: 101 }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('normalizes create input and delegates an idempotent Platform command', async () => {
    const command: PlatformIncidentCommand = {
      command: 'CREATE',
      title: '  Ingestion worker unavailable  ',
      severity: 'HIGH',
      affectedServiceId: 'ingestion',
    };
    await service.execute({
      actorUserId,
      idempotencyKey: 'incident-create-key-0001',
      command,
      correlationId: 'trace-incident-1',
    });
    const executedInput = repository.execute.mock.calls[0]?.[0];
    expect(executedInput).toMatchObject({
      actorUserId,
      idempotencyKey: 'incident-create-key-0001',
      correlationId: 'trace-incident-1',
      command: { ...command, title: 'Ingestion worker unavailable' },
    });
    expect(executedInput?.now).toBeInstanceOf(Date);
  });

  it('redacts credentials, bearer tokens, email addresses, and ObjectId values from notes', async () => {
    await service.execute({
      actorUserId,
      idempotencyKey: 'incident-note-key-0001',
      command: {
        command: 'ADD_NOTE',
        incidentId,
        expectedVersion: 1,
        note: 'Investigating for alice@example.test; bearer eyJhbGci.abc.def api_key=sk-test-secret-123 client_secret=client-secret-sentinel accessToken=access-token-sentinel refresh_token=refresh-token-sentinel apiKey=api-key-sentinel 651a2b3c4d5e6f7a8b9c0d1f',
      },
    });
    const call = repository.execute.mock.calls[0][0];
    if (call.command.command !== 'ADD_NOTE')
      throw new Error('Expected note command');
    expect(call.command.note).not.toContain('alice@example.test');
    expect(call.command.note).not.toContain('eyJhbGci');
    expect(call.command.note).not.toContain('sk-test-secret');
    expect(call.command.note).not.toContain('client-secret-sentinel');
    expect(call.command.note).not.toContain('access-token-sentinel');
    expect(call.command.note).not.toContain('refresh-token-sentinel');
    expect(call.command.note).not.toContain('api-key-sentinel');
    expect(call.command.note).not.toContain(incidentId);
    expect(call.command.note).toContain('[REDACTED');
  });

  it('redacts sensitive values from incident titles before persistence', async () => {
    await service.execute({
      actorUserId,
      idempotencyKey: 'incident-title-secret-001',
      command: {
        command: 'CREATE',
        title: 'OAuth failure for kayt@example.com',
        severity: 'HIGH',
        affectedServiceId: 'iam',
      },
    });
    const call = repository.execute.mock.calls[0][0];
    if (call.command.command !== 'CREATE')
      throw new Error('Expected incident create');
    expect(call.command.title).not.toContain('kayt@example.com');
    expect(call.command.title).toContain('[REDACTED');
  });

  it('rejects unknown services and malformed command fields before persistence', async () => {
    await expect(
      service.execute({
        actorUserId,
        idempotencyKey: 'incident-create-key-0002',
        command: {
          command: 'CREATE',
          title: 'API outage',
          severity: 'HIGH',
          affectedServiceId: 'unknown-service',
        },
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      service.execute({
        actorUserId,
        idempotencyKey: 'incident-action-key-0001',
        command: {
          command: 'ACKNOWLEDGE',
          incidentId,
          expectedVersion: 0,
          note: 'Acknowledging outage',
        },
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.execute).not.toHaveBeenCalled();
  });

  it('preserves repository state-transition conflicts', async () => {
    repository.execute.mockRejectedValueOnce(
      new ConflictException({ code: 'PLATFORM_INCIDENT_VERSION_CONFLICT' }),
    );
    await expect(
      service.execute({
        actorUserId,
        idempotencyKey: 'incident-action-key-0002',
        command: {
          command: 'RESOLVE',
          incidentId,
          expectedVersion: 1,
          note: 'Recovered',
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
