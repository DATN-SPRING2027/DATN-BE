import { Schema } from 'mongoose';
import type { ServiceCollectionDefinition } from './mongodb.types';
import {
  membershipInvitationSchema,
  membershipOperationSchema,
  membershipVersion,
  mutationFence,
} from './membership-lifecycle.schemas';
import { teamFoundationSchema } from './team-foundation.schema';

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

export const iamAuditSchema = new Schema(
  {
    organizationId: String,
    projectId: String,
    actorUserId: String,
    action: { type: String, required: true },
    targetResource: { type: String, required: true },
    targetResourceId: { type: String, required: true },
    metadata: Schema.Types.Mixed,
    occurredAt: { type: Date, required: true },
  },
  { collection: 'audit_logs_iam', strict: true },
);

const iamSchemas: Record<string, Schema> = {
  users: new Schema(
    {
      email: { type: String, required: true, lowercase: true, trim: true },
      passwordHash: {
        type: String,
        required: function (this: { googleSubject?: string }) {
          return !this.googleSubject;
        },
      },
      googleSubject: String,
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
      mutationFence: mutationFence(),
    },
    { collection: 'users', timestamps: true, strict: true },
  ),
  organizations: new Schema(
    {
      name: { type: String, required: true, trim: true },
      slug: { type: String, required: true, lowercase: true, trim: true },
      plan: { type: String, enum: ['FREE', 'ENTERPRISE'], required: true },
      settings: Schema.Types.Mixed,
      membershipAdminRevision: mutationFence(),
    },
    { collection: 'organizations', timestamps: true, strict: true },
  ),
  organization_memberships: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      userId: { type: Schema.Types.ObjectId, required: true },
      version: membershipVersion(),
      mutationFence: mutationFence(),
      status: {
        type: String,
        enum: ['PENDING_INVITE', 'ACTIVE', 'SUSPENDED', 'REMOVED'],
        required: true,
      },
    },
    { collection: 'organization_memberships', timestamps: true, strict: true },
  ),
  organization_invitations: membershipInvitationSchema,
  membership_operations: membershipOperationSchema,
  projects: new Schema(
    {
      organizationId: { type: Schema.Types.ObjectId, required: true },
      name: { type: String, required: true, trim: true },
      code: { type: String, required: true, uppercase: true, trim: true },
      description: String,
      visibility: {
        type: String,
        enum: ['PRIVATE', 'PUBLIC'],
        required: true,
        default: 'PRIVATE',
      },
      status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], required: true },
      createdBy: { type: Schema.Types.ObjectId, required: true },
    },
    { collection: 'projects', timestamps: true, strict: true },
  ),
  teams: teamFoundationSchema,
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
      mutationFence: mutationFence(),
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
      mutationFence: mutationFence(),
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
  platform_authority_assignments: new Schema(
    {
      subjectUserId: { type: Schema.Types.ObjectId, required: true },
      permission: {
        type: String,
        enum: [
          'organization.create',
          'platform.health.read',
          'platform.audit.read',
        ],
        required: true,
      },
      scope: { type: String, enum: ['PLATFORM'], required: true },
      status: { type: String, enum: ['ACTIVE', 'REVOKED'], required: true },
      grantedAt: { type: Date, required: true },
      grantedBy: { type: Schema.Types.ObjectId, required: true },
      expiresAt: Date,
      revokedAt: Date,
      revokedBy: Schema.Types.ObjectId,
    },
    {
      collection: 'platform_authority_assignments',
      timestamps: true,
      strict: true,
    },
  ),
  platform_authority_change_operations: new Schema(
    {
      operationId: { type: String, required: true },
      payloadHash: {
        type: String,
        required: true,
        match: /^[a-f\d]{64}$/,
      },
      actorUserId: { type: Schema.Types.ObjectId, required: true },
      issuerUserId: { type: Schema.Types.ObjectId, required: true },
      operationType: {
        type: String,
        enum: ['GRANT', 'REVOKE'],
        required: true,
      },
      targetUserId: { type: Schema.Types.ObjectId, required: true },
      permission: {
        type: String,
        enum: [
          'organization.create',
          'platform.health.read',
          'platform.audit.read',
        ],
        required: true,
      },
      scope: { type: String, enum: ['PLATFORM'], required: true },
      auditEventId: { type: String, required: true },
      status: { type: String, enum: ['COMMITTED'], required: true },
      httpStatus: { type: Number, enum: [200, 201], required: true },
      resultBody: { type: Schema.Types.Mixed, required: true },
      committedAt: { type: Date, required: true },
      expiresAt: { type: Date, required: true },
    },
    {
      collection: 'platform_authority_change_operations',
      timestamps: true,
      strict: true,
    },
  ),
  platform_authority_change_locks: new Schema(
    {
      permission: {
        type: String,
        enum: [
          'organization.create',
          'platform.health.read',
          'platform.audit.read',
        ],
        required: true,
      },
      scope: { type: String, enum: ['PLATFORM'], required: true },
      version: { type: Number, required: true, default: 0 },
    },
    {
      collection: 'platform_authority_change_locks',
      timestamps: true,
      strict: true,
    },
  ),
  refresh_sessions: new Schema(
    {
      userId: { type: Schema.Types.ObjectId, required: true },
      organizationId: Schema.Types.ObjectId,
      context: { type: String, enum: ['ORGANIZATION', 'PLATFORM', 'ACCOUNT'] },
      tokenHash: { type: String, required: true },
      ipAddress: String,
      userAgent: String,
      isRevoked: { type: Boolean, default: false },
      expiresAt: { type: Date, required: true },
    },
    { collection: 'refresh_sessions', timestamps: true, strict: true },
  ),
  password_reset_outbox: new Schema(
    {
      userScopeHash: { type: String, required: true },
      userId: { type: String, required: true },
      tokenHash: { type: String, required: true },
      expiresAt: { type: Date, required: true },
      deliveryStatus: {
        type: String,
        enum: ['PENDING', 'SENDING', 'SENT', 'FAILED', 'IGNORED'],
        required: true,
      },
      encryptedPayload: String,
      attemptCount: { type: Number, required: true, default: 0 },
      nextAttemptAt: { type: Date, required: true },
      leaseId: String,
      leaseUntil: Date,
      tokenClaimId: String,
      lastErrorCode: String,
      sentAt: Date,
    },
    { collection: 'password_reset_outbox', timestamps: true, strict: true },
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
