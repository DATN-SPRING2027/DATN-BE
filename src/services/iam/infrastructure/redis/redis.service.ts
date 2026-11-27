import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CONSUME_RATE_LIMIT_LUA,
  createHttpRedisConnection,
  RedisConnection,
} from '../../../../common/redis/redis-connection';
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: RedisConnection;

  constructor(config: ConfigService) {
    this.client = createHttpRedisConnection(config);
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
      CONSUME_RATE_LIMIT_LUA,
      1,
      `rate:${key}`,
      windowSeconds,
    );
    return Number(count) <= limit;
  }
  async isRateLimited(key: string, limit: number): Promise<boolean> {
    const raw = await this.get(`rate:${key}`);
    if (raw === null) return false;
    const count = Number(raw);
    return Number.isFinite(count) && count >= limit;
  }
  clearRateLimit(key: string): Promise<void> {
    return this.delete(`rate:${key}`);
  }
  async storeOneTimeToken(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.set(`ott:${key}`, value, ttlSeconds);
  }
  async consumeOneTimeToken(key: string): Promise<string | null> {
    await this.connect();
    const raw = await this.client.eval(
      "local v = redis.call('get', KEYS[1]); if v then redis.call('del', KEYS[1]); end; return v",
      1,
      `ott:${key}`,
    );
    return typeof raw === 'string' ? raw : null;
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

  async extendLock(
    key: string,
    owner: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    await this.connect();
    const result = await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      1,
      `lock:${key}`,
      owner,
      ttlSeconds * 1000,
    );
    return result === 1;
  }

  async publish(channel: string, value: string): Promise<void> {
    await this.connect();
    await this.client.publish(channel, value);
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
