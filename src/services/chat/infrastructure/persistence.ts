import type { ServicePersistenceDefinition } from './mongodb/mongodb.types';
import type { QueueName } from './queues/queue.names';

const index = (
  fields: Record<string, 1 | -1>,
  options?: { unique?: boolean; expireAfterSeconds?: number },
) => ({ fields, options });

export const CHAT_PERSISTENCE: ServicePersistenceDefinition = {
  databaseName: 'continuum_chat',
  collections: [
    {
      name: 'chat_sessions',
      indexes: [
        index({
          organizationId: 1,
          projectId: 1,
          userId: 1,
          status: 1,
          lastMessageAt: 1,
        }),
      ],
    },
    {
      name: 'chat_messages',
      indexes: [
        index({ chatSessionId: 1, createdAt: 1 }),
        index({ organizationId: 1, projectId: 1, status: 1, createdAt: 1 }),
      ],
    },
    {
      name: 'chat_feedbacks',
      indexes: [
        index({ messageId: 1, userId: 1 }, { unique: true }),
        index({ organizationId: 1, rating: 1, createdAt: 1 }),
      ],
    },
    {
      name: 'query_logs',
      indexes: [
        index({
          organizationId: 1,
          projectId: 1,
          hasInsufficientEvidence: 1,
          createdAt: 1,
        }),
      ],
    },
    { name: 'retrieval_logs', indexes: [index({ queryLogId: 1 })] },
  ],
};

export const CHAT_QUEUES: QueueName[] = [];
