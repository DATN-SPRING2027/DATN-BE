import type { ServicePersistenceDefinition } from './mongodb/mongodb.types';
import type { QueueName } from './queues/queue.names';

const index = (
  fields: Record<string, 1 | -1>,
  options?: { unique?: boolean; expireAfterSeconds?: number },
) => ({ fields, options });

export const JIRA_PERSISTENCE: ServicePersistenceDefinition = {
  databaseName: 'continuum_jira',
  collections: [
    {
      name: 'jira_connections',
      indexes: [
        index({ organizationId: 1, projectId: 1 }, { unique: true }),
        index({ atlassianSiteId: 1 }),
      ],
    },
    {
      name: 'jira_account_links',
      indexes: [
        index({ organizationId: 1, userId: 1 }, { unique: true }),
        index({ organizationId: 1, atlassianAccountId: 1 }, { unique: true }),
      ],
    },
    {
      name: 'jira_issues',
      indexes: [
        index({ projectId: 1, issueKey: 1 }, { unique: true }),
        index({ organizationId: 1, projectId: 1, statusCategory: 1 }),
        index({ organizationId: 1, assigneeAtlassianId: 1 }),
      ],
    },
    {
      name: 'jira_events',
      indexes: [
        index({ organizationId: 1, eventId: 1 }, { unique: true }),
        index({ processingStatus: 1, receivedAt: 1 }),
      ],
    },
    {
      name: 'jira_sync_jobs',
      indexes: [index({ projectId: 1, status: 1, createdAt: 1 })],
    },
  ],
};

export const JIRA_QUEUES: QueueName[] = ['jira-sync-queue', 'dlq-failed-jobs'];
