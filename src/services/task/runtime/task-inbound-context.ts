import { Inject, Injectable } from '@nestjs/common';

export const TASK_INBOUND_CONTEXT_VERIFIER = Symbol(
  'TASK_INBOUND_CONTEXT_VERIFIER',
);

export const TASK_INBOUND_CONTEXT_VERIFICATION_FAILURES = [
  'MISSING_CONTEXT',
  'MALFORMED_CONTEXT',
  'VERIFIER_UNAVAILABLE',
  'VERIFICATION_FAILED',
  'MALFORMED',
  'UNSUPPORTED_PROFILE',
  'UNKNOWN_KEY_ID',
  'KEY_RESOLUTION_FAILED',
  'INVALID_SIGNATURE',
  'WRONG_ISSUER',
  'WRONG_AUDIENCE',
  'INVALID_CLAIMS',
  'NOT_YET_VALID',
  'EXPIRED',
  'LIFETIME_EXCEEDED',
  'REQUEST_MISMATCH',
] as const;

export type TaskInboundContextVerificationFailure =
  (typeof TASK_INBOUND_CONTEXT_VERIFICATION_FAILURES)[number];

const verificationFailureSet = new Set<string>(
  TASK_INBOUND_CONTEXT_VERIFICATION_FAILURES,
);

function isVerificationFailure(
  value: unknown,
): value is TaskInboundContextVerificationFailure {
  return typeof value === 'string' && verificationFailureSet.has(value);
}

/**
 * Identity/delegation claims accepted by an explicitly configured verifier.
 * `projectId` is context only; this shape carries no Project authorization or
 * operation-level permission decision.
 */
export interface TaskInboundContext {
  actorUserId: string;
  gatewayServiceId: string;
  projectId: string;
  requestId: string;
}

export type TaskInboundContextVerificationResult =
  // `verified` means the injected verifier established identity/context claims.
  // It does not mean the actor is authorized for the Project or operation.
  | { kind: 'verified'; context: TaskInboundContext }
  | {
      kind: 'rejected';
      reason: TaskInboundContextVerificationFailure;
    };

export interface TaskInboundContextVerifier {
  /**
   * Verify the opaque candidate against a server-derived request binding.
   * The boundary does not establish the provenance of that binding or authorize
   * the requested Project/operation; an HTTP adapter must not build it from
   * caller-supplied identity headers.
   */
  verify(
    this: void,
    candidate: unknown,
    requestBinding: unknown,
  ): TaskInboundContext | Promise<TaskInboundContext>;
}

export class TaskInboundContextVerificationError extends Error {
  constructor(readonly reason: TaskInboundContextVerificationFailure) {
    super(`Task inbound context verification failed: ${reason.toLowerCase()}`);
    this.name = TaskInboundContextVerificationError.name;
  }
}

function sanitizeTaskInboundContext(
  value: unknown,
): TaskInboundContext | undefined {
  const expectedKeys = [
    'actorUserId',
    'gatewayServiceId',
    'projectId',
    'requestId',
  ];
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return undefined;
    }

    const ownKeys = Reflect.ownKeys(value);
    const actualKeys = ownKeys.filter(
      (key): key is string => typeof key === 'string',
    );
    actualKeys.sort();
    if (
      actualKeys.length !== expectedKeys.length ||
      ownKeys.length !== expectedKeys.length ||
      !actualKeys.every((key, index) => key === expectedKeys[index])
    ) {
      return undefined;
    }

    const fields = new Map<string, unknown>();
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        return undefined;
      }
      fields.set(key, descriptor.value);
    }

    const actorUserId = fields.get('actorUserId');
    const gatewayServiceId = fields.get('gatewayServiceId');
    const projectId = fields.get('projectId');
    const requestId = fields.get('requestId');
    if (
      typeof actorUserId !== 'string' ||
      actorUserId.length === 0 ||
      typeof gatewayServiceId !== 'string' ||
      gatewayServiceId.length === 0 ||
      typeof projectId !== 'string' ||
      projectId.length === 0 ||
      typeof requestId !== 'string' ||
      requestId.length === 0
    ) {
      return undefined;
    }

    return { actorUserId, gatewayServiceId, projectId, requestId };
  } catch {
    return undefined;
  }
}

@Injectable()
export class TaskInboundContextTrustBoundary {
  constructor(
    @Inject(TASK_INBOUND_CONTEXT_VERIFIER)
    private readonly verifier: TaskInboundContextVerifier,
  ) {}

  async verify(
    candidate: unknown,
    requestBinding: unknown,
  ): Promise<TaskInboundContextVerificationResult> {
    if (candidate === undefined || candidate === null) {
      return { kind: 'rejected', reason: 'MISSING_CONTEXT' };
    }

    let context: TaskInboundContext;
    try {
      context = await this.verifier.verify(candidate, requestBinding);
    } catch (error) {
      try {
        if (
          error instanceof TaskInboundContextVerificationError &&
          isVerificationFailure(error.reason)
        ) {
          return { kind: 'rejected', reason: error.reason };
        }
      } catch {
        // Malformed error objects and provider internals are never exposed.
      }
      return { kind: 'rejected', reason: 'VERIFICATION_FAILED' };
    }

    const safeContext = sanitizeTaskInboundContext(context);
    if (!safeContext) {
      return { kind: 'rejected', reason: 'MALFORMED_CONTEXT' };
    }

    return { kind: 'verified', context: safeContext };
  }
}

@Injectable()
export class UnconfiguredTaskInboundContextVerifier implements TaskInboundContextVerifier {
  verify(): never {
    throw new TaskInboundContextVerificationError('VERIFIER_UNAVAILABLE');
  }
}
