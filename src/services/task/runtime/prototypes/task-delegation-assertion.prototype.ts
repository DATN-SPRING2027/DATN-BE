import {
  createPublicKey,
  KeyObject,
  verify as verifySignature,
} from 'node:crypto';
import {
  TaskInboundContextVerificationError,
  TaskInboundContextVerifier,
  type TaskInboundContext,
} from '../task-inbound-context';

const MAX_TOKEN_LENGTH = 8192;
const MAX_ASSERTION_LIFETIME_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 5;
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TaskDelegationAssertionFailure = Exclude<
  ConstructorParameters<typeof TaskInboundContextVerificationError>[0],
  | 'MISSING_CONTEXT'
  | 'MALFORMED_CONTEXT'
  | 'VERIFIER_UNAVAILABLE'
  | 'VERIFICATION_FAILED'
>;

export class TaskDelegationAssertionError extends TaskInboundContextVerificationError {
  constructor(readonly reason: TaskDelegationAssertionFailure) {
    super(reason);
    this.name = TaskDelegationAssertionError.name;
  }
}

export interface TaskDelegationRequestBinding {
  method: string;
  target: string;
  projectId: string;
  /** Application claim required when the bound request carries a body. */
  bodySha256?: string;
  nowSeconds?: number;
}

/**
 * Synchronous lookup over a key set already loaded by its owner. A missing
 * `kid` is distinct from provider failure; token-controlled values must never
 * choose a key source or URL.
 */
export interface TaskDelegationVerificationKeyProvider {
  getPublicKey(keyId: string): KeyObject | string | Buffer | undefined;
}

export interface TaskDelegationVerifierOptions {
  issuer: string;
  audience: string;
  gatewayServiceId: string;
  /** OAuth client identity expected in the RFC 9068 `client_id` claim. */
  expectedClientId: string;
  /** Exact verifier profile selected by its owner; there is no default. */
  signatureAlgorithm: 'RS256' | 'EdDSA';
  /** Exact JOSE `typ` value selected by its owner; there is no default. */
  tokenType: string;
  keyProvider: TaskDelegationVerificationKeyProvider;
}

export type TrustedTaskDelegationContext = TaskInboundContext;

export interface TaskDelegationReplayEvidence {
  issuer: string;
  tokenId: string;
  retainUntil: Date;
}

export interface TaskDelegationVerifiedAssertion {
  context: TrustedTaskDelegationContext;
  replay: TaskDelegationReplayEvidence;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TaskDelegationAssertionError('MALFORMED');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new TaskDelegationAssertionError('MALFORMED');
  }
  return decoded;
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(decodeBase64Url(value).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof TaskDelegationAssertionError) throw error;
    throw new TaskDelegationAssertionError('MALFORMED');
  }
}

function hasExactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isIntegerClaim(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isSha256Base64Url(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 32 && decoded.toString('base64url') === value;
}

function containsPrivatePem(value: string | Buffer): boolean {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(text);
}

function isValidTokenType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function isRequestBinding(
  value: unknown,
): value is TaskDelegationRequestBinding {
  if (
    !isRecord(value) ||
    typeof value.method !== 'string' ||
    typeof value.target !== 'string' ||
    typeof value.projectId !== 'string' ||
    (value.bodySha256 !== undefined && !isSha256Base64Url(value.bodySha256)) ||
    (value.nowSeconds !== undefined && !isIntegerClaim(value.nowSeconds))
  ) {
    return false;
  }

  return Object.keys(value).every((key) =>
    ['method', 'target', 'projectId', 'bodySha256', 'nowSeconds'].includes(key),
  );
}

/**
 * Isolated D-04 prototype only. This provider verifies an IAM-issued,
 * Task-audience, request-bound assertion when explicitly injected. It does not
 * authenticate the mTLS peer, authorize a Task operation, resolve a Task's
 * owning Project, or prevent replay; production use requires those independent
 * controls and Security approval.
 */
export class TaskDelegationAssertionPrototypeVerifier implements TaskInboundContextVerifier {
  constructor(private readonly options: TaskDelegationVerifierOptions) {
    if (
      typeof options.issuer !== 'string' ||
      options.issuer.length === 0 ||
      typeof options.audience !== 'string' ||
      options.audience.length === 0 ||
      typeof options.gatewayServiceId !== 'string' ||
      options.gatewayServiceId.length === 0 ||
      typeof options.expectedClientId !== 'string' ||
      options.expectedClientId.length === 0 ||
      (options.signatureAlgorithm !== 'RS256' &&
        options.signatureAlgorithm !== 'EdDSA') ||
      !isValidTokenType(options.tokenType) ||
      !options.keyProvider ||
      typeof options.keyProvider.getPublicKey !== 'function'
    ) {
      throw new Error('Task delegation verifier configuration is invalid');
    }
  }

  verify(
    token: unknown,
    requestBinding: unknown,
  ): TrustedTaskDelegationContext {
    return this.verifyWithReplayEvidence(token, requestBinding).context;
  }

  /** Prototype-only verified metadata for an explicitly injected consumer. */
  verifyWithReplayEvidence(
    token: unknown,
    requestBinding: unknown,
  ): TaskDelegationVerifiedAssertion {
    if (!isRequestBinding(requestBinding)) {
      throw new TaskDelegationAssertionError('MALFORMED');
    }

    return verifyTaskDelegationAssertionPrototype(
      token,
      requestBinding,
      this.options,
    );
  }
}

function verifyTaskDelegationAssertionPrototype(
  token: unknown,
  request: TaskDelegationRequestBinding,
  options: TaskDelegationVerifierOptions,
): TaskDelegationVerifiedAssertion {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    throw new TaskDelegationAssertionError('MALFORMED');
  }

  const segments = token.split('.');
  if (
    segments.length !== 3 ||
    segments.some((segment) => segment.length === 0)
  ) {
    throw new TaskDelegationAssertionError('MALFORMED');
  }

  const header = decodeJson(segments[0]);
  if (
    !isRecord(header) ||
    !hasExactKeys(header, ['alg', 'typ', 'kid']) ||
    header.alg !== options.signatureAlgorithm ||
    header.typ !== options.tokenType ||
    typeof header.kid !== 'string' ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(header.kid)
  ) {
    throw new TaskDelegationAssertionError('UNSUPPORTED_PROFILE');
  }

  let encodedKey: KeyObject | string | Buffer | undefined;
  try {
    encodedKey = options.keyProvider.getPublicKey(header.kid);
  } catch {
    // Do not expose key-provider details or credentials through verifier errors.
    throw new TaskDelegationAssertionError('KEY_RESOLUTION_FAILED');
  }
  if (!encodedKey) throw new TaskDelegationAssertionError('UNKNOWN_KEY_ID');
  if (!(encodedKey instanceof KeyObject) && containsPrivatePem(encodedKey)) {
    throw new TaskDelegationAssertionError('UNSUPPORTED_PROFILE');
  }

  let publicKey: KeyObject;
  try {
    if (encodedKey instanceof KeyObject) {
      if (encodedKey.type !== 'public') {
        throw new TaskDelegationAssertionError('UNSUPPORTED_PROFILE');
      }
      publicKey = encodedKey;
    } else {
      publicKey = createPublicKey(encodedKey);
    }
  } catch {
    throw new TaskDelegationAssertionError('UNSUPPORTED_PROFILE');
  }
  const keyMatchesAlgorithm =
    options.signatureAlgorithm === 'EdDSA'
      ? publicKey.asymmetricKeyType === 'ed25519'
      : publicKey.asymmetricKeyType === 'rsa' &&
        (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048;
  if (!keyMatchesAlgorithm) {
    throw new TaskDelegationAssertionError('UNSUPPORTED_PROFILE');
  }

  let signature: Buffer;
  try {
    signature = decodeBase64Url(segments[2]);
  } catch {
    throw new TaskDelegationAssertionError('MALFORMED');
  }
  const signingInput = Buffer.from(`${segments[0]}.${segments[1]}`, 'ascii');
  let validSignature = false;
  try {
    validSignature = verifySignature(
      options.signatureAlgorithm === 'EdDSA' ? null : 'RSA-SHA256',
      signingInput,
      publicKey,
      signature,
    );
  } catch {
    validSignature = false;
  }
  if (!validSignature) {
    throw new TaskDelegationAssertionError('INVALID_SIGNATURE');
  }

  const claims = decodeJson(segments[1]);
  const baseClaimKeys = [
    'iss',
    'aud',
    'sub',
    'client_id',
    'act',
    'project_id',
    'htm',
    'htu',
    'jti',
    'rid',
    'iat',
    'nbf',
    'exp',
  ] as const;
  const hasBodyFingerprint =
    isRecord(claims) &&
    Object.prototype.hasOwnProperty.call(claims, 'body_sha256');
  if (
    !isRecord(claims) ||
    !hasExactKeys(
      claims,
      hasBodyFingerprint ? [...baseClaimKeys, 'body_sha256'] : baseClaimKeys,
    ) ||
    (hasBodyFingerprint && !isSha256Base64Url(claims.body_sha256))
  ) {
    throw new TaskDelegationAssertionError('INVALID_CLAIMS');
  }
  if (claims.iss !== options.issuer) {
    throw new TaskDelegationAssertionError('WRONG_ISSUER');
  }
  if (claims.aud !== options.audience) {
    throw new TaskDelegationAssertionError('WRONG_AUDIENCE');
  }
  if (claims.client_id !== options.expectedClientId) {
    throw new TaskDelegationAssertionError('INVALID_CLAIMS');
  }

  const actor = claims.act;
  if (
    !isRecord(actor) ||
    !hasExactKeys(actor, ['sub']) ||
    actor.sub !== options.gatewayServiceId ||
    typeof claims.sub !== 'string' ||
    !OBJECT_ID_PATTERN.test(claims.sub) ||
    typeof claims.client_id !== 'string' ||
    typeof claims.project_id !== 'string' ||
    !OBJECT_ID_PATTERN.test(claims.project_id) ||
    typeof claims.htm !== 'string' ||
    !/^[A-Z]+$/.test(claims.htm) ||
    typeof claims.htu !== 'string' ||
    !claims.htu.startsWith('/') ||
    claims.htu.includes('#') ||
    typeof claims.jti !== 'string' ||
    !UUID_V4_PATTERN.test(claims.jti) ||
    typeof claims.rid !== 'string' ||
    !UUID_V4_PATTERN.test(claims.rid) ||
    !isIntegerClaim(claims.iat) ||
    !isIntegerClaim(claims.nbf) ||
    !isIntegerClaim(claims.exp) ||
    claims.nbf < claims.iat ||
    claims.exp <= claims.iat
  ) {
    throw new TaskDelegationAssertionError('INVALID_CLAIMS');
  }

  const nowSeconds = request.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS
  ) {
    throw new TaskDelegationAssertionError('NOT_YET_VALID');
  }
  if (claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS) {
    throw new TaskDelegationAssertionError('EXPIRED');
  }
  if (claims.exp - claims.iat > MAX_ASSERTION_LIFETIME_SECONDS) {
    throw new TaskDelegationAssertionError('LIFETIME_EXCEEDED');
  }

  if (
    claims.htm !== request.method.toUpperCase() ||
    claims.htu !== request.target ||
    claims.project_id !== request.projectId ||
    (request.bodySha256 !== undefined) !== hasBodyFingerprint ||
    (request.bodySha256 !== undefined &&
      claims.body_sha256 !== request.bodySha256)
  ) {
    throw new TaskDelegationAssertionError('REQUEST_MISMATCH');
  }

  return {
    context: {
      actorUserId: claims.sub,
      gatewayServiceId: options.gatewayServiceId,
      projectId: claims.project_id,
      requestId: claims.rid,
    },
    replay: {
      issuer: claims.iss,
      tokenId: claims.jti,
      // Retain the marker through the prototype verifier's accepted clock-skew
      // interval. MongoDB TTL cleanup may happen later, which only denies reuse.
      retainUntil: new Date((claims.exp + CLOCK_SKEW_SECONDS) * 1000),
    },
  };
}
