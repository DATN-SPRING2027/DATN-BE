import { Schema } from 'mongoose';
import type { ServiceCollectionDefinition } from './mongodb.types';

export const OUTBOX_COLLECTION = 'outbox_events';
export const CHAT_ASSISTANT_JOBS_COLLECTION = 'chat_assistant_jobs';
export const CONTINUUM_AI_SENDER_ID = 'assistant:continuum_ai';
export const CONTINUUM_AI_DISPLAY_NAME = 'Continuum AI';
export const CONTINUUM_AI_HANDLE = 'continuumAI';

export const CHAT_MESSAGE_AUTHOR_TYPES = ['USER', 'ASSISTANT'] as const;
export const CHAT_ASSISTANT_MESSAGE_STATUSES = [
  'PENDING',
  'COMPLETED',
  'INSUFFICIENT_EVIDENCE',
  'CANCELLED',
  'FAILED',
] as const;
export const CHAT_ASSISTANT_JOB_STATUSES = [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'INSUFFICIENT_EVIDENCE',
  'CANCELLED',
  'FAILED',
] as const;
export const CHAT_ASSISTANT_FAILURE_CODES = [
  'SOURCE_CHANGED',
  'TRIGGER_DELETED',
  'ACCESS_REVOKED',
  'SERVICE_UNAVAILABLE',
  'TIMEOUT',
  'INVALID_MODEL_OUTPUT',
] as const;
export const CHAT_ASSISTANT_QUERY_MODES = [
  'TIME_WINDOW',
  'KEYWORD',
  'HYBRID',
] as const;

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

const isOptionalInteger = (value: number | null | undefined): boolean =>
  value == null || Number.isInteger(value);

const chatAssistantMentionSchema = new Schema(
  {
    handle: { type: String, enum: [CONTINUUM_AI_HANDLE], required: true },
    query: { type: String, required: true, minlength: 1, maxlength: 2000 },
    timezone: { type: String, required: true, minlength: 1, maxlength: 64 },
  },
  { _id: false, strict: true },
);

const chatAssistantMetaSchema = new Schema(
  {
    handle: { type: String, enum: [CONTINUUM_AI_HANDLE], required: true },
    queryMode: {
      type: String,
      enum: [...CHAT_ASSISTANT_QUERY_MODES],
      required: true,
    },
    partialCoverage: { type: Boolean, required: true, default: false },
    coverageNote: { type: String, maxlength: 500, default: null },
    model: { type: String, maxlength: 120, default: null },
    promptTokens: {
      type: Number,
      min: 0,
      default: null,
      validate: {
        validator: isOptionalInteger,
        message: 'promptTokens must be an integer.',
      },
    },
    completionTokens: {
      type: Number,
      min: 0,
      default: null,
      validate: {
        validator: isOptionalInteger,
        message: 'completionTokens must be an integer.',
      },
    },
  },
  { _id: false, strict: true },
);

const chatAssistantSourceReferenceSchema = new Schema(
  {
    refId: {
      type: String,
      required: true,
      match: /^M[1-9][0-9]{0,2}$/,
    },
    messageId: { type: Schema.Types.ObjectId, required: true },
    senderName: { type: String, required: true, minlength: 1, maxlength: 120 },
    createdAt: { type: Date, required: true },
    sourceEditedAt: { type: Date, default: null },
    sourceVersion: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'sourceVersion must be an integer.',
      },
    },
    quoteSnippet: {
      type: String,
      default: '',
      maxlength: 200,
      validate: {
        validator: (value: unknown) => typeof value === 'string',
        message: 'quoteSnippet must be a string.',
      },
    },
  },
  { _id: false, strict: true },
);

