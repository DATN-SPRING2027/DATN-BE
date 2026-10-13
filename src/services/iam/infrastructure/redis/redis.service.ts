import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createRedisConnection,
  RedisConnection,
} from '../../../../common/redis/redis-connection';
import type { PasswordResetTokenStore } from '../../application/authentication/password-reset.store';

const SAVE_PASSWORD_RESET_TOKEN = `
  redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[3])
  redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3])
  return 1
`;

const CONSUME_PASSWORD_RESET_TOKEN = `
  local value = redis.call('get', KEYS[1])
  if not value then return false end
  local userScope, userId = string.match(value, '^([0-9a-f]+)|([0-9a-f]+)$')
  if not userScope or not userId then
    redis.call('del', KEYS[1])
    return false
  end
  local userKey = 'auth:{password-reset}:user:' .. userScope
  if redis.call('get', userKey) ~= ARGV[1] then
    redis.call('del', KEYS[1])
    return false
  end
  redis.call('del', KEYS[1], userKey)
  return userId
`;

const DISCARD_PASSWORD_RESET_TOKEN = `
  local userKey = 'auth:{password-reset}:user:' .. ARGV[1]
  if redis.call('get', userKey) ~= ARGV[2] then return 0 end
  redis.call('del', userKey, KEYS[1])
  return 1
`;

@Injectable()
export class RedisService implements OnModuleDestroy, PasswordResetTokenStore {
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

  async savePasswordResetToken(
    userScopeHash: string,
    tokenHash: string,
    userId: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.connect();
    await this.client.eval(
      SAVE_PASSWORD_RESET_TOKEN,
      2,
      `auth:{password-reset}:user:${userScopeHash}`,
      `auth:{password-reset}:token:${tokenHash}`,
      tokenHash,
      `${userScopeHash}|${userId}`,
      ttlSeconds,
    );
  }

  async consumePasswordResetToken(tokenHash: string): Promise<string | null> {
    await this.connect();
    const userId = await this.client.eval(
      CONSUME_PASSWORD_RESET_TOKEN,
      1,
      `auth:{password-reset}:token:${tokenHash}`,
      tokenHash,
    );
    return typeof userId === 'string' ? userId : null;
  }

  async discardPasswordResetToken(
    userScopeHash: string,
    tokenHash: string,
  ): Promise<void> {
    await this.connect();
    await this.client.eval(
      DISCARD_PASSWORD_RESET_TOKEN,
      1,
      `auth:{password-reset}:token:${tokenHash}`,
      userScopeHash,
      tokenHash,
    );
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
      "local count = redis.call('incr', KEYS[1]); if count == 1 then redis.call('expire', KEYS[1], ARGV[1]); end; return count",
      1,
      `rate:${key}`,
      windowSeconds,
    );
    return Number(count) <= limit;
  }
  clearRateLimit(key: string): Promise<void> {
    return this.delete(`rate:${key}`);
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
