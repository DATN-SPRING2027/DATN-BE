import { EventEmitter } from 'node:events';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { context, propagation } from '@opentelemetry/api';
import type { NotificationItemDto } from './notification-center.types';

export const NOTIFICATION_REALTIME_PUBLISHER = Symbol(
  'NOTIFICATION_REALTIME_PUBLISHER',
);
export const NOTIFICATION_REALTIME_CHANNEL = 'notification.realtime.v1';
export function notificationRealtimeChannel(
  prefix = process.env.BULLMQ_PREFIX ?? 'continuum',
): string {
  return `${prefix}:${NOTIFICATION_REALTIME_CHANNEL}`;
}

export interface NotificationRealtimePublisher {
  publish(channel: string, value: string): Promise<void>;
}

export type NotificationRealtimePayload = Readonly<{
  organizationId: string | null;
  recipientIds: readonly string[];
  event: 'notification.created' | 'notification.read' | 'notification.read_all';
  data: unknown;
}>;

const globalNotificationEmitter = new EventEmitter();
globalNotificationEmitter.setMaxListeners(50);

@Injectable()
export class NotificationRealtimeBus {
  private readonly logger = new Logger(NotificationRealtimeBus.name);

  constructor(
    @Optional()
    @Inject(NOTIFICATION_REALTIME_PUBLISHER)
    private readonly publisher?: NotificationRealtimePublisher,
  ) {}

  onRealtimeEvent(
    listener: (payload: NotificationRealtimePayload) => void,
  ): () => void {
    globalNotificationEmitter.on('notification.realtime', listener);
    return () => {
      globalNotificationEmitter.off('notification.realtime', listener);
    };
  }

  publishCreated(notification: NotificationItemDto): void {
    try {
      const payload: NotificationRealtimePayload = {
        organizationId: notification.organizationId,
        recipientIds: [notification.recipientId],
        event: 'notification.created',
        data: notification,
      };
      globalNotificationEmitter.emit('notification.realtime', payload);
      this.publishAcrossProcesses(payload);
    } catch (error) {
      this.logger.warn(
        `Realtime notification delivery failed (notification ${notification.id} remains persisted): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  publishRead(input: {
    organizationId: string | null;
    recipientId: string;
    notificationId: string;
    readAt: string;
  }): void {
    try {
      const payload: NotificationRealtimePayload = {
        organizationId: input.organizationId,
        recipientIds: [input.recipientId],
        event: 'notification.read',
        data: {
          id: input.notificationId,
          readAt: input.readAt,
        },
      };
      globalNotificationEmitter.emit('notification.realtime', payload);
      this.publishAcrossProcesses(payload);
    } catch (error) {
      this.logger.warn(
        `Realtime notification read sync failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  publishReadAll(input: {
    organizationId: string | null;
    recipientId: string;
    readAt: string;
  }): void {
    try {
      const payload: NotificationRealtimePayload = {
        organizationId: input.organizationId,
        recipientIds: [input.recipientId],
        event: 'notification.read_all',
        data: {
          readAt: input.readAt,
        },
      };
      globalNotificationEmitter.emit('notification.realtime', payload);
      this.publishAcrossProcesses(payload);
    } catch (error) {
      this.logger.warn(
        `Realtime notification read-all sync failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private publishAcrossProcesses(payload: NotificationRealtimePayload): void {
    if (!this.publisher) return;
    const traceCarrier: Record<string, string> = {};
    propagation.inject(context.active(), traceCarrier);
    const envelope = {
      version: 1,
      payload,
      traceContext: Object.fromEntries(
        Object.entries(traceCarrier).filter(
          ([key, value]) =>
            (key === 'traceparent' || key === 'tracestate') &&
            typeof value === 'string',
        ),
      ),
    };
    void this.publisher
      .publish(notificationRealtimeChannel(), JSON.stringify(envelope))
      .catch((error: unknown) => {
        this.logger.warn(
          `Notification realtime pub/sub failed (durable notification state is unchanged): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }
}
