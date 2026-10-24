import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import type { Connection } from 'mongoose';
import {
  bullmqPrefix,
  createRedisConnection,
  type RedisConnection,
} from '../../../../common/redis/redis-connection';
import { createBullMqTelemetry } from '../../../../common/observability/bullmq-telemetry';
import {
  AUDIT_DATABASE_NAME,
  AUDIT_DATABASE_NAME_TOKEN,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import { IAM_PERSISTENCE } from '../persistence';
import {
  PLATFORM_JOB_STATES,
  PLATFORM_QUEUE_IDS,
  type PlatformBullMqJobClient,
  type PlatformBullMqJobType,
  type PlatformBullMqQueueClientFactory,
  type PlatformJobListInput,
  type PlatformJobCommandInput,
  type PlatformJobCommandResult,
  type PlatformJobFilterState,
  type PlatformJobOperationsRepository,
  type PlatformJobPage,
  type PlatformJobState,
  type PlatformJobSummary,
  PLATFORM_BULLMQ_QUEUE_CLIENT_FACTORY,
  type PlatformQueueCounts,
  type PlatformQueueId,
  type PlatformQueueSummary,
} from '../../application/platform/platform-job-operations.repository';

const rawStates = [
  'waiting',
  'active',
  'completed',
  'failed',
  'delayed',
  'paused',
  'waiting-children',
] as const satisfies readonly PlatformBullMqJobType[];
const rawStateByStatus: Record<PlatformJobFilterState, PlatformBullMqJobType> =
  {
    WAITING: 'waiting',
    ACTIVE: 'active',
    COMPLETED: 'completed',
    FAILED: 'failed',
    DELAYED: 'delayed',
    PAUSED: 'paused',
    WAITING_CHILDREN: 'waiting-children',
  };
const jobOperationRetentionMs = 30 * 24 * 60 * 60 * 1000;
const jobOperationLockTtlMs = 60_000;
const releaseLockScript =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

interface StoredJobOperation {
  state: 'PENDING' | 'MUTATED' | 'COMPLETED';
  fingerprintHash: string;
  auditEventId: string;
  body: PlatformJobCommandResult;
  correlationId?: string;
}

interface JobAuditDocument {
  eventId: string;
  fingerprintHash?: string;
  actorUserId?: string;
  action?: string;
  targetResource?: string;
  targetResourceId?: string;
  occurredAt?: Date;
}

@Injectable()
export class BullMqPlatformQueueClientFactory
  implements PlatformBullMqQueueClientFactory, OnModuleDestroy
{
  private redis?: RedisConnection;
  private readonly queues = new Map<PlatformQueueId, Queue>();

  constructor(private readonly config: ConfigService) {}

  get(id: PlatformQueueId): Queue {
    const existing = this.queues.get(id);
    if (existing) return existing;
    this.redis ??= createRedisConnection(this.config);
    const queue = new Queue(id, {
      connection: this.redis,
      prefix: bullmqPrefix(this.config),
      telemetry: createBullMqTelemetry(),
    });
    this.queues.set(id, queue);
    return queue;
  }

  getOperationStore() {
    this.redis ??= createRedisConnection(this.config);
    const redis = this.redis;
    const prefix = bullmqPrefix(this.config);
    return {
      get: (key: string) => redis.get(`${prefix}:${key}`),
      setIfAbsent: async (key: string, value: string, ttlMs: number) =>
        (await redis.set(`${prefix}:${key}`, value, 'PX', ttlMs, 'NX')) ===
        'OK',
      set: async (key: string, value: string, ttlMs: number) => {
        await redis.set(`${prefix}:${key}`, value, 'PX', ttlMs);
      },
      releaseLock: async (key: string, owner: string) => {
        await redis.eval(releaseLockScript, 1, `${prefix}:${key}`, owner);
      },
    };
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(
      [...this.queues.values()].map((queue) => queue.close()),
    );
    this.redis?.disconnect();
  }
}

@Injectable()
export class BullMqPlatformJobOperationsRepository implements PlatformJobOperationsRepository {
  constructor(
    @Inject(PLATFORM_BULLMQ_QUEUE_CLIENT_FACTORY)
    private readonly factory: PlatformBullMqQueueClientFactory,
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
    @Optional()
    @Inject(AUDIT_DATABASE_NAME_TOKEN)
    private readonly auditDatabaseName = AUDIT_DATABASE_NAME,
  ) {}

  async listQueues(): Promise<{ data: PlatformQueueSummary[] }> {
    const data = await Promise.all(
      PLATFORM_QUEUE_IDS.map((id) => this.readQueue(id)),
    );
    return { data };
  }

  findQueue(id: PlatformQueueId): Promise<PlatformQueueSummary> {
    return this.readQueue(id);
  }

  async listJobs(input: PlatformJobListInput): Promise<PlatformJobPage> {
    const queueIds = input.queueId ? [input.queueId] : [...PLATFORM_QUEUE_IDS];
    const states =
      input.status === undefined
        ? [...rawStates]
        : [rawStateByStatus[input.status]];
    const perQueueLimit = input.page * input.pageSize;
    const result = await Promise.all(
      queueIds.map(async (queueId) => {
        try {
          const queue = this.factory.get(queueId);
          const counts = await queue.getJobCounts(...states);
          const totalItems = states.reduce(
            (sum, state) => sum + (counts[state] ?? 0),
            0,
          );
          const jobs = await queue.getJobs(
            [...states],
            0,
            Math.min(perQueueLimit, Math.max(totalItems, 1)) - 1,
            false,
          );
          return {
            totalItems,
            jobs: await Promise.all(
              jobs.map(async (job) => this.projectJob(queueId, job)),
            ),
          };
        } catch {
          throw new ServiceUnavailableException(
            'Platform job queue is unavailable',
          );
        }
      }),
    );
    const totalItems = result.reduce((sum, item) => sum + item.totalItems, 0);
    const offset = (input.page - 1) * input.pageSize;
    const data = result
      .flatMap((item) => item.jobs)
      .filter(
        (job) => input.status === undefined || job.status === input.status,
      )
      .sort(
        (left, right) =>
          (Date.parse(right.createdAt ?? '') || 0) -
            (Date.parse(left.createdAt ?? '') || 0) ||
          left.queueId.localeCompare(right.queueId) ||
          left.id.localeCompare(right.id),
      )
      .slice(offset, offset + input.pageSize);
    return {
      data,
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / input.pageSize),
      },
    };
  }

  async findJob(
    queueId: PlatformQueueId,
    jobId: string,
  ): Promise<PlatformJobSummary | null> {
    try {
      const job = await this.factory.get(queueId).getJob(jobId);
      return job ? this.projectJob(queueId, job) : null;
    } catch {
      throw new ServiceUnavailableException(
        'Platform job queue is unavailable',
      );
    }
  }

  async execute(
    input: PlatformJobCommandInput,
  ): Promise<{ body: PlatformJobCommandResult; replayed: boolean }> {
    const actorKeyHash = hash(`${input.actorUserId}:${input.idempotencyKey}`);
    const fingerprintHash = hash(
      JSON.stringify({
        actorUserId: input.actorUserId,
        queueId: input.queueId,
        jobId: input.jobId,
        command: input.command,
      }),
    );
    const eventId = `platform-job-${actorKeyHash}`;
    const store = this.factory.getOperationStore();
    const idemKey = `platform:job-operation:${actorKeyHash}`;
    const jobKey = `platform:job-operation-lock:${hash(`${input.queueId}:${input.jobId}`)}`;
    const idemOwner = randomUUID();
    const jobOwner = randomUUID();
    let idemLocked = false;
    let jobLocked = false;
    let operationStarted = false;
    try {
      idemLocked = await store.setIfAbsent(
        `${idemKey}:lock`,
        idemOwner,
        jobOperationLockTtlMs,
      );
      if (!idemLocked)
        throw new ConflictException({
          code: 'PLATFORM_JOB_OPERATION_IN_PROGRESS',
        });
      jobLocked = await store.setIfAbsent(
        jobKey,
        jobOwner,
        jobOperationLockTtlMs,
      );
      if (!jobLocked)
        throw new ConflictException({
          code: 'PLATFORM_JOB_OPERATION_IN_PROGRESS',
        });

      const auditCollection = this.auditCollection();
      const storedValue = await store.get(idemKey);
      let stored: StoredJobOperation | null = storedValue
        ? parseStoredOperation(storedValue)
        : null;
      const matchingAudit = (await auditCollection.findOne({
        eventId,
      })) as JobAuditDocument | null;

      if (stored && stored.fingerprintHash !== fingerprintHash)
        throw new ConflictException({
          code: 'PLATFORM_JOB_IDEMPOTENCY_CONFLICT',
        });
      if (stored?.state === 'COMPLETED')
        return { body: stored.body, replayed: true };
      if (stored?.state === 'PENDING') {
        if (matchingAudit) {
          const body = this.replayFromAudit(
            matchingAudit,
            input,
            fingerprintHash,
          );
          stored = { ...stored, state: 'COMPLETED', body };
          await store.set(
            idemKey,
            JSON.stringify(stored),
            jobOperationRetentionMs,
          );
          return { body, replayed: true };
        }
        throw new ServiceUnavailableException({
          code: 'PLATFORM_JOB_OPERATION_UNCERTAIN',
        });
      }
      if (stored?.state === 'MUTATED') {
        operationStarted = true;
        const body = stored.body;
        await this.writeJobAudit(
          auditCollection,
          input,
          body,
          eventId,
          fingerprintHash,
          stored.correlationId,
        );
        const complete: StoredJobOperation = { ...stored, state: 'COMPLETED' };
        await store.set(
          idemKey,
          JSON.stringify(complete),
          jobOperationRetentionMs,
        );
        return { body, replayed: true };
      }
      if (matchingAudit) {
        const body = this.replayFromAudit(
          matchingAudit,
          input,
          fingerprintHash,
        );
        const completed: StoredJobOperation = {
          state: 'COMPLETED',
          fingerprintHash,
          auditEventId: eventId,
          body,
        };
        await store.set(
          idemKey,
          JSON.stringify(completed),
          jobOperationRetentionMs,
        );
        return { body, replayed: true };
      }

      let job: PlatformBullMqJobClient | undefined | null;
      try {
        job = await this.factory.get(input.queueId).getJob(input.jobId);
      } catch {
        throw new ServiceUnavailableException({
          code: 'PLATFORM_JOB_QUEUE_UNAVAILABLE',
        });
      }
      if (!job) throw new NotFoundException({ code: 'PLATFORM_JOB_NOT_FOUND' });
      let currentState: string;
      try {
        currentState = (await job.getState()).toUpperCase();
      } catch {
        throw new ServiceUnavailableException({
          code: 'PLATFORM_JOB_QUEUE_UNAVAILABLE',
        });
      }
      if (currentState !== input.command.expectedStatus)
        throw new ConflictException({ code: 'PLATFORM_JOB_STATE_CONFLICT' });

      const completedAt = new Date().toISOString();
      const body: PlatformJobCommandResult = {
        queueId: input.queueId,
        jobId: input.jobId,
        command: input.command.command,
        outcome:
          input.command.command === 'RETRY' ? 'RETRY_QUEUED' : 'CANCELLED',
        completedAt,
      };
      const pending: StoredJobOperation = {
        state: 'PENDING',
        fingerprintHash,
        auditEventId: eventId,
        body,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      };
      const claimed = await store.setIfAbsent(
        idemKey,
        JSON.stringify(pending),
        jobOperationRetentionMs,
      );
      if (!claimed)
        throw new ConflictException({
          code: 'PLATFORM_JOB_OPERATION_IN_PROGRESS',
        });

      operationStarted = true;
      try {
        if (input.command.command === 'RETRY') await job.retry('failed');
        else await job.remove();
      } catch {
        throw new ServiceUnavailableException({
          code: 'PLATFORM_JOB_OPERATION_UNCERTAIN',
        });
      }
      const mutated: StoredJobOperation = { ...pending, state: 'MUTATED' };
      await store.set(
        idemKey,
        JSON.stringify(mutated),
        jobOperationRetentionMs,
      );
      try {
        await this.writeJobAudit(
          auditCollection,
          input,
          body,
          eventId,
          fingerprintHash,
          input.correlationId,
        );
      } catch {
        throw new ServiceUnavailableException({
          code: 'PLATFORM_JOB_OPERATION_UNCERTAIN',
        });
      }
      const complete: StoredJobOperation = {
        ...pending,
        state: 'COMPLETED',
      };
      await store.set(
        idemKey,
        JSON.stringify(complete),
        jobOperationRetentionMs,
      );
      return { body, replayed: false };
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof NotFoundException ||
        error instanceof ServiceUnavailableException
      )
        throw error;
      if (operationStarted)
        throw new ServiceUnavailableException({
          code: 'PLATFORM_JOB_OPERATION_UNCERTAIN',
        });
      throw new ServiceUnavailableException({
        code: 'PLATFORM_JOB_QUEUE_UNAVAILABLE',
      });
    } finally {
      if (jobLocked)
        await store.releaseLock(jobKey, jobOwner).catch(() => undefined);
      if (idemLocked)
        await store
          .releaseLock(`${idemKey}:lock`, idemOwner)
          .catch(() => undefined);
    }
  }

  private async readQueue(id: PlatformQueueId): Promise<PlatformQueueSummary> {
    const lastCheckedAt = new Date().toISOString();
    try {
      const queue = this.factory.get(id);
      const [rawCounts, paused, rawWorkers] = await Promise.all([
        queue.getJobCounts(...rawStates),
        queue.isPaused(),
        queue.getWorkersCount(),
      ]);
      const workers = nonNegativeCount(rawWorkers);
      const counts: PlatformQueueCounts = {
        waiting: nonNegativeCount(rawCounts.waiting),
        active: nonNegativeCount(rawCounts.active),
        completed: nonNegativeCount(rawCounts.completed),
        failed: nonNegativeCount(rawCounts.failed),
        delayed: nonNegativeCount(rawCounts.delayed),
        paused: nonNegativeCount(rawCounts.paused),
        waitingChildren: nonNegativeCount(rawCounts['waiting-children']),
      };
      return {
        id,
        status: paused || workers === 0 ? 'DEGRADED' : 'READY',
        availability: 'AVAILABLE',
        paused,
        workers,
        depth:
          counts.waiting +
          counts.active +
          counts.delayed +
          counts.paused +
          counts.waitingChildren,
        counts,
        lastCheckedAt,
      };
    } catch {
      return {
        id,
        status: 'UNAVAILABLE',
        availability: 'UNAVAILABLE',
        paused: null,
        workers: null,
        depth: null,
        counts: null,
        lastCheckedAt,
      };
    }
  }

  private replayFromAudit(
    audit: JobAuditDocument,
    input: PlatformJobCommandInput,
    fingerprintHash: string,
  ): PlatformJobCommandResult {
    const action =
      input.command.command === 'RETRY'
        ? 'platform.job.retry'
        : 'platform.job.cancel';
    if (
      audit.fingerprintHash !== fingerprintHash ||
      audit.actorUserId !== input.actorUserId ||
      audit.action !== action ||
      audit.targetResource !== 'JOB' ||
      audit.targetResourceId !== `${input.queueId}:${input.jobId}` ||
      !(audit.occurredAt instanceof Date) ||
      !Number.isFinite(audit.occurredAt.getTime())
    )
      throw new ConflictException({
        code: 'PLATFORM_JOB_IDEMPOTENCY_CONFLICT',
      });
    return {
      queueId: input.queueId,
      jobId: input.jobId,
      command: input.command.command,
      outcome: input.command.command === 'RETRY' ? 'RETRY_QUEUED' : 'CANCELLED',
      completedAt: audit.occurredAt.toISOString(),
    };
  }

  private async writeJobAudit(
    collection: ReturnType<
      BullMqPlatformJobOperationsRepository['auditCollection']
    >,
    input: PlatformJobCommandInput,
    body: PlatformJobCommandResult,
    eventId: string,
    fingerprintHash: string,
    correlationId?: string,
  ): Promise<void> {
    const action =
      body.command === 'RETRY' ? 'platform.job.retry' : 'platform.job.cancel';
    await collection.updateOne(
      { eventId },
      {
        $setOnInsert: {
          eventId,
          schemaVersion: 2,
          fingerprintHash,
          actorUserId: input.actorUserId,
          action,
          targetResource: 'JOB',
          targetResourceId: `${input.queueId}:${input.jobId}`,
          scope: 'PLATFORM',
          result: 'SUCCESS',
          previousStatus: input.command.expectedStatus,
          newStatus: body.outcome,
          ...(correlationId ? { requestId: correlationId } : {}),
          occurredAt: new Date(body.completedAt),
        },
      },
      { upsert: true },
    );
    const persistedAudit = (await collection.findOne({
      eventId,
    })) as JobAuditDocument | null;
    if (!persistedAudit) throw new Error('Job audit commit was not confirmed');
    this.replayFromAudit(persistedAudit, input, fingerprintHash);
  }

  private auditCollection() {
    if (!this.connection)
      throw new ServiceUnavailableException({
        code: 'PLATFORM_JOB_AUDIT_UNAVAILABLE',
      });
    return this.connection
      .useDb(this.auditDatabaseName, { useCache: true })
      .collection<JobAuditDocument>(IAM_AUDIT_COLLECTION_NAME);
  }

  private async projectJob(
    queueId: PlatformQueueId,
    job: PlatformBullMqJobClient,
  ): Promise<PlatformJobSummary> {
    const state = normalizeJobState(await job.getState());
    const summary: PlatformJobSummary = {
      id: String(job.id ?? ''),
      queueId,
      status: state,
      attemptsMade: safeCount(job.attemptsMade),
      attempts: safeCount(job.opts.attempts ?? 0),
      createdAt: isoFromTimestamp(job.timestamp),
      processedAt: isoFromTimestamp(job.processedOn),
      finishedAt: isoFromTimestamp(job.finishedOn),
      ...(state === 'FAILED'
        ? { failureSummary: 'Job failed. Raw failure details are withheld.' }
        : {}),
    };
    if (!summary.id || summary.id.length > 200) {
      throw new ServiceUnavailableException('Platform job data is invalid');
    }
    return summary;
  }
}

function nonNegativeCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid queue count');
  }
  return value;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseStoredOperation(value: string): StoredJobOperation {
  try {
    const parsed = JSON.parse(value) as Partial<StoredJobOperation>;
    if (
      (parsed.state !== 'PENDING' &&
        parsed.state !== 'MUTATED' &&
        parsed.state !== 'COMPLETED') ||
      typeof parsed.fingerprintHash !== 'string' ||
      typeof parsed.auditEventId !== 'string' ||
      typeof parsed.body !== 'object' ||
      parsed.body === null
    )
      throw new Error('Invalid job operation record');
    return parsed as StoredJobOperation;
  } catch {
    throw new ServiceUnavailableException({
      code: 'PLATFORM_JOB_OPERATION_UNCERTAIN',
    });
  }
}

function safeCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function normalizeJobState(state: string): PlatformJobState {
  const normalized = state.toUpperCase().replace(/-/g, '_');
  return (PLATFORM_JOB_STATES as readonly string[]).includes(normalized)
    ? (normalized as PlatformJobState)
    : 'UNKNOWN';
}

function isoFromTimestamp(value: number | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
