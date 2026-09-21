import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

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

  async append(event: AuditEventInput): Promise<void> {
    await this.connection.collection('audit_logs').insertOne({
      ...event,
      occurredAt: new Date(),
    });
  }
}
