import type { ConfigService } from '@nestjs/config';
import { createRedisConnection } from '../../../../common/redis/redis-connection';
import { RedisService } from './redis.service';

jest.mock('../../../../common/redis/redis-connection', () => ({
  createRedisConnection: jest.fn(),
}));

describe('IAM RedisService password reset tokens', () => {
  const evalScript = jest.fn();
  const getValue = jest.fn();
  const client = {
    status: 'ready',
    eval: evalScript,
    get: getValue,
    disconnect: jest.fn(),
  };
  let redis: RedisService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(createRedisConnection).mockReturnValue(client as never);
    evalScript.mockResolvedValue(1);
    getValue.mockReset();
    redis = new RedisService({} as ConfigService);
  });

  it('stores the current token digest and account scope atomically in one cluster slot', async () => {
    const scopeHash = 'a'.repeat(64);
    const tokenHash = 'b'.repeat(64);
    const userId = '651a2b3c4d5e6f7a8b9c0d1e';

    await expect(
      redis.savePasswordResetToken(scopeHash, tokenHash, userId, 1800),
    ).resolves.toBe(true);

    expect(evalScript).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('exists', KEYS[3])"),
      3,
      `auth:{password-reset}:user:${scopeHash}`,
      `auth:{password-reset}:token:${tokenHash}`,
      `auth:{password-reset}:claim:${scopeHash}`,
      tokenHash,
      `${scopeHash}|${userId}`,
      1800,
    );
  });

  it('atomically claims only the current token and binds the claim to its TTL', async () => {
    const scopeHash = 'a'.repeat(64);
    const tokenHash = 'b'.repeat(64);
    const userId = '651a2b3c4d5e6f7a8b9c0d1e';
    const tokenValue = `${scopeHash}|${userId}`;
    const claimId = 'c'.repeat(43);
    getValue.mockResolvedValue(tokenValue);
    evalScript.mockResolvedValue(tokenValue);

    await expect(
      redis.claimPasswordResetToken(tokenHash, claimId),
    ).resolves.toEqual({ userScopeHash: scopeHash, userId });
    expect(evalScript).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('pttl', KEYS[1])"),
      3,
      `auth:{password-reset}:token:${tokenHash}`,
      `auth:{password-reset}:user:${scopeHash}`,
      `auth:{password-reset}:claim:${scopeHash}`,
      tokenHash,
      claimId,
      tokenValue,
      scopeHash,
    );
  });

  it('does not claim a token that was superseded after its scope lookup', async () => {
    const scopeHash = 'a'.repeat(64);
    const tokenHash = 'b'.repeat(64);
    const tokenValue = `${scopeHash}|651a2b3c4d5e6f7a8b9c0d1e`;
    getValue.mockResolvedValue(tokenValue);
    evalScript.mockResolvedValue(false);

    await expect(
      redis.claimPasswordResetToken(tokenHash, 'c'.repeat(43)),
    ).resolves.toBeNull();
  });

  it('releases only the matching in-flight claim without deleting the token', async () => {
    const scopeHash = 'a'.repeat(64);
    const claimId = 'c'.repeat(43);

    await redis.releasePasswordResetTokenClaim(scopeHash, claimId);

    expect(evalScript).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get', KEYS[1]) ~= ARGV[1]"),
      1,
      `auth:{password-reset}:claim:${scopeHash}`,
      claimId,
    );
  });

  it('discards only the matching current token when no claim is active', async () => {
    const scopeHash = 'a'.repeat(64);
    const tokenHash = 'b'.repeat(64);

    await redis.discardPasswordResetToken(scopeHash, tokenHash);

    expect(evalScript).toHaveBeenCalledWith(
      expect.stringContaining(
        "local claimKey = 'auth:{password-reset}:claim:'",
      ),
      1,
      `auth:{password-reset}:token:${tokenHash}`,
      scopeHash,
      tokenHash,
    );
  });
});
