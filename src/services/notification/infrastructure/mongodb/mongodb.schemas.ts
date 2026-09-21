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

const notificationSchemas: Record<string, Schema> = {
  notifications: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: Schema.Types.ObjectId,
      recipientUserId: { type: String, required: true },
      type: {
        type: String,
        enum: [
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
      body: { type: String, required: true },
      actionUrl: { type: String, required: true },
      isRead: { type: Boolean, default: false },
      readAt: Date,
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
