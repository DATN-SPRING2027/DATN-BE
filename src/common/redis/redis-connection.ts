import { ConfigService } from '@nestjs/config';
import Redis, { Cluster } from 'ioredis';

export type RedisConnection = Redis | Cluster;

export function createRedisConnection(config: ConfigService): RedisConnection {
  const password = config.get<string>('REDIS_PASSWORD') || undefined;
  const mode = config.get<string>('REDIS_MODE') ?? 'standalone';

  if (mode === 'cluster') {
    const nodes = (config.get<string>('REDIS_CLUSTER_NODES') ?? '')
      .split(',')
      .map((node) => node.trim())
      .filter(Boolean)
      .map((node) => {
        const [host, port = '6379'] = node.split(':');
        return { host, port: Number(port) };
      });

    if (nodes.length === 0) {
      throw new Error(
        'REDIS_CLUSTER_NODES is required when REDIS_MODE=cluster',
      );
    }

    return new Redis.Cluster(nodes, {
      redisOptions: { password, maxRetriesPerRequest: null },
    });
  }

  return new Redis({
    host: config.get<string>('REDIS_HOST') ?? '127.0.0.1',
    port: config.get<number>('REDIS_PORT') ?? 6379,
    password,
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });
}

export function bullmqPrefix(config: ConfigService): string {
  const prefix = config.get<string>('BULLMQ_PREFIX') ?? 'continuum';
  return config.get<string>('REDIS_MODE') === 'cluster' && !prefix.includes('{')
    ? `{${prefix}}`
    : prefix;
}
