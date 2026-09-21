import type { ServicePersistenceDefinition } from './mongodb/mongodb.types';
import type { QueueName } from './queues/queue.names';

const index = (
  fields: Record<string, 1 | -1>,
  options?: { unique?: boolean; expireAfterSeconds?: number },
) => ({ fields, options });

export const LIFECYCLE_PERSISTENCE: ServicePersistenceDefinition = {
  databaseName: 'continuum_lifecycle',
  collections: [
    {
      name: 'knowledge_objects',
      indexes: [
        index({ organizationId: 1, projectId: 1, slug: 1 }, { unique: true }),
        index({ organizationId: 1, projectId: 1, status: 1, updatedAt: 1 }),
        index({ organizationId: 1, projectId: 1, ownerUserId: 1 }),
        index({ organizationId: 1, projectId: 1, tags: 1 }),
      ],
    },
    {
      name: 'knowledge_proposals',
      indexes: [
        index({
          organizationId: 1,
          projectId: 1,
          reviewStatus: 1,
          createdAt: 1,
        }),
        index({ sourceType: 1, sourceRefId: 1 }),
      ],
    },
    {
      name: 'knowledge_versions',
      indexes: [
        index({ knowledgeObjectId: 1, versionNumber: 1 }, { unique: true }),
        index({ organizationId: 1, projectId: 1, publishedAt: 1 }),
      ],
    },
    {
      name: 'knowledge_evidence',
      indexes: [
        index({ knowledgeObjectId: 1, knowledgeVersionId: 1 }),
        index({ evidenceType: 1, sourceRefId: 1 }),
      ],
    },
    {
      name: 'knowledge_verifications',
      indexes: [
        index({ knowledgeObjectId: 1, createdAt: 1 }),
        index({ decisionByUserId: 1, createdAt: 1 }),
      ],
    },
    {
      name: 'knowledge_gaps',
      indexes: [
        index({ organizationId: 1, projectId: 1, status: 1, severity: 1 }),
      ],
    },
    {
      name: 'knowledge_conflicts',
      indexes: [index({ organizationId: 1, projectId: 1, status: 1 })],
    },
    {
      name: 'knowledge_relations',
      indexes: [
        index(
          {
            sourceKnowledgeObjectId: 1,
            targetKnowledgeObjectId: 1,
            relationType: 1,
          },
          { unique: true },
        ),
      ],
    },
  ],
};

export const LIFECYCLE_QUEUES: QueueName[] = [
  'universe-projection',
  'dlq-failed-jobs',
];
