import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

export interface OutboxEventInput {
  eventName: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class OutboxService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async append(event: OutboxEventInput): Promise<void> {
    await this.connection.collection('outbox_events').insertOne({
      ...event,
      status: 'PENDING',
      occurredAt: new Date(),
    });
  }
}
