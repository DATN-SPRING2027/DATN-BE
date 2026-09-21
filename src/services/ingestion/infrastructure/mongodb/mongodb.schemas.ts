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

const ingestionSchemas: Record<string, Schema> = {
  documents: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      fileName: { type: String, required: true },
      mimeType: { type: String, required: true },
      fileSizeBytes: { type: Number, required: true, min: 0 },
      checksumSha256: { type: String, required: true },
      sourceType: {
        type: String,
        enum: ['LOCAL_UPLOAD', 'GOOGLE_DRIVE', 'CONFLUENCE', 'GIT_REPO'],
        required: true,
      },
      r2ObjectKey: { type: String, required: true },
      uploadedBy: { type: String, required: true },
      currentVersionNumber: { type: Number, default: 1 },
      status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], required: true },
    },
    { collection: 'documents', timestamps: true, strict: true },
  ),
  document_versions: new Schema(
    {
      documentId: { type: Schema.Types.ObjectId, required: true },
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      versionNumber: { type: Number, required: true },
      r2ObjectKey: { type: String, required: true },
      parseStatus: {
        type: String,
        enum: ['QUEUED', 'EXTRACTING', 'EXTRACTED', 'FAILED'],
        required: true,
      },
      parserUsed: { type: String, enum: ['MARKITDOWN', 'MINERU'] },
      pageCount: Number,
      extractedTextLength: Number,
      rawTextR2Key: String,
      errorMessage: String,
      parsedAt: Date,
    },
    { collection: 'document_versions', timestamps: true, strict: true },
  ),
  ingestion_jobs: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      documentId: { type: Schema.Types.ObjectId, required: true },
      documentVersionId: { type: Schema.Types.ObjectId, required: true },
      jobType: {
        type: String,
        enum: ['PARSE_DOCUMENT', 'AUDIO_TRANSCRIPTION', 'SAG_INDEXING'],
        required: true,
      },
      bullMqJobId: { type: String, required: true },
      status: {
        type: String,
        enum: ['WAITING', 'ACTIVE', 'COMPLETED', 'FAILED', 'RETRYING'],
        required: true,
      },
      progressPercent: { type: Number, min: 0, max: 100, default: 0 },
      attemptsCount: { type: Number, default: 0 },
      maxRetries: { type: Number, default: 3 },
      startedAt: Date,
      completedAt: Date,
      errorMessage: String,
    },
    { collection: 'ingestion_jobs', timestamps: true, strict: true },
  ),
  sag_mappings: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      sourceType: {
        type: String,
        enum: ['KNOWLEDGE_VERSION', 'DOCUMENT_VERSION', 'WORK_NOTE'],
        required: true,
      },
      sourceRecordId: { type: String, required: true },
      sagDocumentId: { type: String, required: true },
      sagChunkId: { type: String, required: true },
      sagEventId: String,
      chunkIndex: { type: Number, required: true },
      charStartOffset: { type: Number, required: true },
      charEndOffset: { type: Number, required: true },
    },
    { collection: 'sag_mappings', timestamps: true, strict: true },
  ),
  file_upload_tickets: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      userId: { type: String, required: true },
      fileName: { type: String, required: true },
      fileSizeBytes: { type: Number, required: true, min: 0 },
      mimeType: { type: String, required: true },
      checksumSha256: { type: String, required: true },
      presignedPutUrl: { type: String, required: true },
      r2ObjectKey: { type: String, required: true },
      isUsed: { type: Boolean, default: false },
      expiresAt: { type: Date, required: true },
    },
    { collection: 'file_upload_tickets', timestamps: true, strict: true },
  ),
};

export function createCollectionSchema(
  definition: ServiceCollectionDefinition,
): Schema {
  const schema =
    ingestionSchemas[definition.name] ?? new Schema({}, { strict: true });
  schema.set('collection', definition.name);

  for (const index of definition.indexes ?? []) {
    schema.index(index.fields, index.options);
  }

  return schema;
}
