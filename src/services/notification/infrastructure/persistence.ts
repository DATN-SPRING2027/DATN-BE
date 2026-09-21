import type { ServicePersistenceDefinition } from './mongodb/mongodb.types';
import type { QueueName } from './queues/queue.names';

const index = (
  fields: Record<string, 1 | -1>,
  options?: { unique?: boolean; expireAfterSeconds?: number },
) => ({ fields, options });

export const NOTIFICATION_PERSISTENCE: ServicePersistenceDefinition = {
  databaseName: 'continuum_notification',
  collections: [
    {
      name: 'notifications',
      indexes: [index({ recipientUserId: 1, isRead: 1, createdAt: 1 })],
    },
    {
      name: 'notification_preferences',
      indexes: [index({ userId: 1, organizationId: 1 }, { unique: true })],
    },
    {
      name: 'notification_templates',
      indexes: [index({ templateCode: 1, channel: 1 }, { unique: true })],
    },
    {
      name: 'email_delivery_logs',
      indexes: [
        index({ recipientEmail: 1, createdAt: 1 }),
        index({ deliveryStatus: 1, createdAt: 1 }),
      ],
    },
  ],
};

export const NOTIFICATION_QUEUES: QueueName[] = [
  'mail-queue',
  'dlq-failed-jobs',
];
