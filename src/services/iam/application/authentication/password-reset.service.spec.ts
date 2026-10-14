import { createHash } from 'node:crypto';
import type {
  AuthenticationAccount,
  AuthenticationRepositoryPort,
} from './authentication.repository';
import type { AuthSecurityStore } from './auth-security.store';
import type { PasswordCredentialService } from '../credentials/password-credential.service';
import type { PasswordResetTokenStore } from './password-reset.store';
import type { PasswordResetMailer } from './password-reset.mailer';
import {
  PasswordResetInvalidTokenError,
  PasswordResetPasswordPolicyError,
  PasswordResetRateLimitError,
  PasswordResetService,
} from './password-reset.service';

const USER_ID = '651a2b3c4d5e6f7a8b9c0d1e';
const account: AuthenticationAccount = {
  userId: USER_ID,
  email: 'person@example.com',
  name: 'Test Person',
  passwordHash: '$2b$12$existing-hash',
  status: 'ACTIVE',
  twoFactorEnabled: false,
};

describe('PasswordResetService', () => {
  let repository: jest.Mocked<
    Pick<AuthenticationRepositoryPort, 'findAccountByEmail' | 'resetPassword'>
  >;
  let security: jest.Mocked<Pick<AuthSecurityStore, 'consumeRateLimit'>>;
  let tokens: jest.Mocked<PasswordResetTokenStore>;
  let credentials: jest.Mocked<Pick<PasswordCredentialService, 'hashPassword'>>;
  let mailer: jest.Mocked<PasswordResetMailer>;
  let service: PasswordResetService;

  beforeEach(() => {
    repository = {
      findAccountByEmail: jest.fn().mockResolvedValue(account),
      resetPassword: jest.fn().mockResolvedValue(true),
    };
    security = { consumeRateLimit: jest.fn().mockResolvedValue(true) };
    tokens = {
      savePasswordResetToken: jest.fn().mockResolvedValue(true),
      claimPasswordResetToken: jest.fn().mockResolvedValue({
        userScopeHash: createHash('sha256').update(USER_ID).digest('hex'),
        userId: USER_ID,
      }),
      consumeClaimedPasswordResetToken: jest.fn().mockResolvedValue(true),
      releasePasswordResetTokenClaim: jest.fn().mockResolvedValue(undefined),
      discardPasswordResetToken: jest.fn().mockResolvedValue(undefined),
    };
    credentials = { hashPassword: jest.fn().mockResolvedValue('new-hash') };
    mailer = { sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined) };
    service = new PasswordResetService(
      repository as unknown as AuthenticationRepositoryPort,
      security as unknown as AuthSecurityStore,
      tokens,
      credentials as unknown as PasswordCredentialService,
      mailer,
      { get: jest.fn().mockReturnValue('https://app.example.test') } as never,
    );
  });

  it('responds generically and emails a 30-minute, hashed, single-use token to an active account', async () => {
    await expect(
      service.requestReset({
        email: ' PERSON@EXAMPLE.COM ',
        sourceIp: '203.0.113.8',
      }),
    ).resolves.toEqual({ status: 'accepted' });

    await new Promise<void>((resolve) => setImmediate(resolve));

    const [userScope, tokenHash, userId, ttlSeconds] =
      tokens.savePasswordResetToken.mock.calls[0];
    const resetLink = mailer.sendPasswordResetEmail.mock.calls[0][1];
    const token = new URLSearchParams(new URL(resetLink).hash.slice(1)).get(
      'token',
    );
    expect(userScope).toBe(createHash('sha256').update(USER_ID).digest('hex'));
    expect(userId).toBe(USER_ID);
    expect(ttlSeconds).toBe(30 * 60);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toBe(createHash('sha256').update(token!).digest('hex'));
    expect(tokenHash).not.toBe(token);
    expect(mailer.sendPasswordResetEmail.mock.calls[0][0]).toBe(account.email);
    const parsedResetLink = new URL(resetLink);
    expect(parsedResetLink.origin).toBe('https://app.example.test');
    expect(parsedResetLink.pathname).toBe('/reset-password');
    expect(parsedResetLink.search).toBe('');
    expect(parsedResetLink.hash).toMatch(/^#token=[A-Za-z0-9_-]{43}$/);
  });

  it.each<[string, AuthenticationAccount | null]>([
    ['missing account', null],
    ['inactive account', { ...account, status: 'SUSPENDED' }],
  ])('returns the same accepted response for a %s', async (_reason, found) => {
    repository.findAccountByEmail.mockResolvedValue(found);

    await expect(
      service.requestReset({ email: account.email, sourceIp: '203.0.113.8' }),
    ).resolves.toEqual({ status: 'accepted' });
    expect(tokens.savePasswordResetToken).toHaveBeenCalledTimes(1);
    expect(tokens.discardPasswordResetToken).toHaveBeenCalledTimes(1);
    expect(mailer.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('lets an active Google-only account set a local password through its verified email', async () => {
    repository.findAccountByEmail.mockResolvedValue({
      ...account,
      passwordHash: '',
      googleSubject: 'google-subject',
    });

    await expect(
      service.requestReset({ email: account.email, sourceIp: '203.0.113.8' }),
    ).resolves.toEqual({ status: 'accepted' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mailer.sendPasswordResetEmail).toHaveBeenCalledWith(
      account.email,
      expect.stringContaining('token='),
    );
  });

  it('does not reveal account email or IP in rate-limit keys', async () => {
    await service.requestReset({
      email: account.email,
      sourceIp: '203.0.113.8',
    });

    const keys = security.consumeRateLimit.mock.calls.map(([key]) => key);
    expect(keys).toHaveLength(2);
    expect(keys.join(' ')).not.toContain(account.email);
    expect(keys.join(' ')).not.toContain('203.0.113.8');
  });

  it('rate limits by source before account lookup', async () => {
    security.consumeRateLimit.mockResolvedValueOnce(false);

    await expect(
      service.requestReset({ email: account.email, sourceIp: '203.0.113.8' }),
    ).rejects.toBeInstanceOf(PasswordResetRateLimitError);
    expect(repository.findAccountByEmail).not.toHaveBeenCalled();
  });

  it('removes a reset token when email delivery fails and keeps the response generic', async () => {
    mailer.sendPasswordResetEmail.mockRejectedValue(new Error('SMTP details'));

    await expect(
      service.requestReset({ email: account.email, sourceIp: '203.0.113.8' }),
    ).resolves.toEqual({ status: 'accepted' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(tokens.discardPasswordResetToken).toHaveBeenCalledWith(
      createHash('sha256').update(USER_ID).digest('hex'),
      expect.any(String),
    );
  });

  it('claims a valid token, commits the password reset, then consumes the token', async () => {
    await expect(
      service.completeReset({
        token: 'a'.repeat(43),
        password: 'A-long-password-123',
        sourceIp: '203.0.113.8',
      }),
    ).resolves.toBeUndefined();

    const tokenHash = createHash('sha256').update('a'.repeat(43)).digest('hex');
    const claimId = tokens.claimPasswordResetToken.mock.calls[0][1];
    expect(tokens.claimPasswordResetToken).toHaveBeenCalledWith(
      tokenHash,
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    );
    expect(tokens.consumeClaimedPasswordResetToken).toHaveBeenCalledWith(
      tokenHash,
      createHash('sha256').update(USER_ID).digest('hex'),
      claimId,
    );
    expect(
      tokens.consumeClaimedPasswordResetToken.mock.invocationCallOrder[0],
    ).toBeGreaterThan(repository.resetPassword.mock.invocationCallOrder[0]);
    expect(tokens.releasePasswordResetTokenClaim).not.toHaveBeenCalled();
    expect(credentials.hashPassword).toHaveBeenCalledWith(
      'A-long-password-123',
    );
    expect(repository.resetPassword).toHaveBeenCalledWith(USER_ID, 'new-hash');
  });

  it('releases the claim and preserves the token when password hashing fails', async () => {
    credentials.hashPassword.mockRejectedValueOnce(new Error('hash failure'));

    await expect(
      service.completeReset({
        token: 'd'.repeat(43),
        password: 'A-long-password-123',
        sourceIp: '203.0.113.8',
      }),
    ).rejects.toThrow('hash failure');

    const claimId = tokens.claimPasswordResetToken.mock.calls[0][1];
    expect(tokens.releasePasswordResetTokenClaim).toHaveBeenCalledWith(
      createHash('sha256').update(USER_ID).digest('hex'),
      claimId,
    );
    expect(tokens.consumeClaimedPasswordResetToken).not.toHaveBeenCalled();
    expect(repository.resetPassword).not.toHaveBeenCalled();
  });

  it('releases the claim and preserves the token when the database transaction fails', async () => {
    repository.resetPassword.mockRejectedValueOnce(
      new Error('transaction failure'),
    );

    await expect(
      service.completeReset({
        token: 'e'.repeat(43),
        password: 'A-long-password-123',
        sourceIp: '203.0.113.8',
      }),
    ).rejects.toThrow('transaction failure');

    const claimId = tokens.claimPasswordResetToken.mock.calls[0][1];
    expect(tokens.releasePasswordResetTokenClaim).toHaveBeenCalledWith(
      createHash('sha256').update(USER_ID).digest('hex'),
      claimId,
    );
    expect(tokens.consumeClaimedPasswordResetToken).not.toHaveBeenCalled();
  });

  it('does not hash or update the password when the token cannot be claimed', async () => {
    tokens.claimPasswordResetToken.mockResolvedValue(null);

    await expect(
      service.completeReset({
        token: 'b'.repeat(43),
        password: 'A-long-password-123',
        sourceIp: '203.0.113.8',
      }),
    ).rejects.toBeInstanceOf(PasswordResetInvalidTokenError);
    expect(credentials.hashPassword).not.toHaveBeenCalled();
    expect(repository.resetPassword).not.toHaveBeenCalled();
  });

  it('consumes the claimed token if the account is no longer active', async () => {
    repository.resetPassword.mockResolvedValue(false);

    await expect(
      service.completeReset({
        token: 'c'.repeat(43),
        password: 'A-long-password-123',
        sourceIp: '203.0.113.8',
      }),
    ).rejects.toBeInstanceOf(PasswordResetInvalidTokenError);
    expect(tokens.consumeClaimedPasswordResetToken).toHaveBeenCalledTimes(1);
    expect(tokens.releasePasswordResetTokenClaim).not.toHaveBeenCalled();
  });

  it('rejects passwords shorter than 12 characters or longer than 72 UTF-8 bytes', async () => {
    for (const password of ['é'.repeat(11), 'é'.repeat(37)]) {
      await expect(
        service.completeReset({
          token: 'a'.repeat(43),
          password,
          sourceIp: '203.0.113.8',
        }),
      ).rejects.toBeInstanceOf(PasswordResetPasswordPolicyError);
    }

    expect(security.consumeRateLimit).not.toHaveBeenCalled();
    expect(tokens.claimPasswordResetToken).not.toHaveBeenCalled();
    expect(credentials.hashPassword).not.toHaveBeenCalled();
    expect(repository.resetPassword).not.toHaveBeenCalled();
  });

  it('allows a 12-character password exactly at the 72-byte UTF-8 limit', async () => {
    await expect(
      service.completeReset({
        token: 'a'.repeat(43),
        password: '😀'.repeat(18),
        sourceIp: '203.0.113.8',
      }),
    ).resolves.toBeUndefined();
    expect(credentials.hashPassword).toHaveBeenCalledWith('😀'.repeat(18));
  });

  it('rejects an absent, expired, superseded or already used token without changing a password', async () => {
    tokens.claimPasswordResetToken.mockResolvedValue(null);

    await expect(
      service.completeReset({
        token: 'b'.repeat(43),
        password: 'A-long-password-123',
        sourceIp: '203.0.113.8',
      }),
    ).rejects.toBeInstanceOf(PasswordResetInvalidTokenError);
    expect(credentials.hashPassword).not.toHaveBeenCalled();
    expect(repository.resetPassword).not.toHaveBeenCalled();
  });

  it('does not complete a reset if the account is no longer active', async () => {
    repository.resetPassword.mockResolvedValue(false);

    await expect(
      service.completeReset({
        token: 'c'.repeat(43),
        password: 'A-long-password-123',
        sourceIp: '203.0.113.8',
      }),
    ).rejects.toBeInstanceOf(PasswordResetInvalidTokenError);
  });
});
