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

const lifecycleSchemas: Record<string, Schema> = {
  knowledge_objects: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      teamId: Schema.Types.ObjectId,
      title: { type: String, required: true },
      slug: { type: String, required: true },
      type: {
        type: String,
        enum: [
          'ARCHITECTURE_DECISION',
          'RUNBOOK',
          'BUSINESS_RULE',
          'API_CONTRACT',
          'TROUBLESHOOTING',
        ],
        required: true,
      },
      status: {
        type: String,
        enum: ['DRAFT', 'IN_REVIEW', 'VERIFIED', 'DEPRECATED', 'OBSOLETE'],
        required: true,
      },
      currentVersionId: Schema.Types.ObjectId,
      currentVersionNumber: { type: Number, default: 0 },
      ownerUserId: { type: String, required: true },
      smeUserId: String,
      tags: { type: [String], default: [] },
      confidentiality: {
        type: String,
        enum: ['INTERNAL', 'RESTRICTED', 'PUBLIC'],
        required: true,
      },
    },
    { collection: 'knowledge_objects', timestamps: true, strict: true },
  ),
  knowledge_proposals: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      teamId: Schema.Types.ObjectId,
      proposalType: {
        type: String,
        enum: ['CREATE_NEW', 'UPDATE_EXISTING'],
        required: true,
      },
      targetKnowledgeObjectId: Schema.Types.ObjectId,
      title: { type: String, required: true },
      proposedContentMarkdown: { type: String, required: true },
      category: {
        type: String,
        enum: [
          'ARCHITECTURE_DECISION',
          'RUNBOOK',
          'BUSINESS_RULE',
          'API_CONTRACT',
          'TROUBLESHOOTING',
        ],
        required: true,
      },
      tags: { type: [String], default: [] },
      sourceType: {
        type: String,
        enum: [
          'WORK_NOTE',
          'JIRA_ISSUE',
          'DOCUMENT',
          'AUDIO_INTERVIEW',
          'HUMAN_DIRECT',
        ],
        required: true,
      },
      sourceRefId: { type: String, required: true },
      suggestedByUserId: String,
      reviewStatus: {
        type: String,
        enum: ['PENDING', 'APPROVED', 'REJECTED', 'REQUEST_CHANGES'],
        required: true,
      },
      reviewerUserId: String,
      reviewNotes: String,
      reviewedAt: Date,
    },
    { collection: 'knowledge_proposals', timestamps: true, strict: true },
  ),
  knowledge_versions: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      knowledgeObjectId: { type: Schema.Types.ObjectId, required: true },
      versionNumber: { type: Number, required: true },
      title: { type: String, required: true },
      contentMarkdown: { type: String, required: true },
      summary: String,
      supersedesVersionId: Schema.Types.ObjectId,
      changeLog: String,
      evidenceIds: { type: [Schema.Types.ObjectId], default: [] },
      publishedBy: { type: String, required: true },
      publishedAt: { type: Date, required: true },
    },
    { collection: 'knowledge_versions', timestamps: true, strict: true },
  ),
  knowledge_evidence: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      knowledgeObjectId: { type: Schema.Types.ObjectId, required: true },
      knowledgeVersionId: Schema.Types.ObjectId,
      evidenceType: {
        type: String,
        enum: [
          'DOCUMENT_VERSION',
          'WORK_NOTE',
          'JIRA_ISSUE',
          'AUDIO_TRANSCRIPT',
          'GIT_COMMIT',
        ],
        required: true,
      },
      sourceRefId: { type: String, required: true },
      sourceUri: String,
      excerpt: { type: String, required: true },
      confidenceScore: { type: Number, min: 0, max: 1 },
      verifiedByUserId: { type: String, required: true },
      verifiedAt: { type: Date, required: true },
    },
    { collection: 'knowledge_evidence', timestamps: true, strict: true },
  ),
  knowledge_verifications: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      knowledgeObjectId: { type: Schema.Types.ObjectId, required: true },
      proposalId: Schema.Types.ObjectId,
      decision: {
        type: String,
        enum: ['VERIFIED', 'REJECTED', 'REQUEST_CHANGE'],
        required: true,
      },
      decisionByUserId: { type: String, required: true },
      decisionRole: {
        type: String,
        enum: ['SME', 'TEAM_LEADER', 'ADMIN'],
        required: true,
      },
      comments: { type: String, required: true },
    },
    { collection: 'knowledge_verifications', timestamps: true, strict: true },
  ),
  knowledge_gaps: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      teamId: Schema.Types.ObjectId,
      responsibilityCode: String,
      title: { type: String, required: true },
      description: { type: String, required: true },
      severity: {
        type: String,
        enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
        required: true,
      },
      status: {
        type: String,
        enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'IGNORED'],
        required: true,
      },
      assignedToUserId: String,
      resolvedByKnowledgeObjectId: Schema.Types.ObjectId,
      resolvedAt: Date,
    },
    { collection: 'knowledge_gaps', timestamps: true, strict: true },
  ),
  knowledge_conflicts: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      knowledgeObjectIdA: { type: Schema.Types.ObjectId, required: true },
      knowledgeObjectIdB: { type: Schema.Types.ObjectId, required: true },
      description: { type: String, required: true },
      status: {
        type: String,
        enum: ['UNRESOLVED', 'RESOLVED'],
        required: true,
      },
      resolvedByUserId: String,
      resolutionSummary: String,
      resolvedAt: Date,
    },
    { collection: 'knowledge_conflicts', timestamps: true, strict: true },
  ),
  knowledge_relations: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      sourceKnowledgeObjectId: { type: Schema.Types.ObjectId, required: true },
      targetKnowledgeObjectId: { type: Schema.Types.ObjectId, required: true },
      relationType: {
        type: String,
        enum: ['DEPENDS_ON', 'EXTENDS', 'SUPERSEDES', 'RELATED_TO'],
        required: true,
      },
      createdBy: { type: String, required: true },
    },
    { collection: 'knowledge_relations', timestamps: true, strict: true },
  ),
};

export function createCollectionSchema(
  definition: ServiceCollectionDefinition,
): Schema {
  const schema =
    lifecycleSchemas[definition.name] ?? new Schema({}, { strict: true });
  schema.set('collection', definition.name);

  for (const index of definition.indexes ?? []) {
    schema.index(index.fields, index.options);
  }

  return schema;
}
