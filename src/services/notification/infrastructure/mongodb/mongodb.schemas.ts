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

export const NOTIFICATION_MVP_TYPES = [
  'ORGANIZATION_MEMBER_INVITED',
  'ORGANIZATION_MEMBER_ADDED',
  'ORGANIZATION_MEMBER_REMOVED',
  'PROJECT_MEMBER_ADDED',
  'PROJECT_MEMBER_REMOVED',
  'PROJECT_LEADER_ASSIGNED',
  'PROJECT_LEADER_CHANGED',
  'PROJECT_LEADER_REVOKED',
  'TASK_ASSIGNED',
  'TASK_DEADLINE_APPROACHING',
  'TASK_DEADLINE_OVERDUE',
  'WORK_NOTE_MENTION',
  'CHAT_MENTION',
] as const;

export type NotificationMvpType = (typeof NOTIFICATION_MVP_TYPES)[number];

export const NOTIFICATION_TARGET_KINDS = [
  'ORGANIZATION',
  'PROJECT',
  'TASK',
  'WORK_NOTE',
  'CHAT',
] as const;

export type NotificationTargetKind = (typeof NOTIFICATION_TARGET_KINDS)[number];

const notificationTargetSchema = new Schema(
  {
    kind: {
      type: String,
      enum: [...NOTIFICATION_TARGET_KINDS],
      required: true,
    },
    url: { type: String, required: true },
    organizationId: { type: String, default: null },
    projectId: { type: String, default: null },
    taskId: { type: String, default: null },
    noteId: { type: String, default: null },
    conversationId: { type: String, default: null },
    messageId: { type: String, default: null },
  },
  { _id: false, strict: true },
);

const notificationSchemas: Record<string, Schema> = {
  notifications: new Schema(
    {
      recipientId: { type: String, required: true },
      recipientUserId: { type: String, default: null },
      actorId: { type: String, default: null },
      organizationId: { type: String, default: null },
      projectId: { type: String, default: null },
      taskId: { type: String, default: null },
      noteId: { type: String, default: null },
      conversationId: { type: String, default: null },
      type: {
        type: String,
        enum: [
          ...NOTIFICATION_MVP_TYPES,
          'VERIFICATION_REQUEST',
          'VERIFICATION_APPROVED',
          'VERIFICATION_REJECTED',
          'HANDOVER_ASSIGNED',
          'HANDOVER_DUE_REMINDER',
          'KNOWLEDGE_GAP_DETECTED',
          'KNOWLEDGE_CONFLICT_ALERT',
        ],
        required: true,
      },
      title: { type: String, required: true },
      message: { type: String, required: true },
      body: { type: String, default: '' },
      actionUrl: { type: String, default: '' },
      target: { type: notificationTargetSchema, default: null },
      eventKey: { type: String, required: true },
      isRead: { type: Boolean, default: false },
      readAt: { type: Date, default: null },
    },
    { collection: 'notifications', timestamps: true, strict: true },
  ),
  notification_preferences: new Schema(
    {
      userId: { type: String, required: true },
      organizationId: { type: Schema.Types.ObjectId, required: true },
      emailEnabled: { type: Boolean, default: true },
      inAppEnabled: { type: Boolean, default: true },
      notifyOnVerificationRequest: { type: Boolean, default: true },
      notifyOnVerificationDecision: { type: Boolean, default: true },
      notifyOnHandoverDue: { type: Boolean, default: true },
      notifyOnKnowledgeGap: { type: Boolean, default: true },
      emailFrequency: {
        type: String,
        enum: ['INSTANT', 'DAILY_DIGEST', 'WEEKLY_DIGEST', 'OFF'],
        required: true,
      },
    },
    { collection: 'notification_preferences', timestamps: true, strict: true },
  ),
  notification_templates: new Schema(
    {
      templateCode: { type: String, required: true },
      channel: { type: String, enum: ['IN_APP', 'EMAIL'], required: true },
      subjectTemplate: String,
      bodyTemplate: { type: String, required: true },
      variablesRequired: { type: [String], default: [] },
      isSystem: { type: Boolean, default: false },
    },
    { collection: 'notification_templates', timestamps: true, strict: true },
  ),
  email_delivery_logs: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      recipientEmail: { type: String, required: true, lowercase: true },
      recipientUserId: String,
      templateCode: { type: String, required: true },
      subject: { type: String, required: true },
      deliveryStatus: {
        type: String,
        enum: ['QUEUED', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED'],
        required: true,
      },
      provider: {
        type: String,
        enum: ['RESEND', 'SENDGRID', 'SMTP'],
        required: true,
      },
      providerMessageId: String,
      attempts: { type: Number, default: 0 },
      errorMessage: String,
      sentAt: Date,
    },
    { collection: 'email_delivery_logs', timestamps: true, strict: true },
  ),
};

export function createCollectionSchema(
  definition: ServiceCollectionDefinition,
): Schema {
  const schema =
    notificationSchemas[definition.name] ?? new Schema({}, { strict: true });
  schema.set('collection', definition.name);

  for (const index of definition.indexes ?? []) {
    schema.index(index.fields, index.options);
  }

  return schema;
}
