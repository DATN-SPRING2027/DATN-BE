import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { ClientSession, Connection } from 'mongoose';
import { HANDOVER_PERSISTENCE } from '../persistence';

export interface OutboxEventInput {
  eventName: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class OutboxService {
  constructor(
    @InjectConnection(HANDOVER_PERSISTENCE.databaseName)
    private readonly connection: Connection,
  ) {}

  async append(
    event: OutboxEventInput,
    session?: ClientSession,
  ): Promise<void> {
    const now = new Date();
    await this.connection.collection('outbox_events').insertOne(
      {
        ...event,
        status: 'PENDING',
        occurredAt: now,
        createdAt: now,
        updatedAt: now,
      },
      session ? { session } : undefined,
    );
  }
}
