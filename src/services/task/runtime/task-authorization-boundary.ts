import { Inject, Injectable } from '@nestjs/common';
import {
  TASK_INBOUND_CONTEXT_VERIFIER_FAULTS,
  TaskInboundContextTrustBoundary,
} from './task-inbound-context';

const verifierFaults: ReadonlySet<string> = new Set(
  TASK_INBOUND_CONTEXT_VERIFIER_FAULTS,
);

export const TASK_PROJECT_SCOPE_EVIDENCE_PROVIDER = Symbol(
  'TASK_PROJECT_SCOPE_EVIDENCE_PROVIDER',
);
export const TASK_OPERATION_PERMISSION_POLICY = Symbol(
  'TASK_OPERATION_PERMISSION_POLICY',
);
export const TASK_RESOURCE_PROJECT_RESOLVER = Symbol(
  'TASK_RESOURCE_PROJECT_RESOLVER',
);

export const TASK_OPERATIONS = ['create', 'list', 'detail', 'history'] as const;
export type TaskOperation = (typeof TASK_OPERATIONS)[number];

/**
 * DR-4: both memberships must be ACTIVE. A provider reports anything else
 * (non-member, inactive or revoked membership) as `denied`, never as resolved
 * evidence.
 */
export interface TaskProjectScopeEvidence {
  actorUserId: string;
  projectId: string;
  organizationId: string;
  organizationMembershipStatus: 'ACTIVE';
  projectMembershipStatus: 'ACTIVE';
}

export type TaskProjectScopeEvidenceResult =
  | { kind: 'resolved'; evidence: TaskProjectScopeEvidence }
  | { kind: 'denied' }
  | { kind: 'unavailable' };

/**
 * Resolves the Project owner Organization and the actor's current ACTIVE
 * Organization Membership and ACTIVE ProjectMembership from server-owned data.
 * This evidence is necessary for scoped access but never grants a Task
 * operation by itself.
 */
export interface TaskProjectScopeEvidenceProvider {
  resolve(
    this: void,
    input: { actorUserId: string; projectId: string },
  ): TaskProjectScopeEvidenceResult | Promise<TaskProjectScopeEvidenceResult>;
}

export interface TaskOperationPermissionFacts extends TaskProjectScopeEvidence {
  operation: TaskOperation;
  gatewayServiceId: string;
  resolvedResourceProjectId?: string;
}

export type TaskPermissionDecision = 'ALLOW' | 'DENY';

/** Only an approved policy implementation may return ALLOW. */
export interface TaskOperationPermissionPolicy {
  decide(
    this: void,
    facts: TaskOperationPermissionFacts,
  ): TaskPermissionDecision | Promise<TaskPermissionDecision>;
}

export interface TaskResourceProjectResolver {
  /** Resolve persisted ownership, scoped by the requested Project. */
  resolveProjectId(
    this: void,
    input: {
      resourceId: string;
      requestedProjectId: string;
    },
  ): string | undefined | Promise<string | undefined>;
}

export interface TaskAuthorizationRequest {
  operation: TaskOperation;
  /** Opaque proof supplied by a future trusted transport adapter. */
  contextCandidate: unknown;
  /** Must be derived from server-observed request/transport facts. */
  requestBinding: unknown;
  /** Project selector from the private adapter/path, bound to the proof. */
  requestedProjectId: string;
  /** For detail, the resource selector from the private adapter/path. */
  resourceId?: string;
}

export type TaskAuthorizationDenialReason =
  | 'INVALID_REQUEST'
  | 'UNVERIFIED_CONTEXT'
  | 'CONTEXT_VERIFIER_UNAVAILABLE'
  | 'PROJECT_MISMATCH'
  | 'RESOURCE_SCOPE_UNRESOLVED'
  | 'RESOURCE_SCOPE_UNAVAILABLE'
  | 'RESOURCE_SCOPE_MISMATCH'
  | 'PROJECT_SCOPE_DENIED'
  | 'PROJECT_SCOPE_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'PERMISSION_POLICY_UNAVAILABLE';

export type TaskAuthorizationResult =
  | {
      kind: 'authorized';
      operation: TaskOperation;
      actorUserId: string;
      gatewayServiceId: string;
      projectId: string;
      organizationId: string;
      requestId: string;
    }
  | { kind: 'denied'; reason: TaskAuthorizationDenialReason };

