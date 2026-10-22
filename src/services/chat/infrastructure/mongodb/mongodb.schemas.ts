import { Schema } from 'mongoose';
import type { ServiceCollectionDefinition } from './mongodb.types';

export const OUTBOX_COLLECTION = 'outbox_events';

export const outboxSchema = new Schema(
  {
    eventName: { type: String, required: true, index: true },
    aggregateType: { type: String, required: true, index: true },
    aggregateId: { type: String, required: true, index: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ['PENDING', 'PUBLISHED', 'FAILED'],
      default: 'PENDING',
      index: true,
    },
    occurredAt: { type: Date, required: true, default: Date.now },
    publishedAt: Date,
    lastError: String,
  },
  { collection: OUTBOX_COLLECTION, timestamps: true },
);

export const auditSchema = new Schema(
  {
    organizationId: { type: String, index: true },
    projectId: { type: String, index: true },
    actorUserId: { type: String, index: true },
    action: { type: String, required: true, index: true },
    targetResource: { type: String, required: true, index: true },
    targetResourceId: { type: String, required: true, index: true },
    metadata: Schema.Types.Mixed,
    occurredAt: { type: Date, required: true, default: Date.now, index: true },
  },
  { collection: 'audit_logs', timestamps: true },
);

const citationSchema = new Schema(
  {
    knowledgeObjectId: { type: String, required: true },
    versionNumber: { type: Number, required: true },
    title: { type: String, required: true },
    excerpt: { type: String, required: true },
    confidenceScore: { type: Number, required: true, min: 0, max: 1 },
  },
  { _id: false, strict: true },
);

const chatReactionSchema = new Schema(
  {
    emoji: {
      type: String,
      enum: ['👍', '❤️', '😂', '😮', '😢', '🙏'],
      required: true,
    },
    userIds: {
      type: [String],
      required: true,
      validate: {
        validator: (userIds: string[]) => userIds.length <= 50,
        message: 'A room can have at most 50 reaction users.',
      },
    },
  },
  { _id: false, strict: true },
);

const chatMessageAttachmentSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true, maxlength: 255 },
    contentType: { type: String, required: true },
    size: { type: Number, required: true, min: 1 },
    kind: { type: String, enum: ['IMAGE', 'DOCUMENT'], required: true },
    provider: { type: String, enum: ['S3', 'R2'], required: true },
    objectKey: { type: String, required: true },
  },
  { _id: false, strict: true },
);

