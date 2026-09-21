import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createRedisConnection,
  RedisConnection,
} from '../../../../common/redis/redis-connection';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: RedisConnection;

  constructor(config: ConfigService) {
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
    const count = await this.client.incr(`rate:${key}`);
    if (count === 1) await this.client.expire(`rate:${key}`, windowSeconds);
    return count <= limit;
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