const chatAssistantJobMetricsSchema = new Schema(
  {
    queryMode: {
      type: String,
      enum: [...CHAT_ASSISTANT_QUERY_MODES, null],
      default: null,
    },
    retrievalPath: { type: String, maxlength: 64, default: null },
    candidateCount: {
      type: Number,
      min: 0,
      default: null,
      validate: {
        validator: isOptionalInteger,
        message: 'candidateCount must be an integer.',
      },
    },
    sentSnippetCount: {
      type: Number,
      min: 0,
      default: null,
      validate: {
        validator: isOptionalInteger,
        message: 'sentSnippetCount must be an integer.',
      },
    },
    citedCount: {
      type: Number,
      min: 0,
      default: null,
      validate: {
        validator: isOptionalInteger,
        message: 'citedCount must be an integer.',
      },
    },
    partialCoverage: { type: Boolean, default: null },
    retrievalLatencyMs: {
      type: Number,
      min: 0,
      default: null,
      validate: {
        validator: isOptionalInteger,
        message: 'retrievalLatencyMs must be an integer.',
      },
    },
    sagLatencyMs: {
      type: Number,
      min: 0,
      default: null,
      validate: {
        validator: isOptionalInteger,
        message: 'sagLatencyMs must be an integer.',
      },
    },
    totalLatencyMs: {
      type: Number,
      min: 0,
      default: null,
      validate: {
        validator: isOptionalInteger,
        message: 'totalLatencyMs must be an integer.',
      },
    },
  },
  { _id: false, strict: true },
);

const chatConversationMessagesSchema = new Schema(
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
    contentVersion: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'contentVersion must be an integer.',
      },
    },
    authorType: {
      type: String,
      enum: [...CHAT_MESSAGE_AUTHOR_TYPES],
      default: undefined,
    },
    assistantMention: { type: chatAssistantMentionSchema, default: undefined },
    triggerMessageId: { type: Schema.Types.ObjectId, default: undefined },
    assistantStatus: {
      type: String,
      enum: [...CHAT_ASSISTANT_MESSAGE_STATUSES],
      default: undefined,
    },
    assistantFailureCode: {
      type: String,
      enum: [...CHAT_ASSISTANT_FAILURE_CODES, null],
      default: undefined,
    },
    assistantMeta: { type: chatAssistantMetaSchema, default: undefined },
    sourceReferences: {
      type: [chatAssistantSourceReferenceSchema],
      default: undefined,
      validate: {
        validator: (value: unknown[] | undefined) =>
          value === undefined || value.length <= 20,
        message: 'An assistant message can have at most 20 source references.',
      },
    },
  },
  {
    collection: 'chat_conversation_messages',
    timestamps: true,
    strict: true,
  },
);

