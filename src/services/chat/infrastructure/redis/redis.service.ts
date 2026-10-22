import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createRedisConnection,
  RedisConnection,
} from '../../../../common/redis/redis-connection';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: RedisConnection;

  constructor(private readonly config: ConfigService) {
    this.client = createRedisConnection(config);
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
  ): Promise<() => void> {
    const subscriber = createRedisConnection(this.config);
    if (subscriber.status === 'wait') await subscriber.connect();
    subscriber.on('message', (receivedChannel, value) => {
      if (receivedChannel === channel && typeof value === 'string') {
        onMessage(value);
      }
    });
    await subscriber.subscribe(channel);
    return () => subscriber.disconnect();
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

  revokeToken(tokenHash: string, ttlSeconds: number): Promise<void> {
    return this.set(`auth:blacklist:${tokenHash}`, '1', ttlSeconds);
  }
  async isTokenRevoked(tokenHash: string): Promise<boolean> {
    return (await this.get(`auth:blacklist:${tokenHash}`)) === '1';
  }
  async consumeRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean> {
    await this.connect();
    const count = await this.client.eval(
      "local n = redis.call('incr', KEYS[1]); if n == 1 then redis.call('expire', KEYS[1], ARGV[1]); end; return n",
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
