import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import {
  ACCESS_TOKEN_LIFETIME_SECONDS,
  AccessTokenError,
  AccessTokenService,
  JwtConfigurationError,
  validateJwtSecret,
} from './access-token.service';
import { AccessTokenClaimsError } from './access-token.types';

const SECRET = '0123456789abcdef0123456789abcdef';

function createConfig(secret: unknown): ConfigService {
  return {
    get: jest.fn().mockReturnValue(secret),
  } as unknown as ConfigService;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signRawToken(payload: unknown): string {
  const signingInput = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}`;
  const signature = createHmac('sha256', SECRET)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

describe('AccessTokenService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('[FACT] follows the 15-minute token contract and requires orgId', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-26T00:00:00.000Z'));
    const service = new AccessTokenService(createConfig(SECRET));

    const token = service.signAccessToken({
      sub: 'user-123',
      email: 'person@example.com',
      orgId: 'org-456',
      roles: ['MEMBER'],
    });
    const [headerSegment, payloadSegment] = token.split('.');
    const header = JSON.parse(
      Buffer.from(headerSegment, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const payload = JSON.parse(
      Buffer.from(payloadSegment, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;

    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(payload).toMatchObject({
      sub: 'user-123',
      email: 'person@example.com',
      orgId: 'org-456',
      roles: ['MEMBER'],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_LIFETIME_SECONDS,
    });
    expect(typeof payload.jti).toBe('string');
    expect(service.verifyAccessToken(token)).toEqual(payload);
  });

  it('[DESIGN] verifies the HS256 signature before trusting token claims', () => {
    const service = new AccessTokenService(createConfig(SECRET));
    const token = service.signAccessToken({
      sub: 'user-123',
      email: 'person@example.com',
      orgId: 'org-456',
      roles: [],
    });
    const [header, , signature] = token.split('.');
    const alteredPayload = encode({ sub: 'other-user' });

    expect(() =>
      service.verifyAccessToken(`${header}.${alteredPayload}.${signature}`),
    ).toThrow(new AccessTokenError('INVALID_SIGNATURE'));
  });

  it('[FACT] rejects expired tokens and malformed input without leaking contents', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-26T00:00:00.000Z'));
    const service = new AccessTokenService(createConfig(SECRET));
    const token = service.signAccessToken({
      sub: 'user-123',
      email: 'person@example.com',
      orgId: 'org-456',
      roles: [],
    });
    jest.setSystemTime(
      new Date(Date.now() + ACCESS_TOKEN_LIFETIME_SECONDS * 1000),
    );

    expect(() => service.verifyAccessToken(token)).toThrow(
      new AccessTokenError('EXPIRED'),
    );
    expect(() =>
      service.verifyAccessToken('secret-bearing-malformed-token'),
    ).toThrow(new AccessTokenError('MALFORMED'));
  });

  it('[FACT] rejects signed payloads missing the required orgId claim', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-26T00:00:00.000Z'));
    const now = Math.floor(Date.now() / 1000);
    const token = signRawToken({
      sub: 'user-123',
      email: 'person@example.com',
      roles: ['MEMBER'],
      iat: now,
      exp: now + 60,
      jti: 'd9428888-122b-4f20-8f3b-6f96e5be2a5a',
    });

    expect(() =>
      new AccessTokenService(createConfig(SECRET)).verifyAccessToken(token),
    ).toThrow(new AccessTokenError('INVALID_CLAIMS'));
  });

  it('allows five seconds of issuer clock skew but rejects a larger offset', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-26T00:00:10.000Z'));
    const service = new AccessTokenService(createConfig(SECRET));
    const token = service.signAccessToken({
      sub: 'user-123',
      email: 'person@example.com',
      orgId: 'org-456',
      roles: [],
    });

    jest.setSystemTime(new Date('2026-09-26T00:00:05.000Z'));
    expect(() => service.verifyAccessToken(token)).not.toThrow();
    jest.setSystemTime(new Date('2026-09-26T00:00:04.000Z'));
    expect(() => service.verifyAccessToken(token)).toThrow(
      new AccessTokenError('INVALID_CLAIMS'),
    );
  });

  it('rejects claims with an excessive lifetime or unsupported fields', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-26T00:00:00.000Z'));
    const now = Math.floor(Date.now() / 1000);
    const baseClaims = {
      sub: 'user-123',
      email: 'person@example.com',
      orgId: 'org-456',
      roles: [],
      iat: now,
      jti: 'd9428888-122b-4f20-8f3b-6f96e5be2a5a',
    };
    const service = new AccessTokenService(createConfig(SECRET));

    expect(() =>
      service.verifyAccessToken(
        signRawToken({
          ...baseClaims,
          exp: now + ACCESS_TOKEN_LIFETIME_SECONDS + 1,
        }),
      ),
    ).toThrow(new AccessTokenError('INVALID_CLAIMS'));
    expect(() =>
      service.verifyAccessToken(
        signRawToken({ ...baseClaims, exp: now + 60, isAdmin: true }),
      ),
    ).toThrow(new AccessTokenError('INVALID_CLAIMS'));
  });

  it('rejects invalid claims at signing time', () => {
    const service = new AccessTokenService(createConfig(SECRET));

    expect(() =>
      service.signAccessToken({
        sub: 'user-123',
        email: 'person@example.com',
        orgId: '',
        roles: [],
      }),
    ).toThrow(AccessTokenClaimsError);
  });

  it('validates JWT_SECRET at startup and never includes its value in errors', () => {
    expect(() => validateJwtSecret(undefined)).toThrow(
      new JwtConfigurationError('JWT_SECRET_REQUIRED'),
    );
    expect(() => validateJwtSecret('short-secret')).toThrow(
      new JwtConfigurationError('JWT_SECRET_TOO_SHORT'),
    );
    expect(validateJwtSecret(SECRET)).toBe(SECRET);

    expect(() =>
      new AccessTokenService(createConfig(undefined)).onModuleInit(),
    ).toThrow('JWT_SECRET_REQUIRED');
    expect(() =>
      new AccessTokenService(createConfig('short-secret')).onModuleInit(),
    ).toThrow('JWT_SECRET_TOO_SHORT');

    expect(() =>
      new AccessTokenService(createConfig(undefined)).signAccessToken({
        sub: 'user-123',
        email: 'person@example.com',
        orgId: 'org-456',
        roles: [],
      }),
    ).toThrow('JWT_SECRET_REQUIRED');
  });
});
