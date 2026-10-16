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
        occurredAt,
        metadata: { tenantContent: 'sentinel-membership-private-content' },
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
        action: {
          $in: [
            'organization.create',
            'platform.authority.granted',
            'platform.authority.revoked',
            'ORGANIZATION_MEMBERSHIP_SUSPENDED',
          ],
        },
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
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /sentinel-password-hash|sentinel-tenant-content|sentinel-access-token|sentinel-refresh-token|sentinel-private-project-content|sentinel-membership-private-content|tenant-project-1/,
    );
  });
});
