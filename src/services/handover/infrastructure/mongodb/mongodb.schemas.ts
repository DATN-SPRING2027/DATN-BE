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

const learningPathStepSchema = new Schema(
  {
    stepOrder: { type: Number, required: true },
    knowledgeObjectId: { type: String, required: true },
    estimatedMinutes: { type: Number, required: true },
    isMandatory: { type: Boolean, required: true },
    isCompleted: { type: Boolean, default: false },
    completedAt: Date,
  },
  { _id: false, strict: true },
);

const handoverSchemas: Record<string, Schema> = {
  responsibilities: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      teamId: Schema.Types.ObjectId,
      name: { type: String, required: true },
      code: { type: String, required: true },
      description: { type: String, required: true },
      criticality: {
        type: String,
        enum: ['LOW', 'MEDIUM', 'HIGH', 'MISSION_CRITICAL'],
        required: true,
      },
      requiredDocumentationStatus: {
        type: String,
        enum: ['SATISFIED', 'DEFICIENT'],
        required: true,
      },
      currentPrimaryOwnerId: String,
    },
    { collection: 'responsibilities', timestamps: true, strict: true },
  ),
  responsibility_assignments: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      responsibilityId: { type: Schema.Types.ObjectId, required: true },
      userId: { type: String, required: true },
      assignmentType: {
        type: String,
        enum: ['PRIMARY_OWNER', 'BACKUP_OWNER', 'INTERN_LEARNER'],
        required: true,
      },
      effectiveFrom: { type: Date, required: true },
      effectiveTo: Date,
      assignedBy: { type: String, required: true },
    },
    {
      collection: 'responsibility_assignments',
      timestamps: true,
      strict: true,
    },
  ),
  handovers: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      departingUserId: { type: String, required: true },
      targetCompletionDate: { type: Date, required: true },
      status: {
        type: String,
        enum: [
          'PLANNED',
          'IN_PROGRESS',
          'READY_FOR_VERIFICATION',
          'COMPLETED',
          'OVERDUE',
        ],
        required: true,
      },
      completionPercent: { type: Number, min: 0, max: 100, default: 0 },
      assignedLeaderId: { type: String, required: true },
      completedAt: Date,
    },
    { collection: 'handovers', timestamps: true, strict: true },
  ),
  handover_items: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      handoverId: { type: Schema.Types.ObjectId, required: true },
      responsibilityId: Schema.Types.ObjectId,
      knowledgeObjectId: String,
      title: { type: String, required: true },
      description: { type: String, required: true },
      itemType: {
        type: String,
        enum: [
          'DOCUMENT',
          'CREDENTIAL_TRANSFER',
          'RUNBOOK_DEMO',
          'CODE_WALKTHROUGH',
        ],
        required: true,
      },
      successorUserId: { type: String, required: true },
      status: {
        type: String,
        enum: [
          'PENDING',
          'IN_PROGRESS',
          'SUBMITTED',
          'VERIFIED_BY_SUCCESSOR',
          'REJECTED',
        ],
        required: true,
      },
      successorVerifiedAt: Date,
      successorNotes: String,
    },
    { collection: 'handover_items', timestamps: true, strict: true },
  ),
  interviews: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      handoverId: Schema.Types.ObjectId,
      intervieweeUserId: { type: String, required: true },
      interviewerUserId: { type: String, required: true },
      topic: { type: String, required: true },
      status: {
        type: String,
        enum: [
          'SCHEDULED',
          'RECORDED',
          'TRANSCRIBED',
          'EXTRACTED_TO_PROPOSALS',
        ],
        required: true,
      },
    },
    { collection: 'interviews', timestamps: true, strict: true },
  ),
  interview_sessions: new Schema(
    {
      interviewId: { type: Schema.Types.ObjectId, required: true },
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      audioR2ObjectKey: { type: String, required: true },
      audioDurationSeconds: { type: Number, required: true },
      mimeType: { type: String, required: true },
      transcriptionStatus: {
        type: String,
        enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'],
        required: true,
      },
      transcriptText: String,
      extractedKeyPoints: { type: [String], default: [] },
    },
    { collection: 'interview_sessions', timestamps: true, strict: true },
  ),
  learning_paths: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      learnerUserId: { type: String, required: true },
      handoverId: Schema.Types.ObjectId,
      title: { type: String, required: true },
      steps: { type: [learningPathStepSchema], default: [] },
      status: { type: String, enum: ['ACTIVE', 'COMPLETED'], required: true },
      progressPercent: { type: Number, min: 0, max: 100, default: 0 },
    },
    { collection: 'learning_paths', timestamps: true, strict: true },
  ),
  follow_up_tasks: new Schema(
    {
      handoverId: { type: Schema.Types.ObjectId, required: true },
      successorUserId: { type: String, required: true },
      title: { type: String, required: true },
      checkInMilestoneDays: {
        type: Number,
        enum: [30, 60, 90],
        required: true,
      },
      dueDate: { type: Date, required: true },
      isAcknowledged: { type: Boolean, default: false },
    },
    { collection: 'follow_up_tasks', timestamps: true, strict: true },
  ),
};

export function createCollectionSchema(
  definition: ServiceCollectionDefinition,
): Schema {
  const schema =
    handoverSchemas[definition.name] ?? new Schema({}, { strict: true });
  schema.set('collection', definition.name);

  for (const index of definition.indexes ?? []) {
    schema.index(index.fields, index.options);
  }

  return schema;
}
