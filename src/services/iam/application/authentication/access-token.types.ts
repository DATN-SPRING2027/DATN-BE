export interface AccessTokenClaims {
  sub: string;
  email: string;
  orgId: string;
  roles: string[];
  activeProjectId?: string;
  iat: number;
  exp: number;
  jti: string;
}

export type AccessTokenClaimsInput = Pick<
  AccessTokenClaims,
  'sub' | 'email' | 'orgId' | 'roles'
> &
  Partial<Pick<AccessTokenClaims, 'activeProjectId'>>;

export type AccessTokenClaimsFailure =
  'MALFORMED' | 'EXPIRED' | 'INVALID_CLAIMS';

export class AccessTokenClaimsError extends Error {
  constructor(readonly reason: AccessTokenClaimsFailure) {
    super(`Access token claims are ${reason.toLowerCase()}`);
    this.name = AccessTokenClaimsError.name;
  }
}

const ALLOWED_CLAIM_NAMES = new Set([
  'sub',
  'email',
  'orgId',
  'roles',
  'activeProjectId',
  'iat',
  'exp',
  'jti',
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOCK_TOLERANCE_SECONDS = 5;

export function validateAccessTokenClaims(
  value: unknown,
  nowSeconds: number,
  maxLifetimeSeconds: number,
): AccessTokenClaims {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AccessTokenClaimsError('MALFORMED');
  }

  const claims = value as Record<string, unknown>;
  const keys = Object.keys(claims);
  if (
    keys.some((key) => !ALLOWED_CLAIM_NAMES.has(key)) ||
    !['sub', 'email', 'orgId', 'roles', 'iat', 'exp', 'jti'].every((key) =>
      Object.hasOwn(claims, key),
    )
  ) {
    throw new AccessTokenClaimsError('INVALID_CLAIMS');
  }

  const nonEmptyString = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && candidate.trim().length > 0;
  if (
    !nonEmptyString(claims.sub) ||
    !nonEmptyString(claims.email) ||
    !nonEmptyString(claims.orgId) ||
    !Array.isArray(claims.roles) ||
    !claims.roles.every(nonEmptyString) ||
    (Object.hasOwn(claims, 'activeProjectId') &&
      !nonEmptyString(claims.activeProjectId)) ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    typeof claims.jti !== 'string' ||
    !UUID_PATTERN.test(claims.jti)
  ) {
    throw new AccessTokenClaimsError('INVALID_CLAIMS');
  }

  const issuedAt = claims.iat as number;
  const expiresAt = claims.exp as number;
  if (expiresAt <= nowSeconds) {
    throw new AccessTokenClaimsError('EXPIRED');
  }
  if (
    issuedAt > nowSeconds + CLOCK_TOLERANCE_SECONDS ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > maxLifetimeSeconds
  ) {
    throw new AccessTokenClaimsError('INVALID_CLAIMS');
  }

  return {
    sub: claims.sub,
    email: claims.email,
    orgId: claims.orgId,
    roles: [...claims.roles],
    ...(typeof claims.activeProjectId === 'string'
      ? { activeProjectId: claims.activeProjectId }
      : {}),
    iat: issuedAt,
    exp: expiresAt,
    jti: claims.jti,
  };
}
