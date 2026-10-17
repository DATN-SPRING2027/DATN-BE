import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
  type KeyObject,
} from 'node:crypto';
import {
  TaskDelegationAssertionError,
  TaskDelegationAssertionPrototypeVerifier,
} from './task-delegation-assertion.prototype';
import { ConsumingTaskDelegationAssertionPrototypeVerifier } from './task-delegation-replay-consumer.prototype';
import { TaskInboundContextVerificationError } from '../task-inbound-context';

const now = 1_800_000_000;
const keyId = 'iam-task-key-1';
const issuer = 'urn:datn:iam';
const audience = 'urn:datn:task';
const gatewayServiceId = 'svc:be-gateway';
const gatewayClientId = 'oauth-client:be-gateway';
const actorId = '0123456789abcdef01234567';
const projectId = 'abcdef0123456789abcdef01';
const signingKeys = generateKeyPairSync('ed25519');
const privateKey = signingKeys.privateKey;
const publicKey = signingKeys.publicKey;

const validClaims = {
  iss: issuer,
  aud: audience,
  sub: actorId,
  client_id: gatewayClientId,
  act: { sub: gatewayServiceId },
  project_id: projectId,
  htm: 'GET',
  htu: `/api/v1/projects/${projectId}/tasks?limit=20`,
  jti: 'f4a2283e-e935-4be0-91a3-bd4143d65c77',
  rid: '02cba539-61c9-4f05-9c4d-4b8efb47bff4',
  iat: now,
  nbf: now,
  exp: now + 60,
};

const request = {
  method: 'GET',
  target: `/api/v1/projects/${projectId}/tasks?limit=20`,
  projectId,
  nowSeconds: now,
};

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signAssertion(
  claims: Record<string, unknown> = validClaims,
  kid = keyId,
  signer: KeyObject = privateKey,
  headerOverrides: Record<string, unknown> = {},
  algorithm: 'RS256' | 'EdDSA' = 'EdDSA',
  tokenType = 'task-delegation+jwt',
): string {
  const header = base64UrlJson({
    alg: algorithm,
    typ: tokenType,
    kid,
    ...headerOverrides,
  });
  const payload = base64UrlJson(claims);
  const signingInput = `${header}.${payload}`;
  const signature = signBytes(
    algorithm === 'EdDSA' ? null : 'RSA-SHA256',
    Buffer.from(signingInput, 'ascii'),
    signer,
  );
  return `${signingInput}.${signature.toString('base64url')}`;
}

function verify(
  token: unknown,
  options: {
    request?: typeof request & { bodySha256?: string };
    publicKeys?: ReadonlyMap<string, KeyObject | string | Buffer>;
    signatureAlgorithm?: 'RS256' | 'EdDSA';
    tokenType?: string;
  } = {},
) {
  const publicKeys = options.publicKeys ?? new Map([[keyId, publicKey]]);
  return new TaskDelegationAssertionPrototypeVerifier({
    issuer,
    audience,
    gatewayServiceId,
    expectedClientId: gatewayClientId,
    signatureAlgorithm: options.signatureAlgorithm ?? 'EdDSA',
    tokenType: options.tokenType ?? 'task-delegation+jwt',
    keyProvider: {
      getPublicKey: (requestedKeyId) => publicKeys.get(requestedKeyId),
    },
  }).verify(token, options.request ?? request);
}

