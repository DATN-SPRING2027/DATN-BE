import type { ConfigService } from '@nestjs/config';
import { createRedisConnection } from '../../../../common/redis/redis-connection';
import { RedisService } from './redis.service';

jest.mock('../../../../common/redis/redis-connection', () => ({
  createRedisConnection: jest.fn(),
}));

describe('IAM RedisService password reset tokens', () => {
  const evalScript = jest.fn();
  const client = {
    status: 'ready',
    eval: evalScript,
    disconnect: jest.fn(),
  };
  let redis: RedisService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(createRedisConnection).mockReturnValue(client as never);
    evalScript.mockResolvedValue(1);
    redis = new RedisService({} as ConfigService);
  });

  it('stores the current token digest and account scope atomically in one cluster slot', async () => {
    const scopeHash = 'a'.repeat(64);
    const tokenHash = 'b'.repeat(64);
    const userId = '651a2b3c4d5e6f7a8b9c0d1e';

    await redis.savePasswordResetToken(scopeHash, tokenHash, userId, 1800);

    expect(evalScript).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('set', KEYS[1]"),
      2,
      `auth:{password-reset}:user:${scopeHash}`,
      `auth:{password-reset}:token:${tokenHash}`,
      tokenHash,
      `${scopeHash}|${userId}`,
      1800,
    );
  });

  it('atomically consumes only the current hashed token and returns its account ID', async () => {
    const tokenHash = 'b'.repeat(64);
    evalScript.mockResolvedValue('651a2b3c4d5e6f7a8b9c0d1e');

    await expect(redis.consumePasswordResetToken(tokenHash)).resolves.toBe(
      '651a2b3c4d5e6f7a8b9c0d1e',
    );
    expect(evalScript).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('del', KEYS[1], userKey)"),
      1,
      `auth:{password-reset}:token:${tokenHash}`,
      tokenHash,
    );
  });
});
