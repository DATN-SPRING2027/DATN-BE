import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  AccessTokenClaimsError,
  type AccessTokenClaims,
  type AccessTokenClaimsInput,
  validateAccessTokenClaims,
} from './access-token.types';

export const ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;
const MAX_TOKEN_LENGTH = 8192;
const JWT_HEADER = Object.freeze({ alg: 'HS256', typ: 'JWT' });

export type JwtConfigurationFailure =
  'JWT_SECRET_REQUIRED' | 'JWT_SECRET_TOO_SHORT';

export class JwtConfigurationError extends Error {
  constructor(readonly reason: JwtConfigurationFailure) {
    super(`JWT configuration is invalid: ${reason}`);
    this.name = JwtConfigurationError.name;
  }
}

export function validateJwtSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new JwtConfigurationError('JWT_SECRET_REQUIRED');
  }
  if (value.length < 32) {
    throw new JwtConfigurationError('JWT_SECRET_TOO_SHORT');
  }
  return value;
}

export type AccessTokenFailure =
  'MALFORMED' | 'INVALID_SIGNATURE' | 'EXPIRED' | 'INVALID_CLAIMS';

export class AccessTokenError extends Error {
  constructor(readonly reason: AccessTokenFailure) {
    super(`Access token is ${reason.toLowerCase()}`);
    this.name = AccessTokenError.name;
  }
}

@Injectable()
export class AccessTokenService {
  constructor(private readonly config: ConfigService) {}

  signAccessToken(claims: AccessTokenClaimsInput): string {
    const issuedAt = Math.floor(Date.now() / 1000);
    const payload: AccessTokenClaims = {
      ...claims,
      iat: issuedAt,
      exp: issuedAt + ACCESS_TOKEN_LIFETIME_SECONDS,
      jti: randomUUID(),
    };
    validateAccessTokenClaims(payload, issuedAt, ACCESS_TOKEN_LIFETIME_SECONDS);

    const headerSegment = this.encodeJson(JWT_HEADER);
    const payloadSegment = this.encodeJson(payload);
    const signingInput = `${headerSegment}.${payloadSegment}`;
    const signature = this.sign(signingInput);
    return `${signingInput}.${signature}`;
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > MAX_TOKEN_LENGTH
    ) {
      throw new AccessTokenError('MALFORMED');
    }

    const segments = token.split('.');
    if (
      segments.length !== 3 ||
      segments.some((segment) => segment.length === 0)
    ) {
      throw new AccessTokenError('MALFORMED');
    }

    const header = this.decodeJson(segments[0]);
    if (
      typeof header !== 'object' ||
      header === null ||
      Array.isArray(header) ||
      Object.keys(header).length !== 2 ||
      (header as Record<string, unknown>).alg !== 'HS256' ||
      (header as Record<string, unknown>).typ !== 'JWT'
    ) {
      throw new AccessTokenError('MALFORMED');
    }

    const signingInput = `${segments[0]}.${segments[1]}`;
    const expectedSignature = Buffer.from(this.sign(signingInput), 'base64url');
    const providedSignature = this.decodeBase64Url(segments[2]);
    if (
      expectedSignature.length !== providedSignature.length ||
      !timingSafeEqual(expectedSignature, providedSignature)
    ) {
      throw new AccessTokenError('INVALID_SIGNATURE');
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    try {
      return validateAccessTokenClaims(
        this.decodeJson(segments[1]),
        nowSeconds,
        ACCESS_TOKEN_LIFETIME_SECONDS,
      );
    } catch (error) {
      if (error instanceof AccessTokenClaimsError) {
        throw new AccessTokenError(error.reason);
      }
      throw new AccessTokenError('INVALID_CLAIMS');
    }
  }

  private sign(signingInput: string): string {
    const secret = validateJwtSecret(this.config.get<unknown>('JWT_SECRET'));
    return createHmac('sha256', secret)
      .update(signingInput)
      .digest('base64url');
  }

  private encodeJson(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  private decodeBase64Url(value: string): Buffer {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new AccessTokenError('MALFORMED');
    }
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) {
      throw new AccessTokenError('MALFORMED');
    }
    return decoded;
  }

  private decodeJson(value: string): unknown {
    try {
      const decoded = this.decodeBase64Url(value);
      return JSON.parse(decoded.toString('utf8')) as unknown;
    } catch {
      throw new AccessTokenError('MALFORMED');
    }
  }
}
