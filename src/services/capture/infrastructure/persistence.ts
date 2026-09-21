import type { ServicePersistenceDefinition } from './mongodb/mongodb.types';
import type { QueueName } from './queues/queue.names';

const index = (
  fields: Record<string, 1 | -1>,
  options?: { unique?: boolean; expireAfterSeconds?: number },
) => ({ fields, options });

export const CAPTURE_PERSISTENCE: ServicePersistenceDefinition = {
  databaseName: 'continuum_capture',
  collections: [
    {
      name: 'work_notes',
      indexes: [
        index({ organizationId: 1, projectId: 1, status: 1, createdAt: 1 }),
        index({ authorUserId: 1, status: 1, createdAt: 1 }),
        index({ projectId: 1, jiraIssueKey: 1 }),
      ],
    },
    {
      name: 'work_note_versions',
      indexes: [index({ workNoteId: 1, versionNumber: 1 }, { unique: true })],
    },
    {
      name: 'capture_drafts',
      indexes: [index({ userId: 1, contextKey: 1 }, { expireAfterSeconds: 0 })],
    },
    {
      name: 'work_note_templates',
      indexes: [index({ organizationId: 1, roleScope: 1 })],
    },
    {
      name: 'knowledge_requirements',
      indexes: [
        index({ organizationId: 1, projectId: 1, status: 1 }),
        index({ projectId: 1, responsibilityCode: 1 }),
      ],
    },
  ],
};

export const CAPTURE_QUEUES: QueueName[] = [
  'jira-sync-queue',
  'dlq-failed-jobs',
];
