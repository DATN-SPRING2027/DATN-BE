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

const chatSchemas: Record<string, Schema> = {
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
