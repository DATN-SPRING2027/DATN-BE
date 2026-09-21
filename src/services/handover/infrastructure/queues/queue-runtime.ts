import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, JobsOptions, Queue, QueueEvents } from 'bullmq';
import {
  bullmqPrefix,
  createRedisConnection,
  RedisConnection,
} from '../../../../common/redis/redis-connection';
import { QUEUE_NAMES, QueueName } from './queue.names';
import { DEFAULT_JOB_OPTIONS } from './queue.policy';

export type QueueJobData = {
  event: string;
  payload: Record<string, unknown>;
  requestId?: string;
};

@Injectable()
export class QueueRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly queues = new Map<string, Queue<QueueJobData>>();
  private readonly events: QueueEvents[] = [];
  private readonly redis: RedisConnection;
  constructor(
    private readonly config: ConfigService,
    private readonly serviceQueues: readonly QueueName[],
  ) {
    this.redis = createRedisConnection(config);
  }
  async onModuleInit(): Promise<void> {
    if (process.env.INFRA_ENABLED !== 'true') return;
    for (const name of this.serviceQueues.filter(
      (queue) => queue !== QUEUE_NAMES.deadLetter,
    )) {
      const source = this.getQueue(name);
      const events = new QueueEvents(name, {
        connection: this.connection(),
        prefix: this.prefix(),
      });
      await events.waitUntilReady();
      events.on(
        'failed',
        ({ jobId, failedReason }) =>
          void this.moveToDeadLetter(source, name, jobId, failedReason),
      );
      this.events.push(events);
    }
  }
  add(
    queueName: QueueName,
    jobName: string,
    data: QueueJobData,
    options?: JobsOptions,
  ): Promise<Job<QueueJobData>> {
    return this.getQueue(queueName).add(jobName, data, options);
  }
  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.events.map((events) => events.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.redis.disconnect();
  }
  private getQueue(name: QueueName): Queue<QueueJobData> {
    const existing = this.queues.get(name);
    if (existing) return existing;
    const queue = new Queue<QueueJobData>(name, {
      connection: this.connection(),
      prefix: this.prefix(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    this.queues.set(name, queue);
    return queue;
  }
  private async moveToDeadLetter(
    source: Queue<QueueJobData>,
    sourceName: QueueName,
    jobId: string,
    failedReason: string,
  ): Promise<void> {
    const job = await source.getJob(jobId);
    if (!job) return;
    await this.getQueue(QUEUE_NAMES.deadLetter).add(
      'failed-job',
      {
        event: 'queue.job.failed',
        payload: {
          sourceQueue: sourceName,
          sourceJobId: job.id,
          failedReason,
          data: job.data,
        },
      },
      { jobId: `${sourceName}:${job.id}`, attempts: 1 },
    );
  }
  private connection() {
    return this.redis;
  }
  private prefix(): string {
    return bullmqPrefix(this.config);
  }
}
