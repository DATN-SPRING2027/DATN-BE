import { createHash } from 'node:crypto';
import type {
  AuthenticationAccount,
  AuthenticationRepositoryPort,
} from './authentication.repository';
import type { AuthSecurityStore } from './auth-security.store';
import type { PasswordCredentialService } from '../credentials/password-credential.service';
import type { PasswordResetOutboxStore } from './password-reset.store';
import {
  PasswordResetInvalidTokenError,
  PasswordResetPasswordPolicyError,
  PasswordResetRateLimitError,
  PasswordResetRequestUnavailableError,
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
  let outbox: jest.Mocked<PasswordResetOutboxStore>;
  let credentials: jest.Mocked<Pick<PasswordCredentialService, 'hashPassword'>>;
  let service: PasswordResetService;

  beforeEach(() => {
    repository = {
      findAccountByEmail: jest.fn().mockResolvedValue(account),
      resetPassword: jest.fn().mockResolvedValue(true),
    };
    security = { consumeRateLimit: jest.fn().mockResolvedValue(true) };
    outbox = {
      assertReady: jest.fn().mockResolvedValue(undefined),
      savePasswordResetRequest: jest.fn().mockResolvedValue('SAVED'),
      claimPasswordResetToken: jest.fn().mockResolvedValue({
        userScopeHash: createHash('sha256').update(USER_ID).digest('hex'),
        userId: USER_ID,
      }),
      consumeClaimedPasswordResetToken: jest.fn().mockResolvedValue(true),
      releasePasswordResetTokenClaim: jest.fn().mockResolvedValue(undefined),
      claimNextPasswordResetEmail: jest.fn().mockResolvedValue(null),
      failExhaustedPasswordResetEmails: jest.fn().mockResolvedValue(undefined),
      markPasswordResetEmailSent: jest.fn().mockResolvedValue(true),
      retryPasswordResetEmail: jest.fn().mockResolvedValue('REQUEUED'),
      decryptPasswordResetEmailPayload: jest.fn(),
    };
    credentials = { hashPassword: jest.fn().mockResolvedValue('new-hash') };
    service = new PasswordResetService(
      repository as unknown as AuthenticationRepositoryPort,
      security as unknown as AuthSecurityStore,
      outbox,
      credentials as unknown as PasswordCredentialService,
      { get: jest.fn().mockReturnValue('https://app.example.test') } as never,
    );
  });

  it('durably queues a 30-minute, hashed, single-use token for an active account', async () => {
    await expect(
      service.requestReset({
        email: ' PERSON@EXAMPLE.COM ',
        sourceIp: '203.0.113.8',
      }),
    ).resolves.toEqual({ status: 'accepted' });

    expect(outbox.savePasswordResetRequest).toHaveBeenCalledTimes(1);
    const [queued] = outbox.savePasswordResetRequest.mock.calls[0];
    const payload = queued.payload;
    if (!payload) throw new Error('Expected a queued email payload');
    const resetLink = payload.resetUrl;
    const token = new URLSearchParams(new URL(resetLink).hash.slice(1)).get(
      'token',
    );
    expect(queued.userScopeHash).toBe(
      createHash('sha256').update(USER_ID).digest('hex'),
    );
    expect(queued.userId).toBe(USER_ID);
    expect(queued.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(queued.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 30 * 60 * 1000,
    );
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(queued.tokenHash).toBe(
      createHash('sha256').update(token!).digest('hex'),
    );
    expect(queued.tokenHash).not.toBe(token);
    expect(payload.recipientEmail).toBe(account.email);
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
    expect(outbox.savePasswordResetRequest).toHaveBeenCalledTimes(1);
    expect(
      outbox.savePasswordResetRequest.mock.calls[0][0].payload,
    ).toBeUndefined();
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
    const [queued] = outbox.savePasswordResetRequest.mock.calls[0];
    expect(queued.payload?.recipientEmail).toBe(account.email);
    expect(queued.payload?.resetUrl).toContain('token=');
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

  it('returns a generic service-unavailable error if the request cannot be durably queued', async () => {
    outbox.savePasswordResetRequest.mockRejectedValue(new Error('database'));

    await expect(
      service.requestReset({ email: account.email, sourceIp: '203.0.113.8' }),
    ).rejects.toBeInstanceOf(PasswordResetRequestUnavailableError);
  });

  it('returns the generic acknowledgement when a current reset is already in flight', async () => {
    outbox.savePasswordResetRequest.mockResolvedValue('COALESCED');

    await expect(
      service.requestReset({ email: account.email, sourceIp: '203.0.113.8' }),
    ).resolves.toEqual({ status: 'accepted' });
  });

  it('does not acknowledge a request that could not be durably queued', async () => {
    outbox.savePasswordResetRequest.mockResolvedValue('NOT_SAVED');

    await expect(
      service.requestReset({ email: account.email, sourceIp: '203.0.113.8' }),
    ).rejects.toBeInstanceOf(PasswordResetRequestUnavailableError);
  });

  it('checks outbox readiness before looking up the account', async () => {
    outbox.assertReady.mockRejectedValue(
      new Error('outbox indexes unavailable'),
    );

    await expect(
      service.requestReset({ email: account.email, sourceIp: '203.0.113.8' }),
    ).rejects.toBeInstanceOf(PasswordResetRequestUnavailableError);
    expect(repository.findAccountByEmail).not.toHaveBeenCalled();
    expect(outbox.savePasswordResetRequest).not.toHaveBeenCalled();
  });

  it('maps rate-limit backend failures to the generic unavailable error', async () => {
    security.consumeRateLimit.mockRejectedValueOnce(new Error('redis offline'));

    await expect(
      service.requestReset({ email: account.email, sourceIp: '203.0.113.8' }),
    ).rejects.toBeInstanceOf(PasswordResetRequestUnavailableError);
    expect(repository.findAccountByEmail).not.toHaveBeenCalled();
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
    const claimId = outbox.claimPasswordResetToken.mock.calls[0][1];
    expect(outbox.claimPasswordResetToken).toHaveBeenCalledWith(
      tokenHash,
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    );
    expect(outbox.consumeClaimedPasswordResetToken).toHaveBeenCalledWith(
      tokenHash,
      createHash('sha256').update(USER_ID).digest('hex'),
      claimId,
    );
    expect(
      outbox.consumeClaimedPasswordResetToken.mock.invocationCallOrder[0],
    ).toBeGreaterThan(repository.resetPassword.mock.invocationCallOrder[0]);
    expect(outbox.releasePasswordResetTokenClaim).not.toHaveBeenCalled();
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

    const claimId = outbox.claimPasswordResetToken.mock.calls[0][1];
    expect(outbox.releasePasswordResetTokenClaim).toHaveBeenCalledWith(
      createHash('sha256').update(USER_ID).digest('hex'),
      claimId,
    );
    expect(outbox.consumeClaimedPasswordResetToken).not.toHaveBeenCalled();
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

    const claimId = outbox.claimPasswordResetToken.mock.calls[0][1];
    expect(outbox.releasePasswordResetTokenClaim).toHaveBeenCalledWith(
      createHash('sha256').update(USER_ID).digest('hex'),
      claimId,
    );
    expect(outbox.consumeClaimedPasswordResetToken).not.toHaveBeenCalled();
  });

  it('does not hash or update the password when the token cannot be claimed', async () => {
    outbox.claimPasswordResetToken.mockResolvedValue(null);

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
    expect(outbox.consumeClaimedPasswordResetToken).toHaveBeenCalledTimes(1);
    expect(outbox.releasePasswordResetTokenClaim).not.toHaveBeenCalled();
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
    expect(outbox.claimPasswordResetToken).not.toHaveBeenCalled();
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
    outbox.claimPasswordResetToken.mockResolvedValue(null);

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