const operationSet = new Set<string>(TASK_OPERATIONS);
const requestKeys = new Set([
  'operation',
  'contextCandidate',
  'requestBinding',
  'requestedProjectId',
  'resourceId',
]);

function readPlainDataObject(
  value: unknown,
): Record<string, unknown> | undefined {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return undefined;
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        return undefined;
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function parseRequest(value: unknown): TaskAuthorizationRequest | undefined {
  try {
    const request = readPlainDataObject(value);
    if (!request) return undefined;
    const keys = Object.keys(request);
    if (
      keys.some((key) => !requestKeys.has(key)) ||
      !operationSet.has(request.operation as string) ||
      !Object.prototype.hasOwnProperty.call(request, 'contextCandidate') ||
      !Object.prototype.hasOwnProperty.call(request, 'requestBinding') ||
      typeof request.requestedProjectId !== 'string' ||
      request.requestedProjectId.length === 0 ||
      (request.resourceId !== undefined &&
        (typeof request.resourceId !== 'string' ||
          request.resourceId.length === 0)) ||
      ((request.operation === 'detail' || request.operation === 'history') &&
        request.resourceId === undefined) ||
      (request.operation !== 'detail' &&
        request.operation !== 'history' &&
        request.resourceId !== undefined)
    ) {
      return undefined;
    }

    return {
      operation: request.operation as TaskOperation,
      contextCandidate: request.contextCandidate,
      requestBinding: request.requestBinding,
      requestedProjectId: request.requestedProjectId,
      ...(request.resourceId === undefined
        ? {}
        : { resourceId: request.resourceId }),
    };
  } catch {
    return undefined;
  }
}

function parseScopeEvidence(
  value: unknown,
): TaskProjectScopeEvidence | undefined {
  const evidence = readPlainDataObject(value);
  if (!evidence) return undefined;
  const keys = Object.keys(evidence).sort();
  if (
    keys.length !== 5 ||
    keys[0] !== 'actorUserId' ||
    keys[1] !== 'organizationId' ||
    keys[2] !== 'organizationMembershipStatus' ||
    keys[3] !== 'projectId' ||
    keys[4] !== 'projectMembershipStatus' ||
    typeof evidence.actorUserId !== 'string' ||
    evidence.actorUserId.length === 0 ||
    typeof evidence.projectId !== 'string' ||
    evidence.projectId.length === 0 ||
    typeof evidence.organizationId !== 'string' ||
    evidence.organizationId.length === 0 ||
    evidence.organizationMembershipStatus !== 'ACTIVE' ||
    evidence.projectMembershipStatus !== 'ACTIVE'
  ) {
    return undefined;
  }

  return {
    actorUserId: evidence.actorUserId,
    projectId: evidence.projectId,
    organizationId: evidence.organizationId,
    organizationMembershipStatus: 'ACTIVE',
    projectMembershipStatus: 'ACTIVE',
  };
}

function parseScopeEvidenceResult(
  value: unknown,
): TaskProjectScopeEvidenceResult | undefined {
  const result = readPlainDataObject(value);
  if (!result) return undefined;

  const keys = Object.keys(result).sort();
  if (result.kind === 'denied' || result.kind === 'unavailable') {
    return keys.length === 1 && keys[0] === 'kind'
      ? { kind: result.kind }
      : undefined;
  }
  if (
    result.kind !== 'resolved' ||
    keys.length !== 2 ||
    keys[0] !== 'evidence' ||
    keys[1] !== 'kind'
  ) {
    return undefined;
  }

  const evidence = parseScopeEvidence(result.evidence);
  return evidence ? { kind: 'resolved', evidence } : undefined;
}

@Injectable()
export class UnconfiguredTaskProjectScopeEvidenceProvider implements TaskProjectScopeEvidenceProvider {
  resolve(): TaskProjectScopeEvidenceResult {
    return { kind: 'unavailable' };
  }
}

@Injectable()
export class UnconfiguredTaskResourceProjectResolver implements TaskResourceProjectResolver {
  resolveProjectId(): undefined {
    return undefined;
  }
}

@Injectable()
export class DenyAllTaskOperationPermissionPolicy implements TaskOperationPermissionPolicy {
  decide(): TaskPermissionDecision {
    return 'DENY';
  }
}

@Injectable()
export class TaskAuthorizationBoundary {
  constructor(
    private readonly contextTrustBoundary: TaskInboundContextTrustBoundary,
    @Inject(TASK_PROJECT_SCOPE_EVIDENCE_PROVIDER)
    private readonly projectScopeEvidenceProvider: TaskProjectScopeEvidenceProvider,
    @Inject(TASK_OPERATION_PERMISSION_POLICY)
    private readonly operationPermissionPolicy: TaskOperationPermissionPolicy,
    @Inject(TASK_RESOURCE_PROJECT_RESOLVER)
    private readonly resourceProjectResolver: TaskResourceProjectResolver,
  ) {}

  async authorize(requestValue: unknown): Promise<TaskAuthorizationResult> {
    const request = parseRequest(requestValue);
    if (!request) return { kind: 'denied', reason: 'INVALID_REQUEST' };
    let verifiedContext;
    try {
      verifiedContext = await this.contextTrustBoundary.verify(
        request.contextCandidate,
        request.requestBinding,
      );
    } catch {
      // An unexpected error while verifying is a verifier fault, not a refused
      // credential (ERR-2); the cause is never exposed.
      return { kind: 'denied', reason: 'CONTEXT_VERIFIER_UNAVAILABLE' };
    }
    if (verifiedContext.kind !== 'verified') {
      return {
        kind: 'denied',
        reason: verifierFaults.has(verifiedContext.reason)
          ? 'CONTEXT_VERIFIER_UNAVAILABLE'
          : 'UNVERIFIED_CONTEXT',
      };
    }

    const context = verifiedContext.context;
    if (context.projectId !== request.requestedProjectId) {
      return { kind: 'denied', reason: 'PROJECT_MISMATCH' };
    }

    let resolvedResourceProjectId: string | undefined;
    if (request.operation === 'detail' || request.operation === 'history') {
      try {
        const resolved = await this.resourceProjectResolver.resolveProjectId({
          resourceId: request.resourceId!,
          requestedProjectId: request.requestedProjectId,
        });
        if (typeof resolved !== 'string' || resolved.length === 0) {
          return { kind: 'denied', reason: 'RESOURCE_SCOPE_UNRESOLVED' };
        }
        resolvedResourceProjectId = resolved;
      } catch {
        // A resolver failure is not proof that the resource is missing.
        return { kind: 'denied', reason: 'RESOURCE_SCOPE_UNAVAILABLE' };
      }
      if (resolvedResourceProjectId !== request.requestedProjectId) {
        return { kind: 'denied', reason: 'RESOURCE_SCOPE_MISMATCH' };
      }
    }

    let scopeResultValue: TaskProjectScopeEvidenceResult;
    try {
      scopeResultValue = await this.projectScopeEvidenceProvider.resolve({
        actorUserId: context.actorUserId,
        projectId: request.requestedProjectId,
      });
    } catch {
      return { kind: 'denied', reason: 'PROJECT_SCOPE_UNAVAILABLE' };
    }
    const scopeResult = parseScopeEvidenceResult(scopeResultValue);
    if (!scopeResult)
      return { kind: 'denied', reason: 'PROJECT_SCOPE_UNAVAILABLE' };
    if (scopeResult.kind === 'denied') {
      return { kind: 'denied', reason: 'PROJECT_SCOPE_DENIED' };
    }
    if (scopeResult.kind !== 'resolved') {
      return { kind: 'denied', reason: 'PROJECT_SCOPE_UNAVAILABLE' };
    }

    const evidence = scopeResult.evidence;
    if (
      evidence.actorUserId !== context.actorUserId ||
      evidence.projectId !== request.requestedProjectId
    ) {
      return { kind: 'denied', reason: 'PROJECT_SCOPE_DENIED' };
    }

    const facts: TaskOperationPermissionFacts = {
      ...evidence,
      operation: request.operation,
      gatewayServiceId: context.gatewayServiceId,
      ...(resolvedResourceProjectId === undefined
        ? {}
        : { resolvedResourceProjectId }),
    };

    let decision: TaskPermissionDecision;
    try {
      decision = await this.operationPermissionPolicy.decide(facts);
    } catch {
      return { kind: 'denied', reason: 'PERMISSION_POLICY_UNAVAILABLE' };
    }
    if (decision !== 'ALLOW') {
      return { kind: 'denied', reason: 'PERMISSION_DENIED' };
    }

    return {
      kind: 'authorized',
      operation: request.operation,
      actorUserId: context.actorUserId,
      gatewayServiceId: context.gatewayServiceId,
      projectId: request.requestedProjectId,
      organizationId: evidence.organizationId,
      requestId: context.requestId,
    };
  }
}
