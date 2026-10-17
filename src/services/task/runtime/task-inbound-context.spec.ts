import { Test } from '@nestjs/testing';
import {
  TASK_INBOUND_CONTEXT_VERIFIER,
  TaskInboundContextTrustBoundary,
  TaskInboundContextVerificationError,
  TaskInboundContextVerifier,
  UnconfiguredTaskInboundContextVerifier,
} from './task-inbound-context';
import { TaskDelegationAssertionPrototypeVerifier } from './prototypes/task-delegation-assertion.prototype';

const context = {
  actorUserId: '0123456789abcdef01234567',
  gatewayServiceId: 'svc:be-gateway',
  projectId: 'abcdef0123456789abcdef01',
  requestId: '02cba539-61c9-4f05-9c4d-4b8efb47bff4',
};

async function createBoundary(verifier: TaskInboundContextVerifier) {
  const module = await Test.createTestingModule({
    providers: [
      TaskInboundContextTrustBoundary,
      { provide: TASK_INBOUND_CONTEXT_VERIFIER, useValue: verifier },
    ],
  }).compile();

  return {
    boundary: module.get(TaskInboundContextTrustBoundary),
    close: () => module.close(),
  };
}

describe('TaskInboundContextTrustBoundary', () => {
  it.each([undefined, null])(
    'rejects absent context (%s) before invoking the verifier',
    async (candidate) => {
      const verify = jest.fn();
      const { boundary, close } = await createBoundary({ verify });

      await expect(boundary.verify(candidate, {})).resolves.toEqual({
        kind: 'rejected',
        reason: 'MISSING_CONTEXT',
      });
      expect(verify).not.toHaveBeenCalled();
      await close();
    },
  );

  it('preserves stable verifier rejection reasons without exposing details', async () => {
    const verifier = {
      verify: () => {
        throw new TaskInboundContextVerificationError('EXPIRED');
      },
    };
    const { boundary, close } = await createBoundary(verifier);

    await expect(boundary.verify('opaque candidate', {})).resolves.toEqual({
      kind: 'rejected',
      reason: 'EXPIRED',
    });
    await close();
  });

  it('sanitizes unexpected verifier failures', async () => {
    const sensitiveDetail = 'provider-credential-canary';
    const verifier = {
      verify: () => {
        throw new Error(`provider failure: ${sensitiveDetail}`);
      },
    };
    const { boundary, close } = await createBoundary(verifier);
    const result = await boundary.verify('opaque candidate', {});

    expect(result).toEqual({ kind: 'rejected', reason: 'VERIFICATION_FAILED' });
    expect(JSON.stringify(result)).not.toContain(sensitiveDetail);
    await close();
  });

  it('maps an invalid typed failure reason to a generic rejection', async () => {
    const error = new TaskInboundContextVerificationError('EXPIRED');
    (error as unknown as { reason: string }).reason =
      'provider-credential-canary';
    const { boundary, close } = await createBoundary({
      verify: () => {
        throw error;
      },
    });
    const result = await boundary.verify('opaque candidate', {});

    expect(result).toEqual({ kind: 'rejected', reason: 'VERIFICATION_FAILED' });
    expect(JSON.stringify(result)).not.toContain('provider-credential-canary');
    await close();
  });

  it('rejects malformed context returned by a verifier', async () => {
    const verifier = {
      verify: () => ({ ...context, debug: 'must not escape' }),
    };
    const { boundary, close } = await createBoundary(verifier);

    await expect(boundary.verify('opaque candidate', {})).resolves.toEqual({
      kind: 'rejected',
      reason: 'MALFORMED_CONTEXT',
    });
    await close();
  });

  it('rejects accessors and does not execute them while validating output', async () => {
    const getter = jest.fn(() => context.actorUserId);
    const malformed = { ...context };
    Object.defineProperty(malformed, 'actorUserId', {
      enumerable: true,
      get: getter,
    });
    const { boundary, close } = await createBoundary({
      verify: () => malformed,
    });

    await expect(boundary.verify('opaque candidate', {})).resolves.toEqual({
      kind: 'rejected',
      reason: 'MALFORMED_CONTEXT',
    });
    expect(getter).not.toHaveBeenCalled();
    await close();
  });

  it('rejects symbol and non-enumerable fields in verifier output', async () => {
    const malformed = { ...context, [Symbol('provider-detail')]: 'secret' };
    Object.defineProperty(malformed, 'hidden', {
      value: 'provider-detail',
      enumerable: false,
    });
    const { boundary, close } = await createBoundary({
      verify: () => malformed,
    });

    await expect(boundary.verify('opaque candidate', {})).resolves.toEqual({
      kind: 'rejected',
      reason: 'MALFORMED_CONTEXT',
    });
    await close();
  });

  it('returns context only from the injected verifier', async () => {
    const verifier = { verify: jest.fn().mockResolvedValue(context) };
    const { boundary, close } = await createBoundary(verifier);

    await expect(
      boundary.verify('verifier-owned candidate', { method: 'GET' }),
    ).resolves.toEqual({ kind: 'verified', context });
    expect(verifier.verify).toHaveBeenCalledWith('verifier-owned candidate', {
      method: 'GET',
    });
    await close();
  });

  it('does not accept actor or Project headers when no verifier is configured', async () => {
    const { boundary, close } = await createBoundary(
      new UnconfiguredTaskInboundContextVerifier(),
    );
    const callerHeaders = {
      'x-actor-user-id': context.actorUserId,
      'x-project-id': context.projectId,
    };

    await expect(boundary.verify(callerHeaders, {})).resolves.toEqual({
      kind: 'rejected',
      reason: 'VERIFIER_UNAVAILABLE',
    });
    await close();
  });

  it('does not treat caller headers as a delegation assertion', async () => {
    const { boundary, close } = await createBoundary(
      new TaskDelegationAssertionPrototypeVerifier({
        issuer: 'urn:datn:iam',
        audience: 'urn:datn:task',
        gatewayServiceId: 'svc:be-gateway',
        expectedClientId: 'oauth-client:be-gateway',
        signatureAlgorithm: 'EdDSA',
        tokenType: 'task-delegation+jwt',
        keyProvider: { getPublicKey: () => undefined },
      }),
    );
    const callerHeaders = {
      'x-actor-user-id': context.actorUserId,
      'x-project-id': context.projectId,
    };

    await expect(
      boundary.verify(callerHeaders, {
        method: 'GET',
        target: '/internal/tasks',
        projectId: context.projectId,
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'MALFORMED' });
    await close();
  });
});
