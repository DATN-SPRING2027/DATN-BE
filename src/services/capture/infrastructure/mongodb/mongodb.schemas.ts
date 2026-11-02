import { Schema } from 'mongoose';
import type { ServiceCollectionDefinition } from './mongodb.types';
import {
  validPrivateAssessmentState,
  withinAbsoluteDraftLifetime,
} from './work-note-assessment-state.validation';

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

export const WORK_REPORT_SCOPES = ['MEMBER', 'LEADER'] as const;

export const WORK_REPORT_CADENCE_FREQUENCIES = [
  'DAILY',
  'EVERY_2_DAYS',
  'EVERY_3_DAYS',
  'EVERY_4_DAYS',
  'EVERY_5_DAYS',
  'EVERY_6_DAYS',
  'WEEKLY',
] as const;

export const WORK_REPORT_REVIEW_ACTIONS = [
  'APPROVED',
  'CHANGES_REQUESTED',
  'REJECTED',
] as const;

const workReportReviewHistoryEntrySchema = new Schema(
  {
    action: {
      type: String,
      enum: [...WORK_REPORT_REVIEW_ACTIONS],
      required: true,
    },
    reviewerId: { type: String, required: true },
    reviewerRole: {
      type: String,
      enum: ['MANAGER', 'LEADER'],
    },
    comment: { type: String, maxlength: 5000 },
    at: { type: Date, required: true },
  },
  { _id: false, strict: true },
);

const workReportSettingHistoryEntrySchema = new Schema(
  {
    frequency: {
      type: String,
      enum: [...WORK_REPORT_CADENCE_FREQUENCIES],
      required: true,
    },
    effectiveAt: { type: Date, required: true },
    updatedBy: { type: String, required: true },
  },
  { _id: false, strict: true },
);

