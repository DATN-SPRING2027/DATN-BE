import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  AUDIT_DATABASE_NAME_TOKEN,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import type {
  PlatformAuditAction,
  PlatformAuditEvent,
  PlatformAuditPage,
  PlatformAuditQuery,
  PlatformAuditResourceType,
  PlatformAuditRepository,
  PlatformOperationalAuditRecord,
  PlatformRequestTrace,
} from '../../application/platform/platform-audit.repository';
import { IAM_PERSISTENCE } from '../persistence';

interface AuditDocument {
  _id?: Types.ObjectId;
  eventId?: string;
  action: string;
  targetResource: string;
  targetResourceId: string;
  actorUserId: string;
  occurredAt: Date;
  organizationId?: string;
  scope?: string;
  result?: string;
  reasonCode?: string;
  requestId?: string;
  correlationId?: string;
  previousStatus?: string;
  newStatus?: string;
  changedFields?: string[];
  previous?: Record<string, unknown>;
  next?: Record<string, unknown>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

const PLATFORM_OPERATIONAL_ACTIONS = [
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
] as const;
const PROJECTED_AUDIT_FIELDS = {
  _id: 1,
  eventId: 1,
  action: 1,
  targetResource: 1,
  targetResourceId: 1,
  actorUserId: 1,
  occurredAt: 1,
  organizationId: 1,
  scope: 1,
  result: 1,
  reasonCode: 1,
  requestId: 1,
  correlationId: 1,
  previousStatus: 1,
  newStatus: 1,
  changedFields: 1,
  previous: 1,
  next: 1,
  before: 1,
  after: 1,
} as const;

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
        {
          $and: [
            { action: { $in: [...PLATFORM_OPERATIONAL_ACTIONS] } },
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
      const resolvedResource = this.expectedResource(row.action);
      if (!resolvedResource) return [];
      const targetResource = resolvedResource;
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

  async listEvents(query: PlatformAuditQuery): Promise<PlatformAuditPage> {
    const match = this.eventFilter(query);
    const [rows, totalItems] = await Promise.all([
      this.collection()
        .find(match, { projection: PROJECTED_AUDIT_FIELDS })
        .sort({ occurredAt: -1, _id: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .toArray(),
      this.collection().countDocuments(match),
    ]);
    return this.mapPage(rows, query.page, query.pageSize, totalItems);
  }

  async findRequestTrace(requestId: string): Promise<PlatformRequestTrace> {
    const rows = await this.collection()
      .find(
        {
          $and: [
            this.platformEventScope(),
            { $or: [{ requestId }, { correlationId: requestId }] },
          ],
        },
        { projection: PROJECTED_AUDIT_FIELDS },
      )
      .sort({ occurredAt: 1, _id: 1 })
      .limit(51)
      .toArray();
    return {
      requestId,
      events: rows.slice(0, 50).flatMap((row) => {
        const mapped = this.mapEvent(row);
        return mapped ? [mapped] : [];
      }),
      truncated: rows.length > 50,
    };
  }

  async findEvent(eventId: string): Promise<PlatformAuditEvent | null> {
    const or: Record<string, unknown>[] = [{ eventId }];
    if (Types.ObjectId.isValid(eventId) && eventId.length === 24)
      or.push({ _id: new Types.ObjectId(eventId) });
    const row = await this.collection().findOne(
      {
        $and: [this.platformEventScope(), { $or: or }],
      },
      { projection: PROJECTED_AUDIT_FIELDS },
    );
    return row ? this.mapEvent(row) : null;
  }

  async listResourceHistory(input: {
    resourceType: PlatformAuditResourceType;
    resourceId: string;
    page: number;
    pageSize: number;
  }): Promise<PlatformAuditPage> {
    const match = this.eventFilter({
      page: input.page,
      pageSize: input.pageSize,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
    });
    const [rows, totalItems] = await Promise.all([
      this.collection()
        .find(match, { projection: PROJECTED_AUDIT_FIELDS })
        .sort({ occurredAt: -1, _id: -1 })
        .skip((input.page - 1) * input.pageSize)
        .limit(input.pageSize)
        .toArray(),
      this.collection().countDocuments(match),
    ]);
    return this.mapPage(rows, input.page, input.pageSize, totalItems);
  }

  private eventFilter(query: PlatformAuditQuery): Record<string, unknown> {
    const match: Record<string, unknown> = {
      $and: [this.platformEventScope()],
    };
    if (query.actorUserId) match.actorUserId = query.actorUserId;
    if (query.action) match.action = query.action;
    if (query.resourceType) match.targetResource = query.resourceType;
    if (query.resourceId) match.targetResourceId = query.resourceId;
    if (query.organizationId) match.organizationId = query.organizationId;
    if (query.from || query.to) {
      match.occurredAt = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lt: query.to } : {}),
      };
    }
    return match;
  }

  private platformEventScope(): Record<string, unknown> {
    return {
      $and: [
        { action: { $in: [...PLATFORM_OPERATIONAL_ACTIONS] } },
        {
          $or: [
            { scope: 'PLATFORM' },
            { action: 'organization.create', scope: { $exists: false } },
          ],
        },
      ],
    };
  }

  private mapPage(
    rows: AuditDocument[],
    page: number,
    pageSize: number,
    totalItems: number,
  ): PlatformAuditPage {
    return {
      data: rows.flatMap((row) => {
        const mapped = this.mapEvent(row);
        return mapped ? [mapped] : [];
      }),
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  private mapEvent(row: AuditDocument): PlatformAuditEvent | null {
    if (
      !PLATFORM_OPERATIONAL_ACTIONS.includes(
        row.action as (typeof PLATFORM_OPERATIONAL_ACTIONS)[number],
      ) ||
      typeof row.targetResourceId !== 'string' ||
      typeof row.actorUserId !== 'string' ||
      !(row.occurredAt instanceof Date) ||
      !Number.isFinite(row.occurredAt.getTime()) ||
      (row.scope !== 'PLATFORM' &&
        !(row.action === 'organization.create' && row.scope === undefined)) ||
      (row.result !== undefined && row.result !== 'SUCCESS')
    )
      return null;
    const expectedResource = this.expectedResource(row.action);
    if (!expectedResource || row.targetResource !== expectedResource)
      return null;
    const eventId =
      typeof row.eventId === 'string' && row.eventId.length > 0
        ? row.eventId
        : row._id instanceof Types.ObjectId
          ? row._id.toHexString()
          : '';
    if (!eventId) return null;
    const changes = this.safeChanges(row);
    return {
      eventId,
      occurredAt: row.occurredAt.toISOString(),
      actorUserId: row.actorUserId,
      action: row.action as PlatformAuditAction,
      resourceType: expectedResource,
      resourceId: row.targetResourceId,
      scope: 'PLATFORM',
      result: 'SUCCESS',
      ...(typeof row.organizationId === 'string'
        ? { organizationId: row.organizationId }
        : {}),
      ...(typeof row.reasonCode === 'string'
        ? { reasonCode: row.reasonCode }
        : {}),
      ...((typeof row.requestId === 'string' && row.requestId.length > 0) ||
      (typeof row.correlationId === 'string' && row.correlationId.length > 0)
        ? {
            requestId: row.requestId ?? row.correlationId,
          }
        : {}),
      ...(Object.keys(changes).length > 0 ? { changes } : {}),
      ...(Array.isArray(row.changedFields)
        ? {
            changedFields: [
              ...new Set(
                row.changedFields.filter(
                  (field): field is 'fullName' | 'avatarUrl' =>
                    field === 'fullName' || field === 'avatarUrl',
                ),
              ),
            ],
          }
        : {}),
    };
  }

  private expectedResource(action: string): PlatformAuditResourceType | null {
    if (
      action === 'organization.create' ||
      action === 'platform.organization.metadata.changed'
    )
      return 'ORGANIZATION';
    if (
      action === 'platform.authority.granted' ||
      action === 'platform.authority.revoked'
    )
      return 'PLATFORM_AUTHORITY';
    if (
      action === 'platform.user.status.changed' ||
      action === 'platform.user.profile.updated' ||
      action === 'platform.user.archived'
    )
      return 'USER';
    if (action === 'platform.session.revoked') return 'SESSION';
    if (action === 'platform.sessions.revoked_all') return 'USER';
    if (action === 'ORGANIZATION_MEMBERSHIP_SUSPENDED')
      return 'ORGANIZATION_MEMBERSHIP';
    if (action === 'platform.project.metadata.changed') return 'PROJECT';
    if (action.startsWith('platform.incident.')) return 'INCIDENT';
    if (action === 'platform.job.retry' || action === 'platform.job.cancel')
      return 'JOB';
    return null;
  }

  private safeChanges(row: AuditDocument): Record<
    string,
    {
      from: string | number | boolean | null;
      to: string | number | boolean | null;
    }
  > {
    const result: Record<
      string,
      {
        from: string | number | boolean | null;
        to: string | number | boolean | null;
      }
    > = {};
    const allowed = new Set([
      'name',
      'slug',
      'code',
      'visibility',
      'severity',
      'status',
      'membershipStatus',
      'membershipVersion',
      'invitationStatus',
      'invitationVersion',
    ]);
    const before = row.previous ?? row.before ?? {};
    const after = row.next ?? row.after ?? {};
    for (const key of Object.keys(before)) {
      if (!allowed.has(key) || !(key in after)) continue;
      const from = before[key];
      const to = after[key];
      if (
        (typeof from === 'string' ||
          typeof from === 'number' ||
          typeof from === 'boolean' ||
          from === null) &&
        (typeof to === 'string' ||
          typeof to === 'number' ||
          typeof to === 'boolean' ||
          to === null)
      )
        result[key] = { from, to };
    }
    if (
      typeof row.previousStatus === 'string' &&
      typeof row.newStatus === 'string'
    )
      result.status = { from: row.previousStatus, to: row.newStatus };
    return result;
  }

  private collection() {
    const connection = this.connection;
    if (!connection) throw new Error('Platform audit persistence unavailable');
    return connection
      .useDb(this.auditDatabaseName, { useCache: true })
      .collection<AuditDocument>(IAM_AUDIT_COLLECTION_NAME);
  }
}