describe('Task delegation assertion prototype', () => {
  it('returns only the request-bound human and service identities', () => {
    expect(verify(signAssertion())).toEqual({
      actorUserId: actorId,
      gatewayServiceId,
      projectId,
      requestId: validClaims.rid,
    });
  });

  it('rejects altered signatures and unknown key ids', () => {
    const token = signAssertion();
    const segments = token.split('.');
    segments[1] = base64UrlJson({
      ...validClaims,
      sub: '111111111111111111111111',
    });
    expect(() => verify(segments.join('.'))).toThrow(
      new TaskDelegationAssertionError('INVALID_SIGNATURE'),
    );
    expect(() => verify(signAssertion(validClaims, 'unknown-key'))).toThrow(
      new TaskDelegationAssertionError('UNKNOWN_KEY_ID'),
    );
  });

  it('accepts overlapping key IDs during rotation and rejects a retired key', () => {
    const previousKeyId = 'iam-task-key-previous';
    const currentKeyId = 'iam-task-key-current';
    const previousKeys = generateKeyPairSync('ed25519');
    const currentKeys = generateKeyPairSync('ed25519');
    const previousToken = signAssertion(
      validClaims,
      previousKeyId,
      previousKeys.privateKey,
    );
    const currentToken = signAssertion(
      validClaims,
      currentKeyId,
      currentKeys.privateKey,
    );
    const overlappingPublicKeys = new Map([
      [previousKeyId, previousKeys.publicKey],
      [currentKeyId, currentKeys.publicKey],
    ]);

    expect(
      verify(previousToken, { publicKeys: overlappingPublicKeys }),
    ).toEqual(verify(currentToken, { publicKeys: overlappingPublicKeys }));

    overlappingPublicKeys.delete(previousKeyId);

    expect(() =>
      verify(previousToken, { publicKeys: overlappingPublicKeys }),
    ).toThrow(new TaskDelegationAssertionError('UNKNOWN_KEY_ID'));
    expect(verify(currentToken, { publicKeys: overlappingPublicKeys })).toEqual(
      {
        actorUserId: actorId,
        gatewayServiceId,
        projectId,
        requestId: validClaims.rid,
      },
    );
  });

  it('verifies RS256 only when explicitly configured with a matching strong RSA key', () => {
    const rsaKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = signAssertion(
      validClaims,
      keyId,
      rsaKeys.privateKey,
      {},
      'RS256',
    );

    expect(
      verify(token, {
        signatureAlgorithm: 'RS256',
        publicKeys: new Map([[keyId, rsaKeys.publicKey]]),
      }),
    ).toEqual({
      actorUserId: actorId,
      gatewayServiceId,
      projectId,
      requestId: validClaims.rid,
    });
    expect(() =>
      verify(token, {
        signatureAlgorithm: 'EdDSA',
        publicKeys: new Map([[keyId, rsaKeys.publicKey]]),
      }),
    ).toThrow(new TaskDelegationAssertionError('UNSUPPORTED_PROFILE'));
  });

  it('verifies the RFC 9068 profile with RS256, at+jwt and a bound client_id', () => {
    const rsaKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = signAssertion(
      validClaims,
      keyId,
      rsaKeys.privateKey,
      {},
      'RS256',
      'at+jwt',
    );

    expect(
      verify(token, {
        signatureAlgorithm: 'RS256',
        tokenType: 'at+jwt',
        publicKeys: new Map([[keyId, rsaKeys.publicKey]]),
      }),
    ).toEqual({
      actorUserId: actorId,
      gatewayServiceId,
      projectId,
      requestId: validClaims.rid,
    });
  });

  it('rejects an RFC 9068 access token without client_id', () => {
    const claimsWithoutClientId: Record<string, unknown> = { ...validClaims };
    delete claimsWithoutClientId.client_id;
    expect(() => verify(signAssertion(claimsWithoutClientId))).toThrow(
      new TaskDelegationAssertionError('INVALID_CLAIMS'),
    );
  });

  it('rejects RS256 verification keys below 2048 bits', () => {
    const weakRsaKeys = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const token = signAssertion(
      validClaims,
      keyId,
      weakRsaKeys.privateKey,
      {},
      'RS256',
    );

    expect(() =>
      verify(token, {
        signatureAlgorithm: 'RS256',
        publicKeys: new Map([[keyId, weakRsaKeys.publicKey]]),
      }),
    ).toThrow(new TaskDelegationAssertionError('UNSUPPORTED_PROFILE'));
  });

  it('requires the configured token type to match exactly', () => {
    expect(() => verify(signAssertion(), { tokenType: 'at+jwt' })).toThrow(
      new TaskDelegationAssertionError('UNSUPPORTED_PROFILE'),
    );
  });

  it.each([
    ['algorithm', { alg: 'none' }],
    ['token type', { typ: 'JWT' }],
  ])(
    'rejects an unsupported %s without checking the signature',
    (_name, header) => {
      expect(() =>
        verify(signAssertion(validClaims, keyId, privateKey, header)),
      ).toThrow(new TaskDelegationAssertionError('UNSUPPORTED_PROFILE'));
    },
  );

  it('rejects private signing material in the verifier key set', () => {
    expect(() =>
      verify(signAssertion(), { publicKeys: new Map([[keyId, privateKey]]) }),
    ).toThrow(new TaskDelegationAssertionError('UNSUPPORTED_PROFILE'));
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    expect(() =>
      verify(signAssertion(), { publicKeys: new Map([[keyId, privatePem]]) }),
    ).toThrow(new TaskDelegationAssertionError('UNSUPPORTED_PROFILE'));
  });

  it.each([
    ['issuer', { iss: 'urn:untrusted' }, 'WRONG_ISSUER'],
    ['audience', { aud: 'urn:datn:other' }, 'WRONG_AUDIENCE'],
    [
      'OAuth client identity',
      { client_id: 'oauth-client:untrusted' },
      'INVALID_CLAIMS',
    ],
    ['service actor', { act: { sub: 'svc:untrusted' } }, 'INVALID_CLAIMS'],
    ['Project claim', { project_id: actorId }, 'REQUEST_MISMATCH'],
    [
      'expired token',
      { iat: now - 120, nbf: now - 120, exp: now - 60 },
      'EXPIRED',
    ],
    [
      'future token',
      { iat: now + 20, nbf: now + 20, exp: now + 60 },
      'NOT_YET_VALID',
    ],
    ['long lifetime', { exp: now + 61 }, 'LIFETIME_EXCEEDED'],
    ['role-bearing token', { role: 'ADMIN' }, 'INVALID_CLAIMS'],
  ] as const)('rejects invalid %s claims', (_name, overrides, reason) => {
    expect(() =>
      verify(signAssertion({ ...validClaims, ...overrides })),
    ).toThrow(new TaskDelegationAssertionError(reason));
  });

  it.each([
    ['method', { method: 'POST' }],
    ['target', { target: `/api/v1/projects/${projectId}/tasks/other` }],
    ['Project', { projectId: actorId }],
  ] as const)('rejects a mismatched request %s', (_name, mismatch) => {
    expect(() =>
      verify(signAssertion(), { request: { ...request, ...mismatch } }),
    ).toThrow(new TaskDelegationAssertionError('REQUEST_MISMATCH'));
  });

  it('binds a request body fingerprint when the request has a body', () => {
    const bodySha256 = createHash('sha256')
      .update('{"title":"D-04"}')
      .digest('base64url');
    const bodyClaims = {
      ...validClaims,
      htm: 'POST',
      body_sha256: bodySha256,
    };
    const bodyRequest = { ...request, method: 'POST', bodySha256 };

    expect(() =>
      verify(signAssertion(bodyClaims), { request: bodyRequest }),
    ).not.toThrow();
    expect(() =>
      verify(signAssertion(bodyClaims), {
        request: { ...bodyRequest, bodySha256: `${bodySha256.slice(0, -1)}A` },
      }),
    ).toThrow(new TaskDelegationAssertionError('REQUEST_MISMATCH'));
    expect(() =>
      verify(signAssertion(validClaims), { request: bodyRequest }),
    ).toThrow(new TaskDelegationAssertionError('REQUEST_MISMATCH'));
  });

  it('rejects malformed body fingerprints in claims and request bindings', () => {
    expect(() =>
      verify(
        signAssertion({ ...validClaims, body_sha256: 'not-a-sha256-digest' }),
      ),
    ).toThrow(new TaskDelegationAssertionError('INVALID_CLAIMS'));
    expect(() =>
      verify(signAssertion(), {
        request: { ...request, bodySha256: 'not-a-sha256-digest' },
      }),
    ).toThrow(new TaskDelegationAssertionError('MALFORMED'));
  });

  it('rejects malformed input and does not make replay claims', () => {
    expect(() => verify('not-a-jwt')).toThrow(
      new TaskDelegationAssertionError('MALFORMED'),
    );
    // This prototype is stateless: a valid assertion is accepted repeatedly.
    // Production must add an approved atomic jti replay check before any route.
    expect(verify(signAssertion()).requestId).toBe(validClaims.rid);
    expect(verify(signAssertion()).requestId).toBe(validClaims.rid);
  });

  it('releases context only after an explicitly composed replay consumer accepts it', async () => {
    const prototype = new TaskDelegationAssertionPrototypeVerifier({
      issuer,
      audience,
      gatewayServiceId,
      expectedClientId: gatewayClientId,
      signatureAlgorithm: 'EdDSA',
      tokenType: 'task-delegation+jwt',
      keyProvider: {
        getPublicKey: (requestedKeyId) =>
          new Map([[keyId, publicKey]]).get(requestedKeyId),
      },
    });
    const replayStore = { consume: jest.fn().mockResolvedValue(true) };
    const consuming = new ConsumingTaskDelegationAssertionPrototypeVerifier(
      prototype,
      replayStore,
    );

    await expect(consuming.verify(signAssertion(), request)).resolves.toEqual({
      actorUserId: actorId,
      gatewayServiceId,
      projectId,
      requestId: validClaims.rid,
    });
    expect(replayStore.consume).toHaveBeenCalledWith({
      issuer,
      tokenId: validClaims.jti,
      retainUntil: new Date((validClaims.exp + 5) * 1000),
    });
  });

  it.each([
    ['already consumed', () => Promise.resolve(false)],
    [
      'store unavailable',
      () => Promise.reject(new Error('private-store-detail')),
    ],
  ])('fails closed when replay is %s', async (_name, consume) => {
    const prototype = new TaskDelegationAssertionPrototypeVerifier({
      issuer,
      audience,
      gatewayServiceId,
      expectedClientId: gatewayClientId,
      signatureAlgorithm: 'EdDSA',
      tokenType: 'task-delegation+jwt',
      keyProvider: {
        getPublicKey: (requestedKeyId) =>
          new Map([[keyId, publicKey]]).get(requestedKeyId),
      },
    });
    const consuming = new ConsumingTaskDelegationAssertionPrototypeVerifier(
      prototype,
      { consume },
    );

    await expect(consuming.verify(signAssertion(), request)).rejects.toEqual(
      new TaskInboundContextVerificationError('VERIFICATION_FAILED'),
    );
  });

  it('fails closed and sanitizes key-resolution dependency errors', () => {
    const sensitiveDetail = 'key-provider-secret-canary';
    const publicKeys = {
      get: () => {
        throw new Error(`key provider unavailable: ${sensitiveDetail}`);
      },
    } as unknown as ReadonlyMap<string, KeyObject | string | Buffer>;

    let caught: unknown;
    try {
      verify(signAssertion(), { publicKeys });
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(
      new TaskDelegationAssertionError('KEY_RESOLUTION_FAILED'),
    );
    expect(JSON.stringify(caught)).not.toContain(sensitiveDetail);
  });

  it('does not include raw token data in verifier errors', () => {
    const token = signAssertion({ ...validClaims, iss: 'credential-canary' });
    let caught: unknown;
    try {
      verify(token);
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new TaskDelegationAssertionError('WRONG_ISSUER'));
    expect(JSON.stringify(caught)).not.toContain(token);
    expect(JSON.stringify(caught)).not.toContain('credential-canary');
  });
});
