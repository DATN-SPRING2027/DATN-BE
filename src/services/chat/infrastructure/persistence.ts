import { SERVICE_DATABASES } from '../../../common/mongodb/database-names';
import type { ServicePersistenceDefinition } from './mongodb/mongodb.types';
import type { QueueName } from './queues/queue.names';

const index = (
  fields: Record<string, 1 | -1 | 'text'>,
  options?: {
    unique?: boolean;
    sparse?: boolean;
    expireAfterSeconds?: number;
    name?: string;
  },
) => ({ fields, options });

export const CHAT_PERSISTENCE: ServicePersistenceDefinition = {
  serviceName: 'chat',
  databaseName: SERVICE_DATABASES.chat,
  collections: [
    {
      name: 'chat_notifications',
      indexes: [
        index({ organizationId: 1, userId: 1, createdAt: -1, _id: -1 }),
        index({ organizationId: 1, userId: 1, messageId: 1 }, { unique: true }),
      ],
    },
    {
      name: 'chat_blocks',
      indexes: [
        index({ organizationId: 1, userId: 1, targetId: 1 }, { unique: true }),
      ],
    },
    {
      name: 'chat_reports',
      indexes: [
        index({ organizationId: 1, status: 1, createdAt: -1, _id: -1 }),
      ],
    },
    {
      name: 'chat_conversations',
      indexes: [
        index({ directKey: 1 }, { unique: true, sparse: true }),
        index({ creationKey: 1 }, { unique: true, sparse: true }),
        index({ organizationId: 1, status: 1, lastMessageAt: -1, _id: -1 }),
      ],
    },
    {
      name: 'chat_members',
      indexes: [
        index({ conversationId: 1, userId: 1 }, { unique: true }),
        index({ userId: 1, organizationId: 1, status: 1, conversationId: 1 }),
      ],
    },
    {
      name: 'chat_conversation_messages',
      indexes: [
        index({ conversationId: 1, createdAt: -1, _id: -1 }),
        index(
          { conversationId: 1, content: 'text' },
          { name: 'chat_message_text_search' },
        ),
        index(
          { conversationId: 1, senderId: 1, clientMessageId: 1 },
          { unique: true },
        ),
      ],
    },
    {
      name: 'chat_uploads',
      indexes: [
        index({ uploadId: 1 }, { unique: true }),
        index({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      ],
    },
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
