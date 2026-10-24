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

export const SUPPORTED_DOCUMENT_CONTENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'application/yaml',
  'application/xml',
  'application/sql',
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

const captureSchemas: Record<string, Schema> = {
  work_notes: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      taskId: { type: Schema.Types.ObjectId, required: true },
      teamId: Schema.Types.ObjectId,
      authorUserId: { type: Schema.Types.ObjectId, required: true },
      authorName: { type: String, maxlength: 200 },
      type: { type: String, enum: ['TASK_NOTE'], default: 'TASK_NOTE' },
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
      category: { type: String, default: 'Decision' },
      taskKey: String,
      blocker: String,
      unfinished: String,
      nextStep: String,
      pinned: { type: Boolean, default: false },
      mentionUserIds: { type: [String], default: [] },
      deletedAt: { type: Date, default: null },
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
  project_documents: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      title: { type: String, required: true, trim: true, maxlength: 240 },
      description: { type: String, maxlength: 2000 },
      documentType: {
        type: String,
        enum: [
          'MVP',
          'DATABASE_DESIGN',
          'RSR',
          'ARCHITECTURE',
          'API_SPECIFICATION',
          'RESEARCH',
          'REQUIREMENT',
          'DESIGN',
          'TECHNICAL_SPECIFICATION',
          'OTHER',
        ],
        required: true,
      },
      createdByUserId: { type: Schema.Types.ObjectId, required: true },
      currentVersionNumber: { type: Number, required: true, min: 1 },
      latestApprovedVersionNumber: { type: Number, min: 1 },
      status: {
        type: String,
        enum: [
          'DRAFT',
          'PENDING_REVIEW',
          'APPROVED',
          'CHANGES_REQUESTED',
          'REJECTED',
          'ARCHIVED',
        ],
        required: true,
      },
      updatedByUserId: { type: Schema.Types.ObjectId, required: true },
    },
    { collection: 'project_documents', timestamps: true, strict: true },
  ),
  project_document_versions: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      documentId: { type: Schema.Types.ObjectId, required: true },
      versionNumber: { type: Number, required: true, min: 1 },
      title: { type: String, required: true, trim: true, maxlength: 240 },
      description: { type: String, maxlength: 2000 },
      documentType: { type: String, required: true },
      content: { type: String, default: '', maxlength: 200000 },
      file: {
        key: { type: String, maxlength: 300 },
        name: { type: String, maxlength: 180 },
        contentType: {
          type: String,
          enum: SUPPORTED_DOCUMENT_CONTENT_TYPES,
        },
        size: { type: Number, min: 1, max: 20 * 1024 * 1024 },
      },
      status: {
        type: String,
        enum: [
          'DRAFT',
          'PENDING_REVIEW',
          'APPROVED',
          'CHANGES_REQUESTED',
          'REJECTED',
          'ARCHIVED',
        ],
        required: true,
      },
      editedByUserId: { type: Schema.Types.ObjectId, required: true },
      submittedAt: Date,
      reviewedByUserId: Schema.Types.ObjectId,
      reviewedAt: Date,
      reviewComment: { type: String, maxlength: 5000 },
      reviewHistory: { type: [Schema.Types.Mixed], default: [] },
    },
    { collection: 'project_document_versions', timestamps: true, strict: true },
  ),
  work_reports: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      memberUserId: { type: Schema.Types.ObjectId, required: true },
      frequency: {
        type: String,
        enum: ['DAILY', 'EVERY_3_DAYS', 'WEEKLY'],
        required: true,
      },
      periodStart: { type: Date, required: true },
      periodEnd: { type: Date, required: true },
      dueAt: { type: Date, required: true },
      accomplishments: { type: String, default: '', maxlength: 10000 },
      approach: { type: String, default: '', maxlength: 10000 },
      reason: { type: String, default: '', maxlength: 5000 },
      blockers: { type: String, default: '', maxlength: 5000 },
      nextSteps: { type: String, default: '', maxlength: 5000 },
      status: {
        type: String,
        enum: [
          'DRAFT',
          'PENDING_REVIEW',
          'APPROVED',
          'CHANGES_REQUESTED',
          'REJECTED',
          'OVERDUE',
        ],
        required: true,
      },
      submittedAt: Date,
      reviewedByUserId: Schema.Types.ObjectId,
      reviewedAt: Date,
      reviewComment: { type: String, maxlength: 5000 },
      reviewHistory: { type: [Schema.Types.Mixed], default: [] },
    },
    { collection: 'work_reports', timestamps: true, strict: true },
  ),
  work_report_settings: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      frequency: {
        type: String,
        enum: ['DAILY', 'EVERY_3_DAYS', 'WEEKLY'],
        required: true,
      },
      effectiveAt: { type: Date, required: true },
      createdByUserId: { type: Schema.Types.ObjectId, required: true },
    },
    { collection: 'work_report_settings', timestamps: true, strict: true },
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
