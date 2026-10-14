import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createDecipheriv,
  createCipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import type {
  PasswordResetEmailPayload,
  PasswordResetEmailPayloadBinding,
} from '../../application/authentication/password-reset.store';

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_INFO = Buffer.from('continuum-iam-password-reset-email:v1');
const PAYLOAD_VERSION = 'v1';

export class PasswordResetPayloadCipherError extends Error {
  constructor() {
    super('Password reset email payload is unavailable');
    this.name = PasswordResetPayloadCipherError.name;
  }
}

@Injectable()
export class PasswordResetPayloadCipher {
  constructor(private readonly config: ConfigService) {}

  assertReady(): void {
    this.encryptionKey();
  }

  encrypt(
    payload: PasswordResetEmailPayload,
    binding: PasswordResetEmailPayloadBinding,
  ): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    cipher.setAAD(encodeBinding(binding));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return [
      PAYLOAD_VERSION,
      iv.toString('base64url'),
      authTag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(
    encryptedPayload: string,
    binding: PasswordResetEmailPayloadBinding,
  ): PasswordResetEmailPayload {
    try {
      const [version, encodedIv, encodedTag, encodedCiphertext, extra] =
        encryptedPayload.split('.');
      if (
        version !== PAYLOAD_VERSION ||
        !encodedIv ||
        !encodedTag ||
        !encodedCiphertext ||
        extra !== undefined
      ) {
        throw new PasswordResetPayloadCipherError();
      }
      const iv = Buffer.from(encodedIv, 'base64url');
      const authTag = Buffer.from(encodedTag, 'base64url');
      const ciphertext = Buffer.from(encodedCiphertext, 'base64url');
      if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
        throw new PasswordResetPayloadCipherError();
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey(),
        iv,
      );
      decipher.setAAD(encodeBinding(binding));
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
      const payload: unknown = JSON.parse(plaintext);
      if (!isPasswordResetEmailPayload(payload)) {
        throw new PasswordResetPayloadCipherError();
      }
      return payload;
    } catch {
      throw new PasswordResetPayloadCipherError();
    }
  }

  private encryptionKey(): Buffer {
    const secret =
      this.config.get<string>('PASSWORD_RESET_OUTBOX_KEY') ??
      this.config.get<string>('JWT_SECRET');
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new PasswordResetPayloadCipherError();
    }
    return Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(secret, 'utf8'),
        Buffer.alloc(0),
        KEY_INFO,
        KEY_LENGTH,
      ),
    );
  }
}

function encodeBinding(binding: PasswordResetEmailPayloadBinding): Buffer {
  return Buffer.from(
    JSON.stringify({
      userScopeHash: binding.userScopeHash,
      userId: binding.userId,
      tokenHash: binding.tokenHash,
    }),
    'utf8',
  );
}

function isPasswordResetEmailPayload(
  value: unknown,
): value is PasswordResetEmailPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.recipientEmail === 'string' &&
    payload.recipientEmail.length <= 320 &&
    typeof payload.resetUrl === 'string' &&
    payload.resetUrl.length <= 4096
  );
}
