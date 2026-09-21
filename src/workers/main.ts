import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import {
  bullmqPrefix,
  createRedisConnection,
} from '../common/redis/redis-connection';

const queue = process.env.WORKER_QUEUE;
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2);

if (!queue) {
  throw new Error('WORKER_QUEUE is required for the worker process');
}

const config = new ConfigService(process.env);
const redis = createRedisConnection(config);

const worker = new Worker(
  queue,
  (job: Job) => {
    throw new Error(
      `No handler is registered for ${queue}/${job.name}; refusing to acknowledge the job`,
    );
  },
  {
    connection: redis,
    prefix: bullmqPrefix(config),
    concurrency,
  },
);

worker.on('failed', (job, error) => {
  console.error('worker.job.failed', {
    queue,
    jobId: job?.id,
    error: error.message,
  });
});

worker.on('error', (error) => {
  console.error('worker.error', { queue, error: error.message });
});

const shutdown = async (signal: string) => {
  console.info('worker.shutdown', { queue, signal });
  await worker.close();
  redis.disconnect();
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

void worker.waitUntilReady().then(() => {
  console.info('worker.ready', { queue, concurrency });
});
