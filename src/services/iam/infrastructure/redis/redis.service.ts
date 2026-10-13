import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createRedisConnection,
  RedisConnection,
} from '../../../../common/redis/redis-connection';
import type {
  PasswordResetTokenClaim,
  PasswordResetTokenStore,
} from '../../application/authentication/password-reset.store';

const SAVE_PASSWORD_RESET_TOKEN = `
  if redis.call('exists', KEYS[3]) == 1 then return 0 end
  redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[3])
  redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3])
  return 1
`;

const CLAIM_PASSWORD_RESET_TOKEN = `
  local value = redis.call('get', KEYS[1])
  if not value or value ~= ARGV[3] then return false end
  local userScope, userId = string.match(value, '^([0-9a-f]+)|([0-9a-f]+)$')
  if not userScope or not userId or userScope ~= ARGV[4] then return false end
  if redis.call('get', KEYS[2]) ~= ARGV[1] then return false end
  if redis.call('exists', KEYS[3]) == 1 then return false end
  local ttl = redis.call('pttl', KEYS[1])
  if ttl <= 0 then return false end
  if redis.call('set', KEYS[3], ARGV[2], 'PX', ttl, 'NX') then return value end
  return false
`;

const CONSUME_CLAIMED_PASSWORD_RESET_TOKEN = `
  local value = redis.call('get', KEYS[1])
  if not value then return 0 end
  local userScope = string.match(value, '^([0-9a-f]+)|')
  if userScope ~= ARGV[1] then return 0 end
  if redis.call('get', KEYS[2]) ~= ARGV[2] then return 0 end
  if redis.call('get', KEYS[3]) ~= ARGV[3] then return 0 end
  redis.call('del', KEYS[1], KEYS[2], KEYS[3])
  return 1
`;

const RELEASE_PASSWORD_RESET_TOKEN_CLAIM = `
  if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
  return redis.call('del', KEYS[1])
`;

const DISCARD_PASSWORD_RESET_TOKEN = `
  local userKey = 'auth:{password-reset}:user:' .. ARGV[1]
  local claimKey = 'auth:{password-reset}:claim:' .. ARGV[1]
  if redis.call('exists', claimKey) == 1 then return 0 end
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
  ): Promise<boolean> {
    await this.connect();
    const result = await this.client.eval(
      SAVE_PASSWORD_RESET_TOKEN,
      3,
      `auth:{password-reset}:user:${userScopeHash}`,
      `auth:{password-reset}:token:${tokenHash}`,
      `auth:{password-reset}:claim:${userScopeHash}`,
      tokenHash,
      `${userScopeHash}|${userId}`,
      ttlSeconds,
    );
    return Number(result) === 1;
  }

  async claimPasswordResetToken(
    tokenHash: string,
    claimId: string,
  ): Promise<PasswordResetTokenClaim | null> {
    await this.connect();
    const tokenKey = `auth:{password-reset}:token:${tokenHash}`;
    const tokenValue = await this.client.get(tokenKey);
    const match = tokenValue?.match(/^([0-9a-f]{64})\|([0-9a-f]{24})$/i);
    if (!tokenValue || !match) return null;
    const [, userScopeHash, userId] = match;
    const claimedValue = await this.client.eval(
      CLAIM_PASSWORD_RESET_TOKEN,
      3,
      tokenKey,
      `auth:{password-reset}:user:${userScopeHash}`,
      `auth:{password-reset}:claim:${userScopeHash}`,
      tokenHash,
      claimId,
      tokenValue,
      userScopeHash,
    );
    if (typeof claimedValue !== 'string') return null;
    return { userScopeHash, userId };
  }

  async consumeClaimedPasswordResetToken(
    tokenHash: string,
    userScopeHash: string,
    claimId: string,
  ): Promise<boolean> {
    await this.connect();
    const result = await this.client.eval(
      CONSUME_CLAIMED_PASSWORD_RESET_TOKEN,
      3,
      `auth:{password-reset}:token:${tokenHash}`,
      `auth:{password-reset}:user:${userScopeHash}`,
      `auth:{password-reset}:claim:${userScopeHash}`,
      userScopeHash,
      tokenHash,
      claimId,
    );
    return Number(result) === 1;
  }

  async releasePasswordResetTokenClaim(
    userScopeHash: string,
    claimId: string,
  ): Promise<void> {
    await this.connect();
    await this.client.eval(
      RELEASE_PASSWORD_RESET_TOKEN_CLAIM,
      1,
      `auth:{password-reset}:claim:${userScopeHash}`,
      claimId,
    );
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
