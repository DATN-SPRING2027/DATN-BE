export const PLATFORM_JOB_OPERATIONS_REPOSITORY = Symbol(
  'PLATFORM_JOB_OPERATIONS_REPOSITORY',
);
export const PLATFORM_BULLMQ_QUEUE_CLIENT_FACTORY = Symbol(
  'PLATFORM_BULLMQ_QUEUE_CLIENT_FACTORY',
);

export const PLATFORM_QUEUE_IDS = [
  'ingestion-queue',
  'jira-sync-queue',
  'mail-queue',
  'handover-queue',
  'universe-projection',
  'dlq-failed-jobs',
] as const;
export type PlatformQueueId = (typeof PLATFORM_QUEUE_IDS)[number];

export const PLATFORM_JOB_STATES = [
  'WAITING',
  'ACTIVE',
  'COMPLETED',
  'FAILED',
  'DELAYED',
  'PAUSED',
  'WAITING_CHILDREN',
  'UNKNOWN',
] as const;
export type PlatformJobState = (typeof PLATFORM_JOB_STATES)[number];
export const PLATFORM_JOB_FILTER_STATES = [
  'WAITING',
  'ACTIVE',
  'COMPLETED',
  'FAILED',
  'DELAYED',
  'PAUSED',
  'WAITING_CHILDREN',
] as const;
export type PlatformJobFilterState =
  (typeof PLATFORM_JOB_FILTER_STATES)[number];
export type PlatformBullMqJobType =
  | 'waiting'
  | 'active'
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'paused'
  | 'waiting-children';

export interface PlatformQueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
  waitingChildren: number;
}

export interface PlatformQueueSummary {
  id: PlatformQueueId;
  status: 'READY' | 'DEGRADED' | 'UNAVAILABLE';
  availability: 'AVAILABLE' | 'UNAVAILABLE';
  paused: boolean | null;
  workers: number | null;
  depth: number | null;
  counts: PlatformQueueCounts | null;
  lastCheckedAt: string;
}

export interface PlatformJobSummary {
  id: string;
  queueId: PlatformQueueId;
  status: PlatformJobState;
  attemptsMade: number;
  attempts: number;
  createdAt: string | null;
  processedAt: string | null;
  finishedAt: string | null;
  failureSummary?: string;
}

export interface PlatformJobListInput {
  page: number;
  pageSize: number;
  queueId?: PlatformQueueId;
  status?: PlatformJobFilterState;
}

export interface PlatformJobPage {
  data: PlatformJobSummary[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

export type PlatformJobCommand =
  | { command: 'RETRY'; expectedStatus: 'FAILED' }
  | {
      command: 'CANCEL';
      expectedStatus: 'WAITING' | 'DELAYED';
    };

export interface PlatformJobCommandInput {
  actorUserId: string;
  queueId: PlatformQueueId;
  jobId: string;
  idempotencyKey: string;
  command: PlatformJobCommand;
  correlationId?: string;
}

export interface PlatformJobCommandResult {
  queueId: PlatformQueueId;
  jobId: string;
  command: 'RETRY' | 'CANCEL';
  outcome: 'RETRY_QUEUED' | 'CANCELLED';
  completedAt: string;
}

export interface PlatformJobOperationsRepository {
  listQueues(): Promise<{ data: PlatformQueueSummary[] }>;
  findQueue(id: PlatformQueueId): Promise<PlatformQueueSummary | null>;
  listJobs(input: PlatformJobListInput): Promise<PlatformJobPage>;
  findJob(
    queueId: PlatformQueueId,
    jobId: string,
  ): Promise<PlatformJobSummary | null>;
  execute(
    input: PlatformJobCommandInput,
  ): Promise<{ body: PlatformJobCommandResult; replayed: boolean }>;
}

export interface PlatformBullMqJobClient {
  id?: string;
  attemptsMade: number;
  opts: { attempts?: number };
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  failedReason?: string;
  getState(): Promise<string>;
  retry(state?: 'completed' | 'failed'): Promise<void>;
  remove(options?: { removeChildren?: boolean }): Promise<void>;
}

export interface PlatformBullMqQueueClient {
  getJobCounts(
    ...types: PlatformBullMqJobType[]
  ): Promise<Record<string, number>>;
  isPaused(): Promise<boolean>;
  getWorkersCount(): Promise<number>;
  getJobs(
    types: PlatformBullMqJobType[],
    start: number,
    end: number,
    asc: boolean,
  ): Promise<PlatformBullMqJobClient[]>;
  getJob(jobId: string): Promise<PlatformBullMqJobClient | undefined | null>;
}

export interface PlatformBullMqQueueClientFactory {
  get(id: PlatformQueueId): PlatformBullMqQueueClient;
  getOperationStore(): PlatformJobOperationStore;
}

export interface PlatformJobOperationStore {
  get(key: string): Promise<string | null>;
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  releaseLock(key: string, owner: string): Promise<void>;
}
