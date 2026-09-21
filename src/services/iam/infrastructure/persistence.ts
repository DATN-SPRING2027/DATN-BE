import type { ServicePersistenceDefinition } from './mongodb/mongodb.types';
import type { QueueName } from './queues/queue.names';

const index = (
  fields: Record<string, 1 | -1>,
  options?: { unique?: boolean; expireAfterSeconds?: number },
) => ({ fields, options });

export const IAM_PERSISTENCE: ServicePersistenceDefinition = {
  databaseName: 'continuum_iam',
  collections: [
    {
      name: 'users',
      indexes: [
        index({ email: 1 }, { unique: true }),
        index({ status: 1, createdAt: 1 }),
      ],
    },
    { name: 'organizations', indexes: [index({ slug: 1 }, { unique: true })] },
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
      name: 'refresh_sessions',
      indexes: [
        index({ tokenHash: 1 }, { unique: true }),
        index({ userId: 1, isRevoked: 1, expiresAt: 1 }),
        index({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
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
