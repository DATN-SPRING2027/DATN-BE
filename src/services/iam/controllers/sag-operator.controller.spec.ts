import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync } from 'node:crypto';
import type { Response } from 'express';
import { sign, verify, type JwtPayload } from 'jsonwebtoken';
import { SagOperatorController } from './sag-operator.controller';
import type { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';

describe('Continuum operator delegation', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = pair.privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const config = new ConfigService({
    SAG_OPERATOR_PRIVATE_KEY: pem,
    SAG_OPERATOR_INSTANCE: 'sag1',
    SAG_OPERATOR_ENVIRONMENT: 'stage',
    SAG_OPERATOR_ISSUER: 'fixture-iam',
    SAG_OPERATOR_API_URL: 'https://sag.invalid',
    SAG_OPERATOR_BFF_CREDENTIAL: 'b'.repeat(40),
    SAG_OPERATOR_DECISION_CREDENTIAL: 'c'.repeat(40),
    SAG_MFA_PUBLIC_KEY: pair.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
    SAG_MFA_ISSUER: 'fixture-mfa',
    SAG_MFA_MAX_AGE_SECONDS: '120',
  });
  const session = {
    sub: 'a'.repeat(24),
    sid: 'session1',
    exp: Math.floor(Date.now() / 1000) + 1000,
    accessHash: 'h',
    userFence: 0,
  };
  const auth = {
    authorizeSagOperation: jest.fn().mockResolvedValue(session),
    recheckSagOperation: jest.fn(),
  };
  const controller = new SagOperatorController(
    config,
    auth as unknown as AuthenticationApplicationService,
  );
  const response = {
    setHeader: jest.fn(),
    status: jest.fn(),
  } as unknown as Response;
  afterEach(() => jest.restoreAllMocks());
  it('requires signed MFA and a fresh decision bound to the operation and caller', async () => {
    let assertion = '';
    const upstream = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((_url, init) => {
        const headers = new Headers(init?.headers);
        assertion = headers.get('x-sag-operator-assertion') ?? '';
        return Promise.resolve(globalThis.Response.json({ ok: true }));
      });
    await expect(
      controller.execute('dsh-export', 'Bearer fixture', {}, response),
    ).rejects.toThrow();
    expect(upstream).not.toHaveBeenCalled();
    await expect(
      controller.execute(
        'model-update',
        undefined,
        {},
        response,
        'continuum_access=fixture; __Host-csrf=token',
        'wrong',
      ),
    ).rejects.toThrow();
    await controller.execute(
      'model-update',
      undefined,
      {},
      response,
      'continuum_access=fixture; __Host-csrf=token',
      'token',
    );
    const proof = sign(
      {
        sub: session.sub,
        sid: session.sid,
        amr: ['mfa'],
        auth_time: Math.floor(Date.now() / 1000),
      },
      pair.privateKey,
      {
        algorithm: 'RS256',
        issuer: 'fixture-mfa',
        audience: 'continuum-sag-step-up',
        expiresIn: 120,
      },
    );
    await controller.execute(
      'dsh-export',
      'Bearer fixture',
      { stepUp: proof },
      response,
    );
    const claims = verify(assertion, pair.publicKey, {
      algorithms: ['RS256'],
      audience: 'sag-platform-operator',
      issuer: 'fixture-iam',
    }) as JwtPayload;
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(300);
    expect(claims.permission).toBe('sag.dsh.credential.export');
    await expect(
      controller.decide('Bearer wrong', { assertion }, response),
    ).rejects.toThrow();
    const credential = 'Bearer ' + 'c'.repeat(40);
    await expect(
      controller.decide(credential, { assertion }, response),
    ).resolves.toMatchObject({ action: 'dsh-export', allowed: true });
    auth.recheckSagOperation.mockRejectedValueOnce(
      new Error('IAM unavailable'),
    );
    await expect(
      controller.decide(credential, { assertion }, response),
    ).rejects.toThrow();
  });
});
