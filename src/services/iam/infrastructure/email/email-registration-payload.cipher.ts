import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import type {
  EmailRegistrationEmailPayload,
  EmailRegistrationEmailPayloadBinding,
} from '../../application/authentication/email-registration.store';

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_INFO = Buffer.from('continuum-iam-email-registration:v1');
const PAYLOAD_VERSION = 'v1';

export class EmailRegistrationPayloadCipherError extends Error {
  constructor() {
    super('Email registration email payload is unavailable');
    this.name = EmailRegistrationPayloadCipherError.name;
  }
}

@Injectable()
export class EmailRegistrationPayloadCipher {
  constructor(private readonly config: ConfigService) {}

  assertReady(): void {
    this.encryptionKey();
  }

  encrypt(
    payload: EmailRegistrationEmailPayload,
    binding: EmailRegistrationEmailPayloadBinding,
  ): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    cipher.setAAD(encodeBinding(binding));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    return [
      PAYLOAD_VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(
    encryptedPayload: string,
    binding: EmailRegistrationEmailPayloadBinding,
  ): EmailRegistrationEmailPayload {
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
        throw new EmailRegistrationPayloadCipherError();
      }
      const iv = Buffer.from(encodedIv, 'base64url');
      const authTag = Buffer.from(encodedTag, 'base64url');
      if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
        throw new EmailRegistrationPayloadCipherError();
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey(),
        iv,
      );
      decipher.setAAD(encodeBinding(binding));
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
      const payload: unknown = JSON.parse(plaintext);
      if (!isEmailRegistrationPayload(payload))
        throw new EmailRegistrationPayloadCipherError();
      return payload;
    } catch {
      throw new EmailRegistrationPayloadCipherError();
    }
  }

  private encryptionKey(): Buffer {
    const configured = this.config.get<string>('EMAIL_REGISTRATION_OUTBOX_KEY');
    const secret = configured?.trim()
      ? configured
      : this.config.get<string>('JWT_SECRET');
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new EmailRegistrationPayloadCipherError();
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

function encodeBinding(binding: EmailRegistrationEmailPayloadBinding): Buffer {
  return Buffer.from(
    JSON.stringify({
      normalizedEmail: binding.normalizedEmail,
      tokenHash: binding.tokenHash,
    }),
    'utf8',
  );
}

function isEmailRegistrationPayload(
  value: unknown,
): value is EmailRegistrationEmailPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.recipientEmail === 'string' &&
    payload.recipientEmail.length <= 320 &&
    typeof payload.verificationUrl === 'string' &&
    payload.verificationUrl.length <= 4096
  );
}
