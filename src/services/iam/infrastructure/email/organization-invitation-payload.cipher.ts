import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const KEY_INFO = Buffer.from('continuum-iam-organization-invitation:v1');

export interface OrganizationInvitationTokenBinding {
  invitationId: string;
  organizationId: string;
  recipientEmail: string;
  tokenHash: string;
}

export class OrganizationInvitationPayloadCipherError extends Error {
  constructor() {
    super('Organization invitation delivery payload is unavailable');
    this.name = OrganizationInvitationPayloadCipherError.name;
  }
}

@Injectable()
export class OrganizationInvitationPayloadCipher {
  constructor(private readonly config: ConfigService) {}

  encryptToken(token: string, binding: OrganizationInvitationTokenBinding) {
    try {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
      cipher.setAAD(encodeBinding(binding));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify({ token }), 'utf8'),
        cipher.final(),
      ]);
      return [
        'v1',
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.');
    } catch {
      throw new OrganizationInvitationPayloadCipherError();
    }
  }

  decryptToken(
    encryptedToken: string,
    binding: OrganizationInvitationTokenBinding,
  ): string {
    try {
      const [version, encodedIv, encodedTag, encodedCiphertext, extra] =
        encryptedToken.split('.');
      if (
        version !== 'v1' ||
        !encodedIv ||
        !encodedTag ||
        !encodedCiphertext ||
        extra !== undefined
      )
        throw new OrganizationInvitationPayloadCipherError();
      const iv = Buffer.from(encodedIv, 'base64url');
      const tag = Buffer.from(encodedTag, 'base64url');
      if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH)
        throw new OrganizationInvitationPayloadCipherError();
      const decipher = createDecipheriv('aes-256-gcm', this.key(), iv);
      decipher.setAAD(encodeBinding(binding));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
      const payload: unknown = JSON.parse(plaintext);
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('token' in payload) ||
        typeof payload.token !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(payload.token)
      )
        throw new OrganizationInvitationPayloadCipherError();
      return payload.token;
    } catch {
      throw new OrganizationInvitationPayloadCipherError();
    }
  }

  private key(): Buffer {
    const configured = this.config.get<string>(
      'ORGANIZATION_INVITATION_OUTBOX_KEY',
    );
    const secret = configured?.trim()
      ? configured
      : this.config.get<string>('JWT_SECRET');
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32)
      throw new OrganizationInvitationPayloadCipherError();
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

function encodeBinding(binding: OrganizationInvitationTokenBinding): Buffer {
  return Buffer.from(
    JSON.stringify({
      invitationId: binding.invitationId,
      organizationId: binding.organizationId,
      recipientEmail: binding.recipientEmail,
      tokenHash: binding.tokenHash,
    }),
    'utf8',
  );
}
