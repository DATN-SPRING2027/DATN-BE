import type { ConfigService } from '@nestjs/config';
import {
  PasswordResetPayloadCipher,
  PasswordResetPayloadCipherError,
} from './password-reset-payload.cipher';

describe('PasswordResetPayloadCipher', () => {
  const secret = 'a'.repeat(40);
  let cipher: PasswordResetPayloadCipher;

  beforeEach(() => {
    cipher = new PasswordResetPayloadCipher({
      get: jest.fn((key: string) =>
        key === 'PASSWORD_RESET_OUTBOX_KEY' ? undefined : secret,
      ),
    } as unknown as ConfigService);
  });

  it('encrypts the email and reset URL without storing either in plaintext', () => {
    const payload = {
      recipientEmail: 'person@example.com',
      resetUrl: 'https://app.example.test/reset-password#token=secret',
    };

    const binding = {
      userScopeHash: 'a'.repeat(64),
      userId: '651a2b3c4d5e6f7a8b9c0d1e',
      tokenHash: 'b'.repeat(64),
    };
    const encrypted = cipher.encrypt(payload, binding);

    expect(encrypted).not.toContain(payload.recipientEmail);
    expect(encrypted).not.toContain('secret');
    expect(cipher.decrypt(encrypted, binding)).toEqual(payload);
    expect(() =>
      cipher.decrypt(encrypted, { ...binding, userId: '1'.repeat(24) }),
    ).toThrow(PasswordResetPayloadCipherError);
  });

  it('rejects tampered ciphertext and missing encryption configuration', () => {
    const encrypted = cipher.encrypt(
      {
        recipientEmail: 'person@example.com',
        resetUrl: 'https://app.example.test/reset-password#token=secret',
      },
      {
        userScopeHash: 'a'.repeat(64),
        userId: '651a2b3c4d5e6f7a8b9c0d1e',
        tokenHash: 'b'.repeat(64),
      },
    );
    const altered = `${encrypted.slice(0, -1)}x`;
    expect(() =>
      cipher.decrypt(altered, {
        userScopeHash: 'a'.repeat(64),
        userId: '651a2b3c4d5e6f7a8b9c0d1e',
        tokenHash: 'b'.repeat(64),
      }),
    ).toThrow(PasswordResetPayloadCipherError);

    const unavailable = new PasswordResetPayloadCipher({
      get: jest.fn(() => undefined),
    } as unknown as ConfigService);
    expect(() => unavailable.assertReady()).toThrow(
      PasswordResetPayloadCipherError,
    );
  });
});
