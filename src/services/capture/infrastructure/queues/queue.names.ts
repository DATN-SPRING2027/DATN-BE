export const QUEUE_NAMES = {
  ingestion: 'ingestion-queue',
  jiraSync: 'jira-sync-queue',
  mail: 'mail-queue',
  handover: 'handover-queue',
  universeProjection: 'universe-projection',
  deadLetter: 'dlq-failed-jobs',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const CAPTURE_QUEUE_RUNTIME = Symbol('CAPTURE_QUEUE_RUNTIME');

export interface CaptureQueuePublisher {
  add(
    queueName: QueueName,
    jobName: string,
    data: {
      event: string;
      payload: Record<string, unknown>;
      requestId?: string;
    },
    options?: { jobId?: string; attempts?: number },
  ): Promise<unknown>;
}
