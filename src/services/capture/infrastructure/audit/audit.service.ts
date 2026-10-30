import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { ClientSession, Connection } from 'mongoose';
import { AUDIT_DATABASE_NAME } from '../../../../common/mongodb/database-names';

export interface AuditEventInput {
  organizationId?: string;
  projectId?: string;
  actorUserId?: string;
  action: string;
  targetResource: string;
  targetResourceId: string;
  metadata?: Record<string, unknown>;
}

export interface AuditEventRecord extends AuditEventInput {
  id: string;
  occurredAt: Date;
}

@Injectable()
export class AuditService {
  constructor(
    @InjectConnection('audit') private readonly connection: Connection,
  ) {}

  async listForTarget(
    filter: {
      organizationId: string;
      projectId: string;
      targetResource: string;
      targetResourceId: string;
    },
    limit = 100,
  ): Promise<AuditEventRecord[]> {
    try {
      if (!this.connection) return [];
      const rows = await this.connection
        .collection('audit_logs')
        .find({
          organizationId: filter.organizationId,
          projectId: filter.projectId,
          targetResource: filter.targetResource,
          targetResourceId: filter.targetResourceId,
        })
        .sort({ occurredAt: 1, _id: 1 })
        .limit(Math.max(1, Math.min(250, limit)))
        .toArray();
      return rows.map((row) => ({
        id: String(row._id),
        organizationId:
          typeof row.organizationId === 'string'
            ? row.organizationId
            : undefined,
        projectId:
          typeof row.projectId === 'string' ? row.projectId : undefined,
        actorUserId:
          typeof row.actorUserId === 'string' ? row.actorUserId : undefined,
        action: String(row.action ?? ''),
        targetResource: String(row.targetResource ?? ''),
        targetResourceId: String(row.targetResourceId ?? ''),
        ...(row.metadata && typeof row.metadata === 'object'
          ? { metadata: row.metadata as Record<string, unknown> }
          : {}),
        occurredAt:
          row.occurredAt instanceof Date
            ? row.occurredAt
            : new Date(String(row.occurredAt ?? Date.now())),
      }));
    } catch {
      return [];
    }
  }

  async append(event: AuditEventInput, session?: ClientSession): Promise<void> {
    const record = {
      ...event,
      occurredAt: new Date(),
    };
    const sessionClient = (
      session as unknown as {
        client?: {
          db: (name: string) => {
            collection: (collectionName: string) => {
              insertOne: (
                doc: Record<string, unknown>,
                options?: { session?: ClientSession },
              ) => Promise<unknown>;
            };
          };
        };
      }
    )?.client;
    if (session && sessionClient) {
      const dbName = this.connection?.name || AUDIT_DATABASE_NAME;
      await sessionClient
        .db(dbName)
        .collection('audit_logs')
        .insertOne(record, { session });
      return;
    }
    await this.connection
      .collection('audit_logs')
      .insertOne(record, session ? { session } : undefined);
  }
}
