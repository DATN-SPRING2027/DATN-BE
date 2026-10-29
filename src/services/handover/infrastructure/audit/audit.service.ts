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

@Injectable()
export class AuditService {
  constructor(
    @InjectConnection('audit') private readonly connection: Connection,
  ) {}

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
