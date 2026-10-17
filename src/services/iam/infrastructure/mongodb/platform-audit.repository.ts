import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  AUDIT_DATABASE_NAME_TOKEN,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import type {
  PlatformAuditRepository,
  PlatformOperationalAuditRecord,
} from '../../application/platform/platform-audit.repository';
import { IAM_PERSISTENCE } from '../persistence';

interface AuditDocument {
  action: string;
  targetResource: string;
  targetResourceId: string;
  actorUserId: string;
  occurredAt: Date;
}

const PLATFORM_OPERATIONAL_ACTIONS = [
  'organization.create',
  'platform.authority.granted',
  'platform.authority.revoked',
] as const;

@Injectable()
export class MongoPlatformAuditRepository implements PlatformAuditRepository {
  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
    @Optional()
    @Inject(AUDIT_DATABASE_NAME_TOKEN)
    private readonly auditDatabaseName = AUDIT_DATABASE_NAME,
  ) {}

  async listOperationalMetadata(): Promise<PlatformOperationalAuditRecord[]> {
    if (!this.connection)
      throw new Error('Platform audit persistence unavailable');
    const rows = await this.connection
      .useDb(this.auditDatabaseName, { useCache: true })
      .collection<AuditDocument>(IAM_AUDIT_COLLECTION_NAME)
      .find(
        { action: { $in: [...PLATFORM_OPERATIONAL_ACTIONS] } },
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
      )
      .sort({ occurredAt: -1, _id: -1 })
      .limit(100)
      .toArray();

    return rows.flatMap((row) => {
      if (
        !PLATFORM_OPERATIONAL_ACTIONS.includes(
          row.action as (typeof PLATFORM_OPERATIONAL_ACTIONS)[number],
        ) ||
        !row.targetResourceId ||
        !row.actorUserId ||
        !(row.occurredAt instanceof Date) ||
        !Number.isFinite(row.occurredAt.getTime())
      )
        return [];
      const targetResource =
        row.action === 'organization.create'
          ? 'ORGANIZATION'
          : 'PLATFORM_AUTHORITY';
      if (row.targetResource !== targetResource) return [];
      return [
        {
          action: row.action as PlatformOperationalAuditRecord['action'],
          targetResource,
          targetResourceId: row.targetResourceId,
          actorUserId: row.actorUserId,
          occurredAt: row.occurredAt.toISOString(),
        },
      ];
    });
  }
}