const chatSchemas: Record<string, Schema> = {
  chat_notifications: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      userId: { type: String, required: true },
      conversationId: { type: Schema.Types.ObjectId, required: true },
      messageId: { type: Schema.Types.ObjectId, required: true },
      senderName: String,
      preview: String,
      createdAt: Date,
      readAt: Date,
    },
    { collection: 'chat_notifications', strict: true },
  ),
  chat_blocks: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      userId: { type: String, required: true },
      targetId: { type: String, required: true },
      createdAt: Date,
    },
    { collection: 'chat_blocks', strict: true },
  ),
  chat_reports: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      conversationId: { type: Schema.Types.ObjectId, required: true },
      reporterId: { type: String, required: true },
      messageId: Schema.Types.ObjectId,
      reason: { type: String, required: true, maxlength: 1000 },
      evidence: Schema.Types.Mixed,
      status: { type: String, enum: ['OPEN', 'RESOLVED'], default: 'OPEN' },
      createdAt: Date,
    },
    { collection: 'chat_reports', strict: true },
  ),
  chat_conversations: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      type: { type: String, enum: ['DIRECT', 'ROOM'], required: true },
      directKey: { type: String },
      creationKey: { type: String },
      title: { type: String, trim: true, maxlength: 80 },
      createdBy: { type: String, required: true },
      lastMessageAt: { type: Date, default: null },
      lastMessageId: { type: Schema.Types.ObjectId, default: null },
      lastMessagePreview: { type: String, default: '' },
      lastMessageSenderId: { type: String, default: null },
      membershipVersion: { type: Number, default: 0 },
      status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
    },
    { collection: 'chat_conversations', timestamps: true, strict: true },
  ),
  chat_members: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      conversationId: { type: Schema.Types.ObjectId, required: true },
      userId: { type: String, required: true },
      displayName: { type: String, required: true },
      searchLabel: { type: String, default: '' },
      avatarUrl: { type: String, default: null },
      role: {
        type: String,
        enum: ['OWNER', 'MANAGER', 'MEMBER'],
        required: true,
      },
      status: { type: String, enum: ['ACTIVE', 'LEFT'], default: 'ACTIVE' },
      lastReadMessageId: { type: Schema.Types.ObjectId, default: null },
      lastReadAt: { type: Date, default: null },
      readRecordedAt: { type: Date, default: null },
      lastDeliveredMessageId: { type: Schema.Types.ObjectId, default: null },
      lastDeliveredAt: { type: Date, default: null },
      deliveredRecordedAt: { type: Date, default: null },
      notificationMode: {
        type: String,
        enum: ['ALL', 'MENTIONS', 'NONE'],
        default: 'ALL',
      },
      isPinned: { type: Boolean, default: false },
      isArchived: { type: Boolean, default: false },
      markedUnread: { type: Boolean, default: false },
      draft: { type: String, default: '', maxlength: 8000 },
      draftMentionUserIds: { type: [String], default: [] },
      draftUpdatedAt: { type: Date, default: null },
      joinedAt: { type: Date, required: true, default: Date.now },
    },
    { collection: 'chat_members', timestamps: true, strict: true },
  ),
  chat_conversation_messages: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      conversationId: { type: Schema.Types.ObjectId, required: true },
      senderId: { type: String, required: true },
      senderName: { type: String, required: true },
      senderAvatarUrl: { type: String, default: null },
      clientMessageId: { type: String, required: true },
      content: { type: String, required: true, maxlength: 8000 },
      mentionUserIds: { type: [String], default: [] },
      links: { type: [String], default: [] },
      isPinned: { type: Boolean, default: false },
      forwardedFrom: { senderName: String },
      forwardSourceId: Schema.Types.ObjectId,
      forwardSourceConversationId: Schema.Types.ObjectId,
      editedAt: { type: Date, default: null },
      deletedAt: { type: Date, default: null },
      reactions: { type: [chatReactionSchema], default: [] },
      replyToMessageId: { type: Schema.Types.ObjectId, default: null },
      attachments: { type: [chatMessageAttachmentSchema], default: [] },
    },
    {
      collection: 'chat_conversation_messages',
      timestamps: true,
      strict: true,
    },
  ),
  chat_uploads: new Schema(
    {
      uploadId: { type: String, required: true },
      organizationId: { type: Schema.Types.ObjectId, required: true },
      conversationId: { type: Schema.Types.ObjectId, required: true },
      uploaderId: { type: String, required: true },
      name: { type: String, required: true, maxlength: 255 },
      contentType: { type: String, required: true },
      size: { type: Number, required: true, min: 1 },
      kind: { type: String, enum: ['IMAGE', 'DOCUMENT'], required: true },
      provider: { type: String, enum: ['S3', 'R2'], required: true },
      objectKey: { type: String, required: true },
      status: {
        type: String,
        enum: ['PENDING', 'READY', 'ATTACHED'],
        default: 'PENDING',
      },
      expiresAt: { type: Date, required: true },
    },
    { collection: 'chat_uploads', timestamps: true, strict: true },
  ),
  chat_sessions: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      userId: { type: String, required: true },
      title: { type: String, required: true },
      contextScope: {
        type: String,
        enum: ['PROJECT', 'TEAM', 'MODULE'],
        required: true,
      },
      targetTeamId: Schema.Types.ObjectId,
      status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], required: true },
      messageCount: { type: Number, default: 0 },
      lastMessageAt: { type: Date, required: true },
    },
    { collection: 'chat_sessions', timestamps: true, strict: true },
  ),
  chat_messages: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      chatSessionId: { type: Schema.Types.ObjectId, required: true },
      role: {
        type: String,
        enum: ['USER', 'ASSISTANT', 'SYSTEM'],
        required: true,
      },
      content: { type: String, required: true },
      status: {
        type: String,
        enum: ['COMPLETED', 'INSUFFICIENT_EVIDENCE', 'FAILED'],
        required: true,
      },
      citations: { type: [citationSchema], default: [] },
      retrievalLatencyMs: Number,
      llmLatencyMs: Number,
      tokensPrompt: Number,
      tokensCompletion: Number,
      modelName: String,
    },
    { collection: 'chat_messages', timestamps: true, strict: true },
  ),
  chat_feedbacks: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      messageId: { type: Schema.Types.ObjectId, required: true },
      userId: { type: String, required: true },
      rating: {
        type: String,
        enum: ['THUMBS_UP', 'THUMBS_DOWN'],
        required: true,
      },
      reasonCategory: {
        type: String,
        enum: ['INACCURATE', 'OUTDATED', 'IRRELEVANT_CITATION', 'INCOMPLETE'],
      },
      userCorrectionText: String,
    },
    { collection: 'chat_feedbacks', timestamps: true, strict: true },
  ),
  query_logs: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      userId: { type: String, required: true },
      userQuery: { type: String, required: true },
      normalizedQuery: { type: String, required: true },
      hasInsufficientEvidence: { type: Boolean, required: true },
      intentDetected: String,
    },
    { collection: 'query_logs', timestamps: true, strict: true },
  ),
  retrieval_logs: new Schema(
    {
      queryLogId: { type: Schema.Types.ObjectId, required: true },
      vectorTopK: { type: Number, required: true },
      highestSimilarityScore: { type: Number, required: true },
      lowestSimilarityScore: { type: Number, required: true },
      sagCandidateChunkIds: { type: [String], default: [] },
    },
    { collection: 'retrieval_logs', timestamps: true, strict: true },
  ),
};

export function createCollectionSchema(
  definition: ServiceCollectionDefinition,
): Schema {
  const schema =
    chatSchemas[definition.name] ?? new Schema({}, { strict: true });
  schema.set('collection', definition.name);

  for (const index of definition.indexes ?? []) {
    schema.index(index.fields, index.options);
  }

  return schema;
}
