import type { PasswordResetOutboxStore } from '../../application/authentication/password-reset.store';
import type { PasswordResetMailer } from '../../application/authentication/password-reset.mailer';
import { PasswordResetOutboxWorker } from './password-reset-outbox.worker';

describe('PasswordResetOutboxWorker', () => {
  let outbox: jest.Mocked<PasswordResetOutboxStore>;
  let mailer: jest.Mocked<PasswordResetMailer>;
  let worker: PasswordResetOutboxWorker;

  beforeEach(() => {
    outbox = {
      assertReady: jest.fn().mockResolvedValue(undefined),
      savePasswordResetRequest: jest.fn(),
      claimPasswordResetToken: jest.fn(),
      consumeClaimedPasswordResetToken: jest.fn(),
      releasePasswordResetTokenClaim: jest.fn(),
      claimNextPasswordResetEmail: jest.fn().mockResolvedValue({
        userScopeHash: 'a'.repeat(64),
        userId: '651a2b3c4d5e6f7a8b9c0d1e',
        tokenHash: 'b'.repeat(64),
        leaseId: 'lease-id',
        attemptCount: 1,
        encryptedPayload: 'v1.encrypted',
      }),
      failExhaustedPasswordResetEmails: jest.fn().mockResolvedValue(undefined),
      markPasswordResetEmailSent: jest.fn().mockResolvedValue(true),
      retryPasswordResetEmail: jest.fn().mockResolvedValue('REQUEUED'),
      decryptPasswordResetEmailPayload: jest.fn().mockReturnValue({
        recipientEmail: 'person@example.com',
        resetUrl: 'https://app.example.test/reset-password#token=secret',
      }),
    };
    mailer = { sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined) };
    worker = new PasswordResetOutboxWorker(outbox, mailer);
  });

  it('sends the decrypted email and marks the outbox item sent', async () => {
    await (worker as unknown as { poll(): Promise<void> }).poll();

    expect(mailer.sendPasswordResetEmail).toHaveBeenCalledWith(
      'person@example.com',
      'https://app.example.test/reset-password#token=secret',
    );
    expect(outbox.decryptPasswordResetEmailPayload).toHaveBeenCalledWith(
      'v1.encrypted',
      {
        userScopeHash: 'a'.repeat(64),
        userId: '651a2b3c4d5e6f7a8b9c0d1e',
        tokenHash: 'b'.repeat(64),
      },
    );
    expect(outbox.markPasswordResetEmailSent).toHaveBeenCalledWith(
      'b'.repeat(64),
      'lease-id',
      expect.any(Date),
    );
    expect(outbox.retryPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('schedules a bounded retry without logging SMTP details', async () => {
    mailer.sendPasswordResetEmail.mockRejectedValue(
      new Error('private SMTP transport details'),
    );
    const now = Date.now();

    await (worker as unknown as { poll(): Promise<void> }).poll();

    const [tokenHash, leaseId, nextAttemptAt, maxAttempts, safeErrorCode] =
      outbox.retryPasswordResetEmail.mock.calls[0];
    expect(tokenHash).toBe('b'.repeat(64));
    expect(leaseId).toBe('lease-id');
    expect(nextAttemptAt.getTime()).toBeGreaterThanOrEqual(now + 29_000);
    expect(nextAttemptAt.getTime()).toBeLessThanOrEqual(now + 31_000);
    expect(maxAttempts).toBe(5);
    expect(safeErrorCode).toBe('DELIVERY_FAILED');
  });

  it('backs off polling after an outbox dependency failure', async () => {
    outbox.assertReady.mockRejectedValueOnce(new Error('indexes missing'));
    const poll = () => (worker as unknown as { poll(): Promise<void> }).poll();

    await poll();
    await poll();

    expect(outbox.assertReady).toHaveBeenCalledTimes(1);
    expect(outbox.claimNextPasswordResetEmail).not.toHaveBeenCalled();
  });
});
