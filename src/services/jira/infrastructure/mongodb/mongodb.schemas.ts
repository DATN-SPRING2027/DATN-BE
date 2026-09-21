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

const jiraSchemas: Record<string, Schema> = {
  jira_connections: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      atlassianSiteId: { type: String, required: true },
      atlassianUrl: { type: String, required: true },
      authType: { type: String, enum: ['OAUTH2', 'API_TOKEN'], required: true },
      credentialsEncrypted: { type: String, required: true },
      webhookSecret: { type: String, required: true },
      status: {
        type: String,
        enum: ['CONNECTED', 'EXPIRED', 'REVOKED'],
        required: true,
      },
      lastSyncAt: Date,
      createdBy: { type: Schema.Types.ObjectId, required: true },
    },
    { collection: 'jira_connections', timestamps: true, strict: true },
  ),
  jira_account_links: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      userId: { type: String, required: true },
      atlassianAccountId: { type: String, required: true },
      jiraDisplayName: { type: String, required: true },
      jiraEmail: String,
      isVerified: { type: Boolean, default: false },
    },
    { collection: 'jira_account_links', timestamps: true, strict: true },
  ),
  jira_issues: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      jiraConnectionId: { type: Schema.Types.ObjectId, required: true },
      issueId: { type: String, required: true },
      issueKey: { type: String, required: true },
      summary: { type: String, required: true },
      descriptionText: String,
      issueType: {
        type: String,
        enum: ['STORY', 'BUG', 'TASK', 'EPIC', 'SUBTASK'],
        required: true,
      },
      status: { type: String, required: true },
      statusCategory: {
        type: String,
        enum: ['TO_DO', 'IN_PROGRESS', 'DONE'],
        required: true,
      },
      assigneeAtlassianId: String,
      reporterAtlassianId: String,
      labels: { type: [String], default: [] },
      components: { type: [String], default: [] },
      storyPoints: Number,
      resolvedAt: Date,
      lastSyncedAt: { type: Date, required: true },
    },
    { collection: 'jira_issues', timestamps: true, strict: true },
  ),
  jira_events: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      eventId: { type: String, required: true },
      eventType: { type: String, required: true },
      issueKey: { type: String, required: true },
      payload: { type: Schema.Types.Mixed, required: true },
      processingStatus: {
        type: String,
        enum: ['PENDING', 'PROCESSED', 'FAILED', 'IGNORED'],
        required: true,
      },
      errorMessage: String,
      processedAt: Date,
      receivedAt: { type: Date, required: true },
    },
    { collection: 'jira_events', strict: true },
  ),
  jira_sync_jobs: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      connectionId: { type: Schema.Types.ObjectId, required: true },
      jqlQuery: { type: String, required: true },
      totalIssuesFound: { type: Number, default: 0 },
      issuesSyncedCount: { type: Number, default: 0 },
      status: {
        type: String,
        enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED'],
        required: true,
      },
      startedAt: Date,
      completedAt: Date,
      errorLog: { type: [String], default: [] },
    },
    { collection: 'jira_sync_jobs', timestamps: true, strict: true },
  ),
};

export function createCollectionSchema(
  definition: ServiceCollectionDefinition,
): Schema {
  const schema =
    jiraSchemas[definition.name] ?? new Schema({}, { strict: true });
  schema.set('collection', definition.name);

  for (const index of definition.indexes ?? []) {
    schema.index(index.fields, index.options);
  }

  return schema;
}
