import { EventEmitter } from 'node:events';
import { Injectable, Logger } from '@nestjs/common';
import type { NotificationItemDto } from './notification-center.types';

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
    } catch (error) {
      this.logger.warn(
        `Realtime notification read-all sync failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
