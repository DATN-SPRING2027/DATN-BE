import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CONSUME_RATE_LIMIT_LUA,
  createHttpRedisConnection,
  createRedisConnection,
  RedisConnection,
} from '../../../../common/redis/redis-connection';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: RedisConnection;

  constructor(private readonly config: ConfigService) {
    this.client = createHttpRedisConnection(config);
    this.client.on('error', (error: Error) => {
      this.logger.warn(`Chat HTTP Redis error: ${error.message}`);
    });
  }

  async get(key: string): Promise<string | null> {
    await this.connect();
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.connect();
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
      return;
    }
    await this.client.set(key, value);
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    await this.connect();
    const value = await this.client.eval(
      "local next = redis.call('incr', KEYS[1]); redis.call('expire', KEYS[1], ARGV[1]); return next",
      1,
      key,
      ttlSeconds,
    );
    return Number(value);
  }

  async setIfAbsent(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    await this.connect();
    const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async delete(key: string): Promise<void> {
    await this.connect();
    await this.client.del(key);
  }

  async consume(key: string): Promise<string | null> {
    await this.connect();
    return (await this.client.eval(
      "local value = redis.call('get', KEYS[1]); if value then redis.call('del', KEYS[1]); end; return value",
      1,
      key,
    )) as string | null;
  }

  async publish(channel: string, value: string): Promise<void> {
    await this.connect();
    await this.client.publish(channel, value);
  }

  async subscribe(
    channel: string,
    onMessage: (value: string) => void,
    onDisconnect?: (error?: Error) => void,
  ): Promise<() => void> {
    const subscriber = createRedisConnection(this.config);
    let closed = false;
    subscriber.on('error', (error: Error) => {
      this.logger.warn(
        `Chat Redis subscriber error on ${channel}: ${error.message}`,
      );
      if (!closed) {
        onDisconnect?.(error);
      }
    });
    subscriber.on('end', () => {
      if (!closed) {
        onDisconnect?.();
      }
    });
    try {
      if (subscriber.status === 'wait') await subscriber.connect();
      subscriber.on('message', (receivedChannel, value) => {
        if (receivedChannel === channel && typeof value === 'string') {
          onMessage(value);
        }
      });
      await subscriber.subscribe(channel);
      return () => {
        closed = true;
        if (subscriber.status !== 'end') {
          subscriber.disconnect();
        }
      };
    } catch (error) {
      closed = true;
      if (subscriber.status !== 'end') {
        subscriber.disconnect();
      }
      throw error;
    }
  }

  async touchPresenceSession(
    key: string,
    sessionId: string,
    leaseMs: number,
  ): Promise<boolean> {
    await this.connect();
    const wasOffline = await this.client.eval(
      "local now = tonumber(ARGV[1]); redis.call('zremrangebyscore', KEYS[1], '-inf', now); local count = redis.call('zcard', KEYS[1]); redis.call('zadd', KEYS[1], tonumber(ARGV[2]), ARGV[3]); redis.call('pexpire', KEYS[1], tonumber(ARGV[4])); return count",
      1,
      key,
      Date.now(),
      Date.now() + leaseMs,
      sessionId,
      leaseMs * 2,
    );
    return Number(wasOffline) === 0;
  }

  async removePresenceSession(
    key: string,
    sessionId: string,
  ): Promise<boolean> {
    await this.connect();
    const remaining = await this.client.eval(
      "redis.call('zrem', KEYS[1], ARGV[1]); redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[2]); local count = redis.call('zcard', KEYS[1]); if count == 0 then redis.call('del', KEYS[1]); end; return count",
      1,
      key,
      sessionId,
      Date.now(),
    );
    return Number(remaining) === 0;
  }

  async isPresenceOnline(key: string): Promise<boolean> {
    await this.connect();
    const count = await this.client.eval(
      "redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1]); return redis.call('zcard', KEYS[1])",
      1,
      key,
      Date.now(),
    );
    return Number(count) > 0;
  }

  async arePresenceOnlineBatch(keys: string[]): Promise<boolean[]> {
    if (keys.length === 0) return [];
    await this.connect();
    const now = Date.now();
    const pipe = this.client.pipeline();
    for (const key of keys) {
      pipe.zremrangebyscore(key, '-inf', now);
      pipe.zcard(key);
    }
    const results = await pipe.exec();
    if (!results) return keys.map(() => false);
    const statuses: boolean[] = [];
    for (let index = 0; index < keys.length; index += 1) {
      const zcardEntry = results[index * 2 + 1];
      const err = zcardEntry?.[0];
      if (err) throw err;
      statuses.push(Number(zcardEntry?.[1] ?? 0) > 0);
    }
    return statuses;
  }

  revokeToken(tokenHash: string, ttlSeconds: number): Promise<void> {
    return this.set(`auth:blacklist:${tokenHash}`, '1', ttlSeconds);
  }

  async isTokenRevoked(tokenHash: string): Promise<boolean> {
    return (await this.get(`auth:blacklist:${tokenHash}`)) === '1';
  }

  async areTokensRevokedBatch(
    tokenHashes: string[],
  ): Promise<Map<string, boolean>> {
    const unique = [...new Set(tokenHashes)];
    const map = new Map<string, boolean>();
    if (unique.length === 0) return map;
    await this.connect();
    const pipe = this.client.pipeline();
    for (const hash of unique) {
      pipe.get(`auth:blacklist:${hash}`);
    }
    const results = await pipe.exec();
    if (!results) {
      for (const hash of unique) map.set(hash, false);
      return map;
    }
    for (let index = 0; index < unique.length; index += 1) {
      const entry = results[index];
      const err = entry?.[0];
      if (err) throw err;
      map.set(unique[index], entry?.[1] === '1');
    }
    return map;
  }

  async consumeRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean> {
    await this.connect();
    const count = await this.client.eval(
      CONSUME_RATE_LIMIT_LUA,
      1,
      `rate:${key}`,
      windowSeconds,
    );
    return Number(count) <= limit;
  }

  acquireLock(
    key: string,
    owner: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    return this.setIfAbsent(`lock:${key}`, owner, ttlSeconds);
  }

  async releaseLock(key: string, owner: string): Promise<boolean> {
    await this.connect();
    const result = await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      `lock:${key}`,
      owner,
    );
    return result === 1;
  }

  onModuleDestroy(): void {
    if (this.client.status !== 'end') {
      this.client.disconnect();
    }
  }

  private async connect(): Promise<void> {
    if (this.client.status === 'wait') {
      await this.client.connect();
    }
  }
}