const captureSchemas: Record<string, Schema> = {
  work_note_agent_drafts: new Schema(
    {
      _id: { type: String, required: true },
      workflow: {
        type: String,
        enum: ['TASK_NOTE', 'PROJECT_DOCUMENT', 'WORK_REPORT'],
        default: 'TASK_NOTE',
      },
      resourceId: {
        type: Schema.Types.ObjectId,
        validate: {
          validator: function (this: { workflow?: string }, value: unknown) {
            return (
              this.workflow === 'PROJECT_DOCUMENT' ||
              this.workflow === 'WORK_REPORT' ||
              value == null
            );
          },
          message: 'Task Notes use Task/note identity only',
        },
        required: function (this: { workflow?: string }) {
          return this.workflow === 'WORK_REPORT';
        },
      },
      context: Schema.Types.Mixed,
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      taskId: {
        type: Schema.Types.ObjectId,
        required: function (this: { workflow?: string }) {
          return !this.workflow || this.workflow === 'TASK_NOTE';
        },
        validate: {
          validator: function (this: { workflow?: string }, value: unknown) {
            return (
              !this.workflow || this.workflow === 'TASK_NOTE' || value == null
            );
          },
          message: 'Only Task Notes may carry a Task identity',
        },
      },
      ownerUserId: { type: Schema.Types.ObjectId, required: true },
      noteId: {
        type: Schema.Types.ObjectId,
        validate: {
          validator: function (this: { workflow?: string }, value: unknown) {
            return (
              !this.workflow || this.workflow === 'TASK_NOTE' || value == null
            );
          },
          message: 'Only Task Notes may carry a Task note identity',
        },
      },
      revision: { type: Number, min: 1, required: true },
      baseNoteVersion: { type: Number, min: 0, required: true },
      state: {
        type: Schema.Types.Mixed,
        required: true,
        validate: {
          validator: function (
            this: { workflow?: string; expiresAt?: Date; createdAt?: Date },
            value: unknown,
          ) {
            return validPrivateAssessmentState(
              value,
              this.workflow,
              this.expiresAt,
              this.createdAt,
            );
          },
          message:
            'Assessment must remain versioned private Task Note draft state',
        },
      },
      expiresAt: {
        type: Date,
        required: true,
        validate: {
          validator: function (this: { createdAt?: Date }, value: Date) {
            return withinAbsoluteDraftLifetime(value, this.createdAt);
          },
          message:
            'Private draft retention cannot exceed its original 24-hour lifetime',
        },
      },
      inferenceOperationId: String,
      inferenceLeaseUntil: Date,
    },
    { collection: 'work_note_agent_drafts', timestamps: true, strict: true },
  ),
  work_note_agent_operations: new Schema(
    {
      _id: { type: String, required: true },
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      ownerUserId: { type: Schema.Types.ObjectId, required: true },
      draftId: { type: String, required: true },
      payloadHash: { type: String, required: true },
      status: {
        type: String,
        enum: ['PENDING', 'COMPLETED', 'FAILED'],
        required: true,
      },
      result: Schema.Types.Mixed,
      failureCode: String,
      expiresAt: { type: Date, required: true },
    },
    {
      collection: 'work_note_agent_operations',
      timestamps: true,
      strict: true,
    },
  ),
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
      contentMarkdown: {
        type: String,
        maxlength: 30000,
        required: function (this: { contentSchemaVersion?: number }) {
          return this.contentSchemaVersion === 2;
        },
      },
      contentSchemaVersion: { type: Number, enum: [2] },
      currentVersionNumber: {
        type: Number,
        min: 1,
        required: function (this: { contentSchemaVersion?: number }) {
          return this.contentSchemaVersion === 2;
        },
      },
      provenance: Schema.Types.Mixed,
      whatDone: {
        type: String,
        required: function (this: { contentSchemaVersion?: number }) {
          return this.contentSchemaVersion !== 2;
        },
      },
      howSolved: {
        type: String,
        required: function (this: { contentSchemaVersion?: number }) {
          return this.contentSchemaVersion !== 2;
        },
      },
      whyThisWay: {
        type: String,
        required: function (this: { contentSchemaVersion?: number }) {
          return this.contentSchemaVersion !== 2;
        },
      },
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
      contentMarkdown: {
        type: String,
        maxlength: 30000,
        required: function (this: { contentSchemaVersion?: number }) {
          return this.contentSchemaVersion === 2;
        },
      },
      contentSchemaVersion: { type: Number, enum: [2] },
      provenance: Schema.Types.Mixed,
      whatDone: {
        type: String,
        required: function (this: { contentSchemaVersion?: number }) {
          return this.contentSchemaVersion !== 2;
        },
      },
      howSolved: {
        type: String,
        required: function (this: { contentSchemaVersion?: number }) {
          return this.contentSchemaVersion !== 2;
        },
      },
      whyThisWay: {
        type: String,
        required: function (this: { contentSchemaVersion?: number }) {
          return this.contentSchemaVersion !== 2;
        },
      },
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
      editorVersionNumber: { type: Number, min: 0 },
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
      knowledgeSync: Schema.Types.Mixed,
    },
    { collection: 'project_documents', timestamps: true, strict: true },
  ),
  project_document_versions: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      documentId: { type: Schema.Types.ObjectId, required: true },
      versionNumber: { type: Number, required: true, min: 1 },
      provenance: Schema.Types.Mixed,
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
        sha256: { type: String, maxlength: 64 },
      },
      knowledgeSync: Schema.Types.Mixed,
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
      reminderEmailLeaseToken: String,
      reminderEmailDueAt: Date,
      reminderEmailSentAt: Date,
      reminderEmailLeaseUntil: Date,
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      memberUserId: { type: Schema.Types.ObjectId, required: true },
      title: {
        type: String,
        maxlength: 300,
        required: function (this: { contentSchemaVersion?: number }) {
          return this.contentSchemaVersion === 2;
        },
      },
      contentMarkdown: {
        type: String,
        maxlength: 30000,
        required: function (this: { contentSchemaVersion?: number }) {
          return this.contentSchemaVersion === 2;
        },
      },
      contentSchemaVersion: { type: Number, enum: [2] },
      currentVersionNumber: {
        type: Number,
        min: 1,
        required: function (this: { contentSchemaVersion?: number }) {
          return this.contentSchemaVersion === 2;
        },
      },
      provenance: Schema.Types.Mixed,
      reportScope: {
        type: String,
        enum: [...WORK_REPORT_SCOPES],
        default: 'MEMBER',
        required: true,
      },
      frequency: {
        type: String,
        enum: [...WORK_REPORT_CADENCE_FREQUENCIES],
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
      documentIds: { type: [String], default: [] },
      file: {
        key: String,
        name: String,
        contentType: {
          type: String,
          enum: [...SUPPORTED_DOCUMENT_CONTENT_TYPES],
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
          'OVERDUE',
        ],
        required: true,
      },
      submittedAt: Date,
      reviewedByUserId: Schema.Types.ObjectId,
      reviewedAt: Date,
      reviewComment: { type: String, maxlength: 5000 },
      reviewHistory: {
        type: [workReportReviewHistoryEntrySchema],
        default: [],
      },
    },
    { collection: 'work_reports', timestamps: true, strict: true },
  ),
  work_report_versions: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      reportId: { type: Schema.Types.ObjectId, required: true },
      versionNumber: { type: Number, min: 1, required: true },
      title: { type: String, required: true, maxlength: 300 },
      contentMarkdown: { type: String, required: true, maxlength: 30000 },
      canonicalResult: { type: Schema.Types.Mixed, required: true },
      editedByUserId: { type: Schema.Types.ObjectId, required: true },
      provenance: Schema.Types.Mixed,
    },
    { collection: 'work_report_versions', timestamps: true, strict: true },
  ),
  project_document_editor_versions: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      documentId: { type: Schema.Types.ObjectId, required: true },
      versionNumber: { type: Number, min: 1, required: true },
      documentVersionNumber: { type: Number, min: 1, required: true },
      title: { type: String, required: true, maxlength: 240 },
      contentMarkdown: { type: String, default: '', maxlength: 30000 },
      canonicalResult: { type: Schema.Types.Mixed, required: true },
      editedByUserId: { type: Schema.Types.ObjectId, required: true },
      provenance: Schema.Types.Mixed,
    },
    {
      collection: 'project_document_editor_versions',
      timestamps: true,
      strict: true,
    },
  ),
  work_report_settings: new Schema(
    {
      memberReminderLeadMinutes: {
        type: Number,
        enum: [null, 60, 120, 1440, 2880],
        default: null,
      },
      leaderReminderLeadMinutes: {
        type: Number,
        enum: [null, 60, 120, 1440, 2880],
        default: null,
      },
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      reportScope: {
        type: String,
        enum: [...WORK_REPORT_SCOPES],
        default: 'MEMBER',
        required: true,
      },
      frequency: {
        type: String,
        enum: [...WORK_REPORT_CADENCE_FREQUENCIES],
        required: true,
      },
      effectiveAt: { type: Date, required: true },
      nextFrequency: {
        type: String,
        enum: [...WORK_REPORT_CADENCE_FREQUENCIES],
      },
      nextEffectiveAt: Date,
      createdByUserId: { type: Schema.Types.ObjectId, required: true },
      updatedByUserId: Schema.Types.ObjectId,
      history: {
        type: [workReportSettingHistoryEntrySchema],
        default: [],
      },
      leaderFrequency: {
        type: String,
        enum: [...WORK_REPORT_CADENCE_FREQUENCIES],
      },
      leaderEffectiveAt: Date,
      leaderUpdatedByUserId: Schema.Types.ObjectId,
      leaderHistory: {
        type: [workReportSettingHistoryEntrySchema],
        default: [],
      },
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
