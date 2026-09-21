export const QUEUE_NAMES = {
  ingestion: 'ingestion-queue',
  jiraSync: 'jira-sync-queue',
  mail: 'mail-queue',
  handover: 'handover-queue',
  universeProjection: 'universe-projection',
  deadLetter: 'dlq-failed-jobs',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
