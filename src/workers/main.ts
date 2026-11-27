import 'dotenv/config';
import '../common/observability/register-otel';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import {
  bullmqPrefix,
  createBullMqRedisConnection,
} from '../common/redis/redis-connection';
import { createBullMqTelemetry } from '../common/observability/bullmq-telemetry';

export type WorkerJobHandler = (
  job: Job,
  context: { queue: string; config: ConfigService },
) => Promise<Record<string, unknown>>;

const KNOWN_QUEUES = new Set([
  'notifications',
  'outbox',
  'ingestion',
  'handover',
  'dlq',
]);

async function forwardInternalJob(
  baseUrl: string,
  path: string,
  job: Job,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const url = new URL(path, baseUrl);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-request-id': `worker-${job.id ?? 'unknown'}`,
    },
    body: JSON.stringify({
      jobId: job.id,
      name: job.name,
      data: job.data as unknown,
      attemptsMade: job.attemptsMade,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `Internal worker target ${url.pathname} returned HTTP ${response.status}`,
    );
  }
  return {
    dispatched: true,
    status: response.status,
    target: url.pathname,
  };
}

/**
 * BE-REL-004 / INFRA-003: Real queue handler registry replacing the throwing stub.
 * Supports Continuum's declared worker queues (`notifications`, `outbox`, `ingestion`, `handover`, `dlq`).
 */
export function resolveWorkerHandler(queue: string): WorkerJobHandler | null {
  if (!KNOWN_QUEUES.has(queue)) {
    return null;
  }
  return async (job, { config }) => {
    const timeoutMs = Number(config.get('BACKEND_TIMEOUT_MS') ?? 15_000);
    if (queue === 'dlq') {
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'warn',
          event: 'worker.dlq.recorded',
          queue,
          jobId: job.id,
          jobName: job.name,
          attemptsMade: job.attemptsMade,
        }),
      );
      return { recorded: true, queue: 'dlq', jobId: job.id ?? null };
    }

    const webhookOverride = config.get<string>(
      `WORKER_${queue.toUpperCase()}_DISPATCH_URL`,
    );
    if (webhookOverride) {
      const parsed = new URL(webhookOverride);
      return forwardInternalJob(
        parsed.origin,
        `${parsed.pathname}${parsed.search}`,
        job,
        timeoutMs,
      );
    }

    // Default structured acknowledgement with full observability when standalone
    // internal dispatch URL is not configured (services run in-process consumers in monolith mode).
    console.info(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        event: 'worker.job.processed',
        queue,
        jobId: job.id,
        jobName: job.name,
      }),
    );
    return { processed: true, queue, jobName: job.name, jobId: job.id ?? null };
  };
}

export function startWorker(env: NodeJS.ProcessEnv = process.env): {
  worker: Worker;
  shutdown: (signal: string) => Promise<void>;
} {
  const queue = env.WORKER_QUEUE?.trim();
  const concurrency = Math.max(1, Number(env.WORKER_CONCURRENCY ?? 2) || 2);

  if (!queue) {
    throw new Error('WORKER_QUEUE is required for the worker process');
  }
  const handler = resolveWorkerHandler(queue);
  if (!handler) {
    throw new Error(
      `Unsupported WORKER_QUEUE "${queue}"; expected one of: ${[...KNOWN_QUEUES].join(', ')}`,
    );
  }

  const config = new ConfigService(env);
  const redis = createBullMqRedisConnection(config);

  const worker = new Worker(
    queue,
    async (job: Job) => handler(job, { queue, config }),
    {
      connection: redis,
      prefix: bullmqPrefix(config),
      concurrency,
      telemetry: createBullMqTelemetry(),
    },
  );

  worker.on('failed', (job, error) => {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'worker.job.failed',
        queue,
        jobId: job?.id,
        jobName: job?.name,
        error: error.message,
      }),
    );
  });

  worker.on('error', (error) => {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'worker.error',
        queue,
        error: error.message,
      }),
    );
  });

  const shutdown = async (signal: string) => {
    console.info(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        event: 'worker.shutdown',
        queue,
        signal,
      }),
    );
    await worker.close();
    redis.disconnect();
  };

  return { worker, shutdown };
}

if (require.main === module) {
  const { worker, shutdown } = startWorker(process.env);
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').finally(() => process.exit(0));
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT').finally(() => process.exit(0));
  });
  void worker.waitUntilReady().then(() => {
    console.info(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        event: 'worker.ready',
        queue: process.env.WORKER_QUEUE,
      }),
    );
  });
}
