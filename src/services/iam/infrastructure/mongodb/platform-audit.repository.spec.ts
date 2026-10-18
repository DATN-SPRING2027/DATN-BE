/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Mongoose query doubles expose driver any types. */
import type { Connection } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import { MongoPlatformAuditRepository } from './platform-audit.repository';

describe('MongoPlatformAuditRepository', () => {
  it('reads only the bounded operational projection and excludes unrelated data', async () => {
    const occurredAt = new Date('2026-10-08T00:00:00.000Z');
    const rows = [
      {
        action: 'organization.create',
        targetResource: 'ORGANIZATION',
        targetResourceId: 'organization-1',
        actorUserId: 'operator-1',
        occurredAt,
        metadata: {
          passwordHash: 'sentinel-password-hash',
          tenantContent: 'sentinel-tenant-content',
        },
      },
      {
        action: 'platform.authority.granted',
        targetResource: 'PLATFORM_AUTHORITY',
        targetResourceId: 'assignment-1',
        actorUserId: 'operator-2',
        occurredAt,
        metadata: { accessToken: 'sentinel-access-token' },
      },
      {
        action: 'platform.authority.revoked',
        targetResource: 'PLATFORM_AUTHORITY',
        targetResourceId: 'assignment-2',
        actorUserId: 'operator-3',
        occurredAt,
        metadata: { refreshToken: 'sentinel-refresh-token' },
      },
      {
        action: 'ORGANIZATION_MEMBERSHIP_SUSPENDED',
        targetResource: 'ORGANIZATION_MEMBERSHIP',
        targetResourceId: 'membership-1',
        actorUserId: 'operator-4',
        scope: 'PLATFORM',
        occurredAt,
        metadata: { tenantContent: 'sentinel-membership-private-content' },
      },
      {
        action: 'platform.user.status.changed',
        targetResource: 'USER',
        targetResourceId: 'user-1',
        actorUserId: 'operator-6',
        occurredAt,
        metadata: { passwordHash: 'user-password-secret' },
      },
      {
        action: 'platform.incident.acknowledged',
        targetResource: 'INCIDENT',
        targetResourceId: 'incident-1',
        actorUserId: 'operator-7',
        scope: 'PLATFORM',
        occurredAt,
        metadata: { note: 'must-not-be-projected' },
      },
      {
        action: 'project.create',
        targetResource: 'PROJECT',
        targetResourceId: 'tenant-project-1',
        actorUserId: 'tenant-user-1',
        occurredAt,
        metadata: { content: 'sentinel-private-project-content' },
      },
      {
        action: 'organization.create',
        targetResource: 'PROJECT',
        targetResourceId: 'wrong-target-1',
        actorUserId: 'operator-4',
        occurredAt,
      },
      {
        action: 'organization.create',
        targetResource: 'ORGANIZATION',
        targetResourceId: 'invalid-date-1',
        actorUserId: 'operator-5',
        occurredAt: new Date('invalid'),
      },
    ];
    const cursor = {
      sort: jest.fn(),
      limit: jest.fn(),
      toArray: jest.fn().mockResolvedValue(rows),
    };
    cursor.sort.mockReturnValue(cursor);
    cursor.limit.mockReturnValue(cursor);
    const collection = { find: jest.fn().mockReturnValue(cursor) };
    const auditDatabase = { collection: jest.fn().mockReturnValue(collection) };
    const useDb = jest.fn().mockReturnValue(auditDatabase);
    const repository = new MongoPlatformAuditRepository({
      useDb,
    } as unknown as Connection);

    const result = await repository.listOperationalMetadata();

    expect(useDb).toHaveBeenCalledWith(AUDIT_DATABASE_NAME, { useCache: true });
    expect(auditDatabase.collection).toHaveBeenCalledWith(
      IAM_AUDIT_COLLECTION_NAME,
    );
    expect(collection.find).toHaveBeenCalledWith(
      {
        $and: [
          {
            action: {
              $in: [
                'organization.create',
                'platform.authority.granted',
                'platform.authority.revoked',
                'platform.user.status.changed',
                'platform.user.profile.updated',
                'platform.user.archived',
                'platform.session.revoked',
                'platform.sessions.revoked_all',
                'ORGANIZATION_MEMBERSHIP_SUSPENDED',
                'platform.organization.metadata.changed',
                'platform.project.metadata.changed',
                'platform.incident.created',
                'platform.incident.acknowledged',
                'platform.incident.resolved',
                'platform.incident.note.added',
                'platform.job.retry',
                'platform.job.cancel',
              ],
            },
          },
          {
            $or: [
              { scope: 'PLATFORM' },
              { action: 'organization.create', scope: { $exists: false } },
            ],
          },
        ],
      },
      {
        projection: {
          _id: 0,
          action: 1,
          targetResource: 1,
          targetResourceId: 1,
          actorUserId: 1,
          occurredAt: 1,
        },
      },
    );
    expect(cursor.sort).toHaveBeenCalledWith({ occurredAt: -1, _id: -1 });
    expect(cursor.limit).toHaveBeenCalledWith(100);
    expect(result).toEqual([
      {
        action: 'organization.create',
        targetResource: 'ORGANIZATION',
        targetResourceId: 'organization-1',
        actorUserId: 'operator-1',
        occurredAt: '2026-10-08T00:00:00.000Z',
      },
      {
        action: 'platform.authority.granted',
        targetResource: 'PLATFORM_AUTHORITY',
        targetResourceId: 'assignment-1',
        actorUserId: 'operator-2',
        occurredAt: '2026-10-08T00:00:00.000Z',
      },
      {
        action: 'platform.authority.revoked',
        targetResource: 'PLATFORM_AUTHORITY',
        targetResourceId: 'assignment-2',
        actorUserId: 'operator-3',
        occurredAt: '2026-10-08T00:00:00.000Z',
      },
      {
        action: 'ORGANIZATION_MEMBERSHIP_SUSPENDED',
        targetResource: 'ORGANIZATION_MEMBERSHIP',
        targetResourceId: 'membership-1',
        actorUserId: 'operator-4',
        occurredAt: '2026-10-08T00:00:00.000Z',
      },
      {
        action: 'platform.user.status.changed',
        targetResource: 'USER',
        targetResourceId: 'user-1',
        actorUserId: 'operator-6',
        occurredAt: '2026-10-08T00:00:00.000Z',
      },
      {
        action: 'platform.incident.acknowledged',
        targetResource: 'INCIDENT',
        targetResourceId: 'incident-1',
        actorUserId: 'operator-7',
        occurredAt: '2026-10-08T00:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /sentinel-password-hash|sentinel-tenant-content|sentinel-access-token|sentinel-refresh-token|sentinel-private-project-content|sentinel-membership-private-content|tenant-project-1/,
    );
  });

  it('applies bounded server-side filters and projects only allow-listed event changes', async () => {
    const occurredAt = new Date('2026-10-08T00:00:00.000Z');
    const rows = [
      {
        eventId: 'event-001',
        action: 'platform.project.metadata.changed',
        targetResource: 'PROJECT',
        targetResourceId: 'a'.repeat(24),
        organizationId: 'b'.repeat(24),
        actorUserId: 'c'.repeat(24),
        scope: 'PLATFORM',
        result: 'SUCCESS',
        reasonCode: 'ACCESS_REVIEW',
        requestId: 'request-001',
        occurredAt,
        previous: { name: 'Old name', description: 'private tenant text' },
        next: { name: 'New name', description: 'private tenant text' },
        metadata: { refreshToken: 'must-not-be-read-or-returned' },
      },
    ];
    const cursor = {
      sort: jest.fn(),
      skip: jest.fn(),
      limit: jest.fn(),
      toArray: jest.fn().mockResolvedValue(rows),
    };
    cursor.sort.mockReturnValue(cursor);
    cursor.skip.mockReturnValue(cursor);
    cursor.limit.mockReturnValue(cursor);
    const collection = {
      find: jest.fn().mockReturnValue(cursor),
      countDocuments: jest.fn().mockResolvedValue(1),
    };
    const auditDatabase = { collection: jest.fn().mockReturnValue(collection) };
    const repository = new MongoPlatformAuditRepository({
      useDb: jest.fn().mockReturnValue(auditDatabase),
    } as unknown as Connection);

    const result = await repository.listEvents({
      page: 2,
      pageSize: 10,
      actorUserId: 'c'.repeat(24),
      action: 'platform.project.metadata.changed',
      resourceType: 'PROJECT',
      resourceId: 'a'.repeat(24),
      organizationId: 'b'.repeat(24),
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-10-09T00:00:00.000Z'),
    });

    expect(collection.find).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.project.metadata.changed',
        actorUserId: 'c'.repeat(24),
        targetResource: 'PROJECT',
        targetResourceId: 'a'.repeat(24),
        organizationId: 'b'.repeat(24),
        occurredAt: {
          $gte: new Date('2026-10-01T00:00:00.000Z'),
          $lt: new Date('2026-10-09T00:00:00.000Z'),
        },
        $and: expect.arrayContaining([
          expect.objectContaining({
            $and: expect.arrayContaining([
              expect.objectContaining({
                $or: expect.arrayContaining([{ scope: 'PLATFORM' }]),
              }),
            ]),
          }),
        ]),
      }),
      expect.objectContaining({
        projection: expect.not.objectContaining({ metadata: 1 }),
      }),
    );
    expect(cursor.skip).toHaveBeenCalledWith(10);
    expect(cursor.limit).toHaveBeenCalledWith(10);
    expect(result).toEqual({
      data: [
        {
          eventId: 'event-001',
          occurredAt: occurredAt.toISOString(),
          actorUserId: 'c'.repeat(24),
          action: 'platform.project.metadata.changed',
          resourceType: 'PROJECT',
          resourceId: 'a'.repeat(24),
          scope: 'PLATFORM',
          result: 'SUCCESS',
          organizationId: 'b'.repeat(24),
          reasonCode: 'ACCESS_REVIEW',
          requestId: 'request-001',
          changes: { name: { from: 'Old name', to: 'New name' } },
        },
      ],
      pagination: { page: 2, pageSize: 10, totalItems: 1, totalPages: 1 },
    });
    expect(JSON.stringify(result)).not.toContain('private tenant text');
    expect(JSON.stringify(result)).not.toContain(
      'must-not-be-read-or-returned',
    );
  });

  it('maps incident audit events to INCIDENT and exposes only status changes', async () => {
    const occurredAt = new Date('2026-10-08T00:00:00.000Z');
    const cursor = {
      sort: jest.fn(),
      skip: jest.fn(),
      limit: jest.fn(),
      toArray: jest.fn().mockResolvedValue([
        {
          eventId: 'incident-event-1',
          action: 'platform.incident.resolved',
          targetResource: 'INCIDENT',
          targetResourceId: 'a'.repeat(24),
          actorUserId: 'b'.repeat(24),
          scope: 'PLATFORM',
          result: 'SUCCESS',
          previousStatus: 'ACKNOWLEDGED',
          newStatus: 'RESOLVED',
          occurredAt,
          metadata: { note: 'private operational note' },
        },
      ]),
    };
    cursor.sort.mockReturnValue(cursor);
    cursor.skip.mockReturnValue(cursor);
    cursor.limit.mockReturnValue(cursor);
    const collection = {
      find: jest.fn().mockReturnValue(cursor),
      countDocuments: jest.fn().mockResolvedValue(1),
    };
    const repository = new MongoPlatformAuditRepository({
      useDb: jest.fn().mockReturnValue({
        collection: jest.fn().mockReturnValue(collection),
      }),
    } as unknown as Connection);

    const result = await repository.listEvents({
      page: 1,
      pageSize: 10,
      action: 'platform.incident.resolved',
      resourceType: 'INCIDENT',
      resourceId: 'a'.repeat(24),
    });

    expect(result.data).toEqual([
      {
        eventId: 'incident-event-1',
        occurredAt: occurredAt.toISOString(),
        actorUserId: 'b'.repeat(24),
        action: 'platform.incident.resolved',
        resourceType: 'INCIDENT',
        resourceId: 'a'.repeat(24),
        scope: 'PLATFORM',
        result: 'SUCCESS',
        changes: { status: { from: 'ACKNOWLEDGED', to: 'RESOLVED' } },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('private operational note');
  });

  it('finds a bounded request trace by correlation ID with a safe projection', async () => {
    const occurredAt = new Date('2026-10-08T00:00:00.000Z');
    const cursor = {
      sort: jest.fn(),
      limit: jest.fn(),
      toArray: jest.fn().mockResolvedValue([
        {
          eventId: 'trace-event-1',
          action: 'platform.incident.created',
          targetResource: 'INCIDENT',
          targetResourceId: 'a'.repeat(24),
          actorUserId: 'b'.repeat(24),
          scope: 'PLATFORM',
          result: 'SUCCESS',
          correlationId: 'trace-safe-001',
          occurredAt,
          metadata: { accessToken: 'sentinel-token' },
        },
      ]),
    };
    cursor.sort.mockReturnValue(cursor);
    cursor.limit.mockReturnValue(cursor);
    const collection = { find: jest.fn().mockReturnValue(cursor) };
    const repository = new MongoPlatformAuditRepository({
      useDb: jest.fn().mockReturnValue({
        collection: jest.fn().mockReturnValue(collection),
      }),
    } as unknown as Connection);

    const result = await repository.findRequestTrace('trace-safe-001');

    expect(collection.find).toHaveBeenCalledWith(
      {
        $and: [
          expect.any(Object),
          {
            $or: [
              { requestId: 'trace-safe-001' },
              { correlationId: 'trace-safe-001' },
            ],
          },
        ],
      },
      expect.objectContaining({
        projection: expect.not.objectContaining({ metadata: 1 }),
      }),
    );
    expect(cursor.sort).toHaveBeenCalledWith({ occurredAt: 1, _id: 1 });
    expect(cursor.limit).toHaveBeenCalledWith(51);
    expect(result).toEqual({
      requestId: 'trace-safe-001',
      truncated: false,
      events: [
        {
          eventId: 'trace-event-1',
          occurredAt: occurredAt.toISOString(),
          actorUserId: 'b'.repeat(24),
          action: 'platform.incident.created',
          resourceType: 'INCIDENT',
          resourceId: 'a'.repeat(24),
          scope: 'PLATFORM',
          result: 'SUCCESS',
          requestId: 'trace-safe-001',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('sentinel-token');
  });
});
