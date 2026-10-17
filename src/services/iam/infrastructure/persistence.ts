import { SERVICE_DATABASES } from '../../../common/mongodb/database-names';
import type { ServicePersistenceDefinition } from './mongodb/mongodb.types';
import type { QueueName } from './queues/queue.names';

const index = (
  fields: Record<string, 1 | -1>,
  options?: {
    unique?: boolean;
    sparse?: boolean;
    expireAfterSeconds?: number;
    name?: string;
    partialFilterExpression?: Record<string, unknown>;
    collation?: { locale: 'simple' };
  },
) => ({ fields, options });

export const IAM_PERSISTENCE: ServicePersistenceDefinition = {
  serviceName: 'iam',
  databaseName: SERVICE_DATABASES.iam,
  collections: [
    {
      name: 'users',
      indexes: [
        index({ email: 1 }, { unique: true }),
        index({ googleSubject: 1 }, { unique: true, sparse: true }),
        index({ status: 1, createdAt: 1 }),
      ],
    },
    { name: 'organizations', indexes: [index({ slug: 1 }, { unique: true })] },
    {
      name: 'organization_memberships',
      indexes: [
        index({ organizationId: 1, userId: 1 }, { unique: true }),
        index({ userId: 1, status: 1, organizationId: 1 }),
        index(
          { organizationId: 1, createdAt: -1, _id: -1 },
          { name: 'membership_list' },
        ),
        index(
          { organizationId: 1, status: 1, createdAt: -1, _id: -1 },
          { name: 'membership_status_list' },
        ),
      ],
    },
    {
      name: 'organization_invitations',
      indexes: [
        index(
          { organizationId: 1, email: 1 },
          {
            name: 'uniq_pending_org_email',
            unique: true,
            partialFilterExpression: { status: 'PENDING' },
          },
        ),
        index({ email: 1, status: 1, expiresAt: 1 }),
        index({ organizationId: 1, status: 1, expiresAt: 1 }),
        index(
          { membershipId: 1 },
          {
            name: 'uniq_pending_membership_v2',
            unique: true,
            partialFilterExpression: { contractVersion: 2, status: 'PENDING' },
          },
        ),
        index(
          { membershipId: 1, createdAt: -1, _id: -1 },
          { name: 'membership_invitation_history' },
        ),
      ],
    },
    {
      name: 'membership_operations',
      indexes: [
        index(
          { actorUserId: 1, organizationId: 1, keyHash: 1 },
          { name: 'membership_operation_key', unique: true },
        ),
        index(
          { expiresAt: 1 },
          { name: 'membership_operation_expiry', expireAfterSeconds: 0 },
        ),
        index(
          { organizationId: 1, actorUserId: 1, committedAt: 1 },
          { name: 'membership_invitation_quota' },
        ),
      ],
    },
    {
      name: 'projects',
      indexes: [index({ organizationId: 1, code: 1 }, { unique: true })],
    },
    {
      name: 'teams',
      indexes: [
        index({ organizationId: 1, projectId: 1, code: 1 }, { unique: true }),
      ],
    },
    {
      name: 'project_memberships',
      indexes: [index({ projectId: 1, userId: 1 }, { unique: true })],
    },
    {
      name: 'team_memberships',
      indexes: [index({ teamId: 1, userId: 1 }, { unique: true })],
    },
    { name: 'roles', indexes: [index({ code: 1 }, { unique: true })] },
    {
      name: 'role_assignments',
      indexes: [
        index({ organizationId: 1, projectId: 1, userId: 1 }, { unique: true }),
      ],
    },
    {
      name: 'organization_capability_grants',
      indexes: [
        index({ organizationId: 1, userId: 1, capability: 1, revokedAt: 1 }),
      ],
    },
    {
      name: 'platform_incidents',
      indexes: [
        index(
          { status: 1, updatedAt: -1, _id: -1 },
          { name: 'platform_incident_status_list' },
        ),
        index(
          { affectedServiceId: 1, status: 1, updatedAt: -1, _id: -1 },
          { name: 'platform_incident_service_status_list' },
        ),
      ],
    },
    {
      name: 'platform_incident_history',
      indexes: [
        index(
          { incidentId: 1, occurredAt: 1, _id: 1 },
          { name: 'platform_incident_history_order' },
        ),
      ],
    },
    {
      name: 'platform_incident_operations',
      indexes: [
        index(
          { actorUserId: 1, idempotencyKeyHash: 1 },
          { name: 'platform_incident_operation_key', unique: true },
        ),
        index(
          { incidentId: 1, committedAt: -1 },
          { name: 'platform_incident_operation_history' },
        ),
      ],
    },
    {
      name: 'platform_authority_assignments',
      indexes: [
        index({ subjectUserId: 1, permission: 1, scope: 1 }, { unique: true }),
        index({ subjectUserId: 1, status: 1, permission: 1 }),
        index(
          {
            subjectUserId: 1,
            scope: 1,
            provenanceOperationId: 1,
            permission: 1,
          },
          { name: 'platform_authority_snapshot_provenance' },
        ),
      ],
    },
    {
      name: 'platform_authority_change_operations',
      indexes: [
        index(
          { operationId: 1 },
          { name: 'platform_authority_operation_id', unique: true },
        ),
        index(
          { targetUserId: 1, committedAt: -1 },
          { name: 'platform_authority_operation_target_v2' },
        ),
        index(
          { actorUserId: 1, committedAt: -1 },
          { name: 'platform_authority_operation_actor' },
        ),
      ],
    },
    {
      name: 'platform_authority_change_locks',
      indexes: [
        index(
          { permission: 1, scope: 1 },
          { name: 'platform_authority_change_lock_key', unique: true },
        ),
      ],
    },
    {
      name: 'refresh_sessions',
      indexes: [
        index({ tokenHash: 1 }, { unique: true }),
        index({ userId: 1, isRevoked: 1, expiresAt: 1 }),
        index({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      ],
    },
    {
      name: 'password_reset_outbox',
      indexes: [
        index(
          { userScopeHash: 1 },
          { unique: true, name: 'password_reset_current_scope' },
        ),
        index(
          { tokenHash: 1 },
          { unique: true, name: 'password_reset_token_hash' },
        ),
        index(
          { expiresAt: 1 },
          { expireAfterSeconds: 0, name: 'password_reset_expiry' },
        ),
        index(
          { deliveryStatus: 1, nextAttemptAt: 1, expiresAt: 1, createdAt: 1 },
          { name: 'password_reset_pending_jobs' },
        ),
        index(
          { deliveryStatus: 1, leaseUntil: 1, expiresAt: 1, createdAt: 1 },
          { name: 'password_reset_expired_leases' },
        ),
      ],
    },
    {
      name: 'email_registration_outbox',
      indexes: [
        index(
          { normalizedEmail: 1 },
          {
            unique: true,
            name: 'email_registration_current_email',
            collation: { locale: 'simple' },
          },
        ),
        index(
          { tokenHash: 1 },
          {
            unique: true,
            name: 'email_registration_token_hash',
            collation: { locale: 'simple' },
          },
        ),
        index(
          { expiresAt: 1 },
          {
            expireAfterSeconds: 0,
            name: 'email_registration_expiry',
            collation: { locale: 'simple' },
          },
        ),
        index(
          { deliveryStatus: 1, nextAttemptAt: 1, expiresAt: 1, createdAt: 1 },
          {
            name: 'email_registration_pending_jobs',
            collation: { locale: 'simple' },
          },
        ),
        index(
          { deliveryStatus: 1, leaseUntil: 1, expiresAt: 1, createdAt: 1 },
          {
            name: 'email_registration_expired_leases',
            collation: { locale: 'simple' },
          },
        ),
      ],
    },
    {
      name: 'sme_assignments',
      indexes: [index({ projectId: 1, userId: 1, domainModule: 1 })],
    },
    {
      name: 'knowledge_owner_assignments',
      indexes: [index({ knowledgeObjectId: 1, effectiveTo: 1 })],
    },
  ],
};

export const IAM_QUEUES: QueueName[] = [];
