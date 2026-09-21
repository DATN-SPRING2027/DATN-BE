import type { ServicePersistenceDefinition } from './mongodb/mongodb.types';
import type { QueueName } from './queues/queue.names';

const index = (
  fields: Record<string, 1 | -1>,
  options?: { unique?: boolean; expireAfterSeconds?: number },
) => ({ fields, options });

export const HANDOVER_PERSISTENCE: ServicePersistenceDefinition = {
  databaseName: 'continuum_handover',
  collections: [
    {
      name: 'responsibilities',
      indexes: [
        index({ projectId: 1, code: 1 }, { unique: true }),
        index({ organizationId: 1, projectId: 1, criticality: 1 }),
      ],
    },
    {
      name: 'responsibility_assignments',
      indexes: [
        index({ responsibilityId: 1, effectiveFrom: 1, effectiveTo: 1 }),
        index({ userId: 1, effectiveTo: 1 }),
      ],
    },
    {
      name: 'handovers',
      indexes: [
        index({
          organizationId: 1,
          projectId: 1,
          departingUserId: 1,
          status: 1,
        }),
        index({ status: 1, targetCompletionDate: 1 }),
      ],
    },
    {
      name: 'handover_items',
      indexes: [
        index({ handoverId: 1, status: 1 }),
        index({ successorUserId: 1, status: 1 }),
      ],
    },
    {
      name: 'interviews',
      indexes: [index({ organizationId: 1, projectId: 1, status: 1 })],
    },
    { name: 'interview_sessions', indexes: [index({ interviewId: 1 })] },
    {
      name: 'learning_paths',
      indexes: [
        index({ organizationId: 1, projectId: 1, learnerUserId: 1, status: 1 }),
      ],
    },
    {
      name: 'follow_up_tasks',
      indexes: [index({ successorUserId: 1, dueDate: 1, isAcknowledged: 1 })],
    },
  ],
};

export const HANDOVER_QUEUES: QueueName[] = [
  'handover-queue',
  'dlq-failed-jobs',
];
