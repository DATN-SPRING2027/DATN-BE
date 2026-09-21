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

const iamSchemas: Record<string, Schema> = {
  users: new Schema(
    {
      email: { type: String, required: true, lowercase: true, trim: true },
      passwordHash: { type: String, required: true },
      fullName: { type: String, required: true, trim: true },
      avatarUrl: String,
      status: {
        type: String,
        enum: ['ACTIVE', 'SUSPENDED', 'PENDING_INVITE'],
        required: true,
      },
      twoFactorEnabled: { type: Boolean, default: false },
      twoFactorSecretEncrypted: String,
      lastLoginAt: Date,
    },
    { collection: 'users', timestamps: true, strict: true },
  ),
  organizations: new Schema(
    {
      name: { type: String, required: true, trim: true },
      slug: { type: String, required: true, lowercase: true, trim: true },
      plan: { type: String, enum: ['FREE', 'ENTERPRISE'], required: true },
      settings: Schema.Types.Mixed,
    },
    { collection: 'organizations', timestamps: true, strict: true },
  ),
  projects: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      name: { type: String, required: true, trim: true },
      code: { type: String, required: true, uppercase: true, trim: true },
      description: String,
      status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], required: true },
      createdBy: { type: Schema.Types.ObjectId, required: true },
    },
    { collection: 'projects', timestamps: true, strict: true },
  ),
  teams: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      name: { type: String, required: true, trim: true },
      code: { type: String, required: true, uppercase: true, trim: true },
      description: String,
    },
    { collection: 'teams', timestamps: true, strict: true },
  ),
  project_memberships: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      userId: { type: Schema.Types.ObjectId, required: true },
      status: { type: String, enum: ['ACTIVE', 'INACTIVE'], required: true },
      joinedAt: { type: Date, required: true },
    },
    { collection: 'project_memberships', strict: true },
  ),
  team_memberships: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      teamId: { type: Schema.Types.ObjectId, required: true },
      userId: { type: Schema.Types.ObjectId, required: true },
      joinedAt: { type: Date, required: true },
    },
    { collection: 'team_memberships', strict: true },
  ),
  roles: new Schema(
    {
      code: {
        type: String,
        enum: ['ADMIN', 'TEAM_LEADER', 'MEMBER'],
        required: true,
      },
      name: { type: String, required: true },
      permissions: { type: [String], default: [] },
      isSystem: { type: Boolean, default: true },
    },
    { collection: 'roles', strict: true },
  ),
  role_assignments: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: Schema.Types.ObjectId,
      userId: { type: Schema.Types.ObjectId, required: true },
      roleId: { type: Schema.Types.ObjectId, required: true },
      roleCode: {
        type: String,
        enum: ['ADMIN', 'TEAM_LEADER', 'MEMBER'],
        required: true,
      },
      assignedBy: { type: Schema.Types.ObjectId, required: true },
    },
    { collection: 'role_assignments', timestamps: true, strict: true },
  ),
  organization_capability_grants: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      userId: { type: Schema.Types.ObjectId, required: true },
      capability: { type: String, enum: ['project.create'], required: true },
      grantedBy: { type: Schema.Types.ObjectId, required: true },
      reason: { type: String, required: true },
      expiresAt: Date,
      revokedAt: Date,
    },
    {
      collection: 'organization_capability_grants',
      timestamps: true,
      strict: true,
    },
  ),
  refresh_sessions: new Schema(
    {
      userId: { type: Schema.Types.ObjectId, required: true },
      organizationId: { type: Schema.Types.ObjectId, required: true },
      tokenHash: { type: String, required: true },
      ipAddress: String,
      userAgent: String,
      isRevoked: { type: Boolean, default: false },
      expiresAt: { type: Date, required: true },
    },
    { collection: 'refresh_sessions', timestamps: true, strict: true },
  ),
  sme_assignments: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      userId: { type: Schema.Types.ObjectId, required: true },
      domainModule: { type: String, required: true },
      assignedBy: { type: Schema.Types.ObjectId, required: true },
      effectiveFrom: { type: Date, required: true },
      effectiveTo: Date,
    },
    { collection: 'sme_assignments', timestamps: true, strict: true },
  ),
  knowledge_owner_assignments: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      projectId: { type: Schema.Types.ObjectId, required: true },
      userId: { type: Schema.Types.ObjectId, required: true },
      knowledgeObjectId: Schema.Types.ObjectId,
      assignedBy: { type: Schema.Types.ObjectId, required: true },
      effectiveFrom: { type: Date, required: true },
      effectiveTo: Date,
    },
    {
      collection: 'knowledge_owner_assignments',
      timestamps: true,
      strict: true,
    },
  ),
};

export function createCollectionSchema(
  definition: ServiceCollectionDefinition,
): Schema {
  const schema =
    iamSchemas[definition.name] ?? new Schema({}, { strict: true });
  schema.set('collection', definition.name);

  for (const index of definition.indexes ?? []) {
    schema.index(index.fields, index.options);
  }

  return schema;
}
