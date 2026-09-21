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

const captureSchemas: Record<string, Schema> = {
  work_notes: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      teamId: Schema.Types.ObjectId,
      authorUserId: { type: Schema.Types.ObjectId, required: true },
      jiraIssueId: String,
      jiraIssueKey: String,
      gitCommitHash: String,
      title: { type: String, required: true },
      whatDone: { type: String, required: true },
      howSolved: { type: String, required: true },
      whyThisWay: { type: String, required: true },
      status: {
        type: String,
        enum: ['DRAFT', 'CONFIRMED', 'ARCHIVED'],
        required: true,
      },
      authorConfirmedAt: Date,
      tags: { type: [String], default: [] },
      timeSpentMinutes: Number,
      promotedToProposalId: String,
    },
    { collection: 'work_notes', timestamps: true, strict: true },
  ),
  work_note_versions: new Schema(
    {
      workNoteId: { type: Schema.Types.ObjectId, required: true },
      versionNumber: { type: Number, required: true },
      title: { type: String, required: true },
      whatDone: { type: String, required: true },
      howSolved: { type: String, required: true },
      whyThisWay: { type: String, required: true },
      editedByUserId: { type: Schema.Types.ObjectId, required: true },
    },
    { collection: 'work_note_versions', timestamps: true, strict: true },
  ),
  capture_drafts: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      userId: { type: Schema.Types.ObjectId, required: true },
      contextKey: { type: String, required: true },
      draftContent: {
        title: String,
        whatDone: String,
        howSolved: String,
        whyThisWay: String,
        tags: { type: [String], default: [] },
      },
      lastSavedAt: { type: Date, required: true },
    },
    { collection: 'capture_drafts', strict: true },
  ),
  work_note_templates: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: Schema.Types.ObjectId,
      name: { type: String, required: true },
      roleScope: {
        type: String,
        enum: ['FRONTEND', 'BACKEND', 'DEVOPS', 'QA', 'GENERAL'],
        required: true,
      },
      defaultWhatDonePrompt: { type: String, required: true },
      defaultHowSolvedPrompt: { type: String, required: true },
      defaultWhyThisWayPrompt: { type: String, required: true },
      suggestedTags: { type: [String], default: [] },
      isDefault: { type: Boolean, default: false },
    },
    { collection: 'work_note_templates', timestamps: true, strict: true },
  ),
  knowledge_requirements: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      teamId: Schema.Types.ObjectId,
      responsibilityCode: String,
      title: { type: String, required: true },
      category: {
        type: String,
        enum: [
          'ARCHITECTURE',
          'DEPLOYMENT',
          'RUNBOOK',
          'SECURITY',
          'API_CONTRACT',
        ],
        required: true,
      },
      priority: {
        type: String,
        enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
        required: true,
      },
      status: {
        type: String,
        enum: ['UNFULFILLED', 'PARTIALLY_FULFILLED', 'FULFILLED'],
        required: true,
      },
      fulfilledByKnowledgeObjectId: String,
      createdBy: { type: Schema.Types.ObjectId, required: true },
    },
    { collection: 'knowledge_requirements', timestamps: true, strict: true },
  ),
};

export function createCollectionSchema(
  definition: ServiceCollectionDefinition,
): Schema {
  const schema =
    captureSchemas[definition.name] ?? new Schema({}, { strict: true });
  schema.set('collection', definition.name);

  for (const index of definition.indexes ?? []) {
    schema.index(index.fields, index.options);
  }

  return schema;
}
