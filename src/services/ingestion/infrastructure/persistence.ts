import type { ServicePersistenceDefinition } from './mongodb/mongodb.types';
import type { QueueName } from './queues/queue.names';

const index = (
  fields: Record<string, 1 | -1>,
  options?: { unique?: boolean; expireAfterSeconds?: number },
) => ({ fields, options });

export const INGESTION_PERSISTENCE: ServicePersistenceDefinition = {
  databaseName: 'continuum_ingestion',
  collections: [
    {
      name: 'documents',
      indexes: [
        index({ projectId: 1, checksumSha256: 1 }, { unique: true }),
        index({ organizationId: 1, projectId: 1, status: 1, createdAt: 1 }),
      ],
    },
    {
      name: 'document_versions',
      indexes: [
        index({ documentId: 1, versionNumber: 1 }, { unique: true }),
        index({ organizationId: 1, projectId: 1, parseStatus: 1 }),
      ],
    },
    {
      name: 'ingestion_jobs',
      indexes: [
        index({ organizationId: 1, projectId: 1, status: 1 }),
        index({ bullMqJobId: 1 }),
      ],
    },
    {
      name: 'sag_mappings',
      indexes: [
        index(
          { sourceType: 1, sourceRecordId: 1, chunkIndex: 1 },
          { unique: true },
        ),
        index({ sagChunkId: 1 }, { unique: true }),
      ],
    },
    {
      name: 'file_upload_tickets',
      indexes: [index({ expiresAt: 1 }, { expireAfterSeconds: 0 })],
    },
  ],
};

export const INGESTION_QUEUES: QueueName[] = [
  'ingestion-queue',
  'dlq-failed-jobs',
];
