import { ConfigService } from '@nestjs/config';
import Redis, { Cluster } from 'ioredis';

export type RedisConnection = Redis | Cluster;

export const CONSUME_RATE_LIMIT_LUA =
  "local count = redis.call('incr', KEYS[1]); local ttl = redis.call('ttl', KEYS[1]); if count == 1 or ttl < 0 then redis.call('expire', KEYS[1], ARGV[1]); end; return count";

const sharedHttpClients = new Map<string, RedisConnection>();

function resolveClusterNodes(config: ConfigService) {
  const nodes = (config.get<string>('REDIS_CLUSTER_NODES') ?? '')
    .split(',')
    .map((node) => node.trim())
    .filter(Boolean)
    .map((node) => {
      const [host, port = '6379'] = node.split(':');
      return { host, port: Number(port) };
    });

  if (nodes.length === 0) {
    throw new Error('REDIS_CLUSTER_NODES is required when REDIS_MODE=cluster');
  }
  return nodes;
}

/**
 * BullMQ-compatible Redis connection (`maxRetriesPerRequest: null`).
 * Must ONLY be used for BullMQ queues/workers, never on synchronous HTTP paths.
 */
export function createRedisConnection(config: ConfigService): RedisConnection {
  const password = config.get<string>('REDIS_PASSWORD') || undefined;
  const mode = config.get<string>('REDIS_MODE') ?? 'standalone';

  if (mode === 'cluster') {
    const nodes = resolveClusterNodes(config);
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

export function createBullMqRedisConnection(
  config: ConfigService,
): RedisConnection {
  return createRedisConnection(config);
}

/**
 * Fast-fail HTTP-path Redis connection (`maxRetriesPerRequest: 1`, bounded
 * `commandTimeout` / `connectTimeout`, `enableOfflineQueue: false`) so Redis
 * outages never hang synchronous API requests indefinitely (BE-REL-003).
 */
export function createHttpRedisConnection(
  config: ConfigService,
  overrides?: {
    commandTimeout?: number;
    connectTimeout?: number;
    maxRetriesPerRequest?: number;
  },
): RedisConnection {
  const password = config.get<string>('REDIS_PASSWORD') || undefined;
  const mode = config.get<string>('REDIS_MODE') ?? 'standalone';
  const commandTimeout = overrides?.commandTimeout ?? 1500;
  const connectTimeout = overrides?.connectTimeout ?? 2000;
  const maxRetriesPerRequest = overrides?.maxRetriesPerRequest ?? 1;
  const retryStrategy = (times: number) => Math.min(times * 100, 2000);

  if (mode === 'cluster') {
    const nodes = resolveClusterNodes(config);
    return new Redis.Cluster(nodes, {
      enableOfflineQueue: false,
      redisOptions: {
        password,
        maxRetriesPerRequest,
        commandTimeout,
        connectTimeout,
      },
    });
  }

  return new Redis({
    host: config.get<string>('REDIS_HOST') ?? '127.0.0.1',
    port: config.get<number>('REDIS_PORT') ?? 6379,
    password,
    lazyConnect: true,
    maxRetriesPerRequest,
    commandTimeout,
    connectTimeout,
    enableOfflineQueue: false,
    retryStrategy,
  });
}

/**
 * Returns a process-shared HTTP-path Redis client keyed by connection target
 * to avoid socket explosion across monolith modules and readiness probes
 * (BE-PERF-004, OBS-005).
 */
export function getSharedHttpRedisConnection(
  config: ConfigService,
): RedisConnection {
  const mode = config.get<string>('REDIS_MODE') ?? 'standalone';
  const host = config.get<string>('REDIS_HOST') ?? '127.0.0.1';
  const port = config.get<number>('REDIS_PORT') ?? 6379;
  const clusterNodes = config.get<string>('REDIS_CLUSTER_NODES') ?? '';
  const hasPassword = Boolean(config.get<string>('REDIS_PASSWORD'));
  const cacheKey = `${mode}:${host}:${port}:${clusterNodes}:${hasPassword ? 'auth' : 'noauth'}`;

  const existing = sharedHttpClients.get(cacheKey);
  if (existing && existing.status !== 'end') {
    return existing;
  }

  const client = createHttpRedisConnection(config);
  sharedHttpClients.set(cacheKey, client);
  return client;
}

export function closeSharedHttpRedisConnections(): void {
  for (const [key, client] of sharedHttpClients.entries()) {
    if (client.status !== 'end') {
      client.disconnect();
    }
    sharedHttpClients.delete(key);
  }
}

export function bullmqPrefix(config: ConfigService): string {
  const prefix = config.get<string>('BULLMQ_PREFIX') ?? 'continuum';
  return config.get<string>('REDIS_MODE') === 'cluster' && !prefix.includes('{')
    ? `{${prefix}}`
    : prefix;
}