chatConversationMessagesSchema.pre('validate', function () {
  const doc = this as {
    authorType?: string;
    senderId?: string;
    triggerMessageId?: unknown;
    assistantStatus?: unknown;
    assistantFailureCode?: unknown;
    assistantMeta?: unknown;
    assistantMention?: unknown;
    sourceReferences?: unknown;
    invalidate: (path: string, errorMsg: string) => void;
  };
  if (doc.authorType === 'ASSISTANT') {
    if (doc.senderId !== CONTINUUM_AI_SENDER_ID) {
      doc.invalidate(
        'senderId',
        `ASSISTANT messages must use senderId=${CONTINUUM_AI_SENDER_ID}.`,
      );
    }
    if (doc.triggerMessageId == null) {
      doc.invalidate(
        'triggerMessageId',
        'triggerMessageId is required for ASSISTANT messages.',
      );
    }
    if (doc.assistantStatus == null) {
      doc.invalidate(
        'assistantStatus',
        'assistantStatus is required for ASSISTANT messages.',
      );
    }
    if (!Array.isArray(doc.sourceReferences)) {
      doc.invalidate(
        'sourceReferences',
        'sourceReferences array is required for ASSISTANT messages.',
      );
    }
    if (doc.assistantMention != null) {
      doc.invalidate(
        'assistantMention',
        'assistantMention is not allowed on ASSISTANT messages.',
      );
    }
    return;
  }

  if (doc.senderId === CONTINUUM_AI_SENDER_ID) {
    doc.invalidate(
      'authorType',
      `Messages with senderId=${CONTINUUM_AI_SENDER_ID} must set authorType=ASSISTANT.`,
    );
  }
  if (doc.triggerMessageId != null) {
    doc.invalidate(
      'triggerMessageId',
      'triggerMessageId is not allowed on USER messages.',
    );
  }
  if (doc.sourceReferences !== undefined) {
    doc.invalidate(
      'sourceReferences',
      'sourceReferences must be omitted on USER messages.',
    );
  }
  if (doc.assistantStatus !== undefined) {
    doc.invalidate(
      'assistantStatus',
      'assistantStatus must be omitted on USER messages.',
    );
  }
  if (doc.assistantMeta !== undefined) {
    doc.invalidate(
      'assistantMeta',
      'assistantMeta must be omitted on USER messages.',
    );
  }
  if (doc.assistantFailureCode !== undefined) {
    doc.invalidate(
      'assistantFailureCode',
      'assistantFailureCode must be omitted on USER messages.',
    );
  }
});

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
      contextRevision: {
        type: Number,
        default: 0,
        min: 0,
        validate: {
          validator: Number.isInteger,
          message: 'contextRevision must be an integer.',
        },
      },
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
      draftAssistantMention: { type: Boolean, default: false },
      draftUpdatedAt: { type: Date, default: null },
      joinedAt: { type: Date, required: true, default: Date.now },
    },
    { collection: 'chat_members', timestamps: true, strict: true },
  ),
  chat_conversation_messages: chatConversationMessagesSchema,
  [CHAT_ASSISTANT_JOBS_COLLECTION]: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      conversationId: { type: Schema.Types.ObjectId, required: true },
      triggerMessageId: { type: Schema.Types.ObjectId, required: true },
      requesterUserId: {
        type: String,
        required: true,
        match: /^[a-fA-F0-9]{24}$/,
      },
      requesterDisplayName: {
        type: String,
        required: true,
        minlength: 1,
        maxlength: 120,
      },
      handle: {
        type: String,
        enum: [CONTINUUM_AI_HANDLE],
        required: true,
        default: CONTINUUM_AI_HANDLE,
      },
      query: { type: String, required: true, minlength: 1, maxlength: 2000 },
      timezone: {
        type: String,
        required: true,
        minlength: 1,
        maxlength: 64,
        default: 'Asia/Ho_Chi_Minh',
      },
      status: {
        type: String,
        enum: [...CHAT_ASSISTANT_JOB_STATUSES],
        required: true,
        default: 'PENDING',
      },
      failureCode: {
        type: String,
        enum: [...CHAT_ASSISTANT_FAILURE_CODES, null],
        default: null,
      },
      failureReason: { type: String, maxlength: 300, default: null },
      attempts: {
        type: Number,
        required: true,
        default: 0,
        min: 0,
        validate: {
          validator: Number.isInteger,
          message: 'attempts must be an integer.',
        },
      },
      maxAttempts: {
        type: Number,
        required: true,
        default: 3,
        min: 1,
        max: 5,
        validate: {
          validator: Number.isInteger,
          message: 'maxAttempts must be an integer.',
        },
      },
      nextAttemptAt: { type: Date, required: true, default: Date.now },
      lockedBy: { type: String, maxlength: 160, default: null },
      lockedUntil: { type: Date, default: null },
      responseMessageId: { type: Schema.Types.ObjectId, default: null },
      metrics: { type: chatAssistantJobMetricsSchema, default: null },
      completedAt: { type: Date, default: null },
    },
    {
      collection: CHAT_ASSISTANT_JOBS_COLLECTION,
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
  const baseSchema = chatSchemas[definition.name];
  const schema = baseSchema
    ? baseSchema.clone()
    : new Schema({}, { strict: true });
  schema.set('collection', definition.name);

  for (const index of definition.indexes ?? []) {
    schema.index(
      index.fields,
      index.options ? { ...index.options } : undefined,
    );
  }

  return schema;
}
