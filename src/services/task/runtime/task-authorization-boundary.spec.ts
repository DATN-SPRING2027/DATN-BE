import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { TaskRuntimeModule } from './task-runtime.module';
import { TASK_DATABASE_NAME } from '../infrastructure/mongodb/task-contract';
import {
  TaskAuthorizationBoundary,
  TASK_OPERATION_PERMISSION_POLICY,
  TASK_PROJECT_SCOPE_EVIDENCE_PROVIDER,
  TASK_RESOURCE_PROJECT_RESOLVER,
  type TaskOperationPermissionPolicy,
  type TaskProjectScopeEvidenceProvider,
  type TaskResourceProjectResolver,
} from './task-authorization-boundary';
import {
  TASK_INBOUND_CONTEXT_VERIFICATION_FAILURES,
  TASK_INBOUND_CONTEXT_VERIFIER,
  TASK_INBOUND_CONTEXT_VERIFIER_FAULTS,
  TaskInboundContextVerificationError,
  type TaskInboundContext,
  type TaskInboundContextTrustBoundary,
  type TaskInboundContextVerifier,
} from './task-inbound-context';

const projectId = 'abcdef0123456789abcdef01';
const otherProjectId = 'fedcba9876543210fedcba98';
const actorUserId = '0123456789abcdef01234567';
const organizationId = '1234567890abcdef12345678';

const verifiedContext: TaskInboundContext = {
  actorUserId,
  gatewayServiceId: 'svc:be-gateway',
  projectId,
  requestId: '02cba539-61c9-4f05-9c4d-4b8efb47bff4',
};

const resolvedScope = {
  kind: 'resolved' as const,
  evidence: {
    actorUserId,
    projectId,
    organizationId,
    organizationMembershipStatus: 'ACTIVE' as const,
  },
};

function scopeProvider(
  overrides: Partial<TaskProjectScopeEvidenceProvider> = {},
): TaskProjectScopeEvidenceProvider {
  return {
    resolve: jest.fn().mockResolvedValue(resolvedScope),
    ...overrides,
  };
}

function permissionPolicy(
  overrides: Partial<TaskOperationPermissionPolicy> = {},
): TaskOperationPermissionPolicy {
  return {
    decide: jest.fn().mockResolvedValue('DENY'),
    ...overrides,
  };
}

async function createRuntimeBoundary(options?: {
  verifier?: TaskInboundContextVerifier;
  scopeProvider?: TaskProjectScopeEvidenceProvider;
  permissionPolicy?: TaskOperationPermissionPolicy;
  resourceResolver?: TaskResourceProjectResolver;
}) {
  const dynamicModule = TaskRuntimeModule.register({
    mongoUri: 'mongodb://127.0.0.1:27017/continuum_task',
    port: 3100,
  });
  const builder = Test.createTestingModule({
    providers: [
      {
        provide: getConnectionToken(),
        useValue: { db: { databaseName: TASK_DATABASE_NAME } },
      },
      ...(dynamicModule.providers ?? []),
    ],
  });

  if (options?.verifier) {
    builder
      .overrideProvider(TASK_INBOUND_CONTEXT_VERIFIER)
      .useValue(options.verifier);
  }
  if (options?.scopeProvider) {
    builder
      .overrideProvider(TASK_PROJECT_SCOPE_EVIDENCE_PROVIDER)
      .useValue(options.scopeProvider);
  }
  if (options?.permissionPolicy) {
    builder
      .overrideProvider(TASK_OPERATION_PERMISSION_POLICY)
      .useValue(options.permissionPolicy);
  }
  if (options?.resourceResolver) {
    builder
      .overrideProvider(TASK_RESOURCE_PROJECT_RESOLVER)
      .useValue(options.resourceResolver);
  }

  const moduleRef = await builder.compile();
  return {
    boundary: moduleRef.get(TaskAuthorizationBoundary),
    close: () => moduleRef.close(),
  };
}

function request(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    operation: 'list',
    contextCandidate: 'opaque-delegation-candidate',
    requestBinding: { method: 'GET', target: '/internal/tasks' },
    requestedProjectId: projectId,
    ...overrides,
  };
}

describe('TaskAuthorizationBoundary', () => {
  it('uses default Nest providers and rejects caller-supplied identity headers', async () => {
    const { boundary, close } = await createRuntimeBoundary();

    // The default verifier is unconfigured, so it cannot verify anything: that
    // is a verifier outage (503), not a rejected credential (401).
    await expect(
      boundary.authorize(
        request({
          contextCandidate: {
            'x-actor-user-id': actorUserId,
            'x-project-id': projectId,
            actorUserId,
            projectId,
          },
        }),
      ),
    ).resolves.toEqual({
      kind: 'denied',
      reason: 'CONTEXT_VERIFIER_UNAVAILABLE',
    });
    await close();
  });

  describe('verifier failures (ERR-2)', () => {
    // A verifier that cannot verify is not a rejected credential. Every other
    // failure of the trust boundary is a credential that was missing or refused.
    const verifierFaults: readonly string[] = [
      'VERIFIER_UNAVAILABLE',
      'KEY_RESOLUTION_FAILED',
      'VERIFICATION_FAILED',
      'MALFORMED_CONTEXT',
    ];

    it('names exactly the verifier faults and only failures the trust boundary can emit', () => {
      expect([...TASK_INBOUND_CONTEXT_VERIFIER_FAULTS].sort()).toEqual(
        [...verifierFaults].sort(),
      );
      for (const fault of TASK_INBOUND_CONTEXT_VERIFIER_FAULTS) {
        expect(TASK_INBOUND_CONTEXT_VERIFICATION_FAILURES).toContain(fault);
      }
    });

    it.each([...TASK_INBOUND_CONTEXT_VERIFICATION_FAILURES])(
      'classifies the verifier failure %s',
      async (failure) => {
        const scopes = scopeProvider();
        const policy = permissionPolicy();
        const { boundary, close } = await createRuntimeBoundary({
          verifier: {
            verify: () => {
              throw new TaskInboundContextVerificationError(failure);
            },
          },
          scopeProvider: scopes,
          permissionPolicy: policy,
        });

        const result = await boundary.authorize(request());

        expect(result).toEqual({
          kind: 'denied',
          reason: verifierFaults.includes(failure)
            ? 'CONTEXT_VERIFIER_UNAVAILABLE'
            : 'UNVERIFIED_CONTEXT',
        });
        expect(Object.keys(result).sort()).toEqual(['kind', 'reason']);
        expect(scopes.resolve).not.toHaveBeenCalled();
        expect(policy.decide).not.toHaveBeenCalled();
        await close();
      },
    );

    it('treats a throw from the trust boundary itself as a verifier outage', async () => {
      const scopes = scopeProvider();
      const policy = permissionPolicy();
      const boundary = new TaskAuthorizationBoundary(
        {
          verify: () => Promise.reject(new Error('trust-boundary-canary')),
        } as unknown as TaskInboundContextTrustBoundary,
        scopes,
        policy,
        { resolveProjectId: jest.fn() },
      );

      const result = await boundary.authorize(request());

      expect(result).toEqual({
        kind: 'denied',
        reason: 'CONTEXT_VERIFIER_UNAVAILABLE',
      });
      expect(JSON.stringify(result)).not.toContain('canary');
      expect(scopes.resolve).not.toHaveBeenCalled();
      expect(policy.decide).not.toHaveBeenCalled();
    });

    it('treats an unexpected error raised while verifying as a verifier outage', async () => {
      const { boundary, close } = await createRuntimeBoundary({
        verifier: {
          verify: () => {
            throw new Error('jwks-secret-canary');
          },
        },
      });

      const result = await boundary.authorize(request());

      expect(result).toEqual({
        kind: 'denied',
        reason: 'CONTEXT_VERIFIER_UNAVAILABLE',
      });
      expect(JSON.stringify(result)).not.toContain('canary');
      await close();
    });
  });

  it('denies when Project scope evidence is not configured', async () => {
    const { boundary, close } = await createRuntimeBoundary({
      verifier: { verify: jest.fn().mockResolvedValue(verifiedContext) },
    });

    await expect(boundary.authorize(request())).resolves.toEqual({
      kind: 'denied',
      reason: 'PROJECT_SCOPE_UNAVAILABLE',
    });
    await close();
  });

  it('uses the default deny-all operation policy after verified scope evidence', async () => {
    const { boundary, close } = await createRuntimeBoundary({
      verifier: { verify: jest.fn().mockResolvedValue(verifiedContext) },
      scopeProvider: scopeProvider(),
    });

    await expect(boundary.authorize(request())).resolves.toEqual({
      kind: 'denied',
      reason: 'PERMISSION_DENIED',
    });
    await close();
  });

  it.each(['create', 'list', 'detail', 'history'] as const)(
    'denies %s when no operation grant exists',
    async (operation) => {
      const policy = permissionPolicy();
      const resolver: TaskResourceProjectResolver = {
        resolveProjectId: jest.fn().mockResolvedValue(projectId),
      };
      const { boundary, close } = await createRuntimeBoundary({
        verifier: { verify: jest.fn().mockResolvedValue(verifiedContext) },
        scopeProvider: scopeProvider(),
        permissionPolicy: policy,
        resourceResolver: resolver,
      });
      const input = request({
        operation,
        ...(operation === 'detail' || operation === 'history'
          ? { resourceId: 'task-id' }
          : {}),
      });

      await expect(boundary.authorize(input)).resolves.toEqual({
        kind: 'denied',
        reason: 'PERMISSION_DENIED',
      });
      expect(policy.decide).toHaveBeenCalledTimes(1);
      await close();
    },
  );

  it('denies an unverified context before Project or permission resolution', async () => {
    const scopes = scopeProvider();
    const policy = permissionPolicy();
    const { boundary, close } = await createRuntimeBoundary({
      verifier: {
        verify: () => {
          throw new TaskInboundContextVerificationError('INVALID_SIGNATURE');
        },
      },
      scopeProvider: scopes,
      permissionPolicy: policy,
    });

    const result = await boundary.authorize(request());
    expect(result).toEqual({ kind: 'denied', reason: 'UNVERIFIED_CONTEXT' });
    expect(scopes.resolve).not.toHaveBeenCalled();
    expect(policy.decide).not.toHaveBeenCalled();
    await close();
  });

  it('fails closed for malformed verifier output', async () => {
    const scopes = scopeProvider();
    const policy = permissionPolicy();
    const { boundary, close } = await createRuntimeBoundary({
      verifier: {
        verify: jest.fn().mockResolvedValue({
          ...verifiedContext,
          unexpected: 'caller-controlled',
        }),
      },
      scopeProvider: scopes,
      permissionPolicy: policy,
    });

    // Output the verifier should never produce is a verifier fault, not a
    // rejected credential.
    await expect(boundary.authorize(request())).resolves.toEqual({
      kind: 'denied',
      reason: 'CONTEXT_VERIFIER_UNAVAILABLE',
    });
    expect(scopes.resolve).not.toHaveBeenCalled();
    expect(policy.decide).not.toHaveBeenCalled();
    await close();
  });

  it('fails closed for a hostile malformed request object', async () => {
    const verifier = { verify: jest.fn().mockResolvedValue(verifiedContext) };
    const { boundary, close } = await createRuntimeBoundary({ verifier });
    const hostileRequest = new Proxy(request(), {
      getPrototypeOf() {
        throw new Error('prototype trap canary');
      },
    });

    await expect(boundary.authorize(hostileRequest)).resolves.toEqual({
      kind: 'denied',
      reason: 'INVALID_REQUEST',
    });
    expect(verifier.verify).not.toHaveBeenCalled();
    await close();
  });

  it('denies a Project that differs from the verified context', async () => {
    const scopes = scopeProvider();
    const policy = permissionPolicy();
    const { boundary, close } = await createRuntimeBoundary({
      verifier: {
        verify: jest.fn().mockResolvedValue({
          ...verifiedContext,
          projectId: otherProjectId,
        }),
      },
      scopeProvider: scopes,
      permissionPolicy: policy,
    });

    await expect(boundary.authorize(request())).resolves.toEqual({
      kind: 'denied',
      reason: 'PROJECT_MISMATCH',
    });
    expect(scopes.resolve).not.toHaveBeenCalled();
    expect(policy.decide).not.toHaveBeenCalled();
    await close();
  });

  it('denies a detail resource from another Project before scope or policy evaluation', async () => {
    const scopes = scopeProvider();
    const policy = permissionPolicy();
    const resolver: TaskResourceProjectResolver = {
      resolveProjectId: jest.fn().mockResolvedValue(otherProjectId),
    };
    const { boundary, close } = await createRuntimeBoundary({
      verifier: { verify: jest.fn().mockResolvedValue(verifiedContext) },
      scopeProvider: scopes,
      permissionPolicy: policy,
      resourceResolver: resolver,
    });

    await expect(
      boundary.authorize(
        request({
          operation: 'detail',
          resourceId: 'task-id',
        }),
      ),
    ).resolves.toEqual({ kind: 'denied', reason: 'RESOURCE_SCOPE_MISMATCH' });
    expect(resolver.resolveProjectId).toHaveBeenCalledWith({
      resourceId: 'task-id',
      requestedProjectId: projectId,
    });
    expect(scopes.resolve).not.toHaveBeenCalled();
    expect(policy.decide).not.toHaveBeenCalled();
    await close();
  });

  it('resolves the task resource and passes history as a distinct permission operation', async () => {
    const policy: TaskOperationPermissionPolicy = {
      decide: jest.fn().mockResolvedValue('ALLOW'),
    };
    const resolver: TaskResourceProjectResolver = {
      resolveProjectId: jest.fn().mockResolvedValue(projectId),
    };
    const { boundary, close } = await createRuntimeBoundary({
      verifier: { verify: jest.fn().mockResolvedValue(verifiedContext) },
      scopeProvider: scopeProvider(),
      permissionPolicy: policy,
      resourceResolver: resolver,
    });

    await expect(
      boundary.authorize(
        request({ operation: 'history', resourceId: 'task-id' }),
      ),
    ).resolves.toMatchObject({ kind: 'authorized', operation: 'history' });
    expect(resolver.resolveProjectId).toHaveBeenCalledWith({
      resourceId: 'task-id',
      requestedProjectId: projectId,
    });
    expect(policy.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'history',
        actorUserId,
        projectId,
        resolvedResourceProjectId: projectId,
      }),
    );
    await close();
  });

  it('denies detail when the configured resource resolver cannot resolve the Project', async () => {
    const scopes = scopeProvider();
    const { boundary, close } = await createRuntimeBoundary({
      verifier: { verify: jest.fn().mockResolvedValue(verifiedContext) },
      scopeProvider: scopes,
    });

    await expect(
      boundary.authorize(
        request({ operation: 'detail', resourceId: 'task-id' }),
      ),
    ).resolves.toEqual({
      kind: 'denied',
      reason: 'RESOURCE_SCOPE_UNRESOLVED',
    });
    expect(scopes.resolve).not.toHaveBeenCalled();
    await close();
  });

  it('reports an unavailable resource resolver apart from a missing resource and sanitizes the failure', async () => {
    const scopes = scopeProvider();
    const resolver: TaskResourceProjectResolver = {
      resolveProjectId: jest
        .fn()
        .mockRejectedValue(new Error('db-secret-canary')),
    };
    const { boundary, close } = await createRuntimeBoundary({
      verifier: { verify: jest.fn().mockResolvedValue(verifiedContext) },
      scopeProvider: scopes,
      resourceResolver: resolver,
    });

    const result = await boundary.authorize(
      request({ operation: 'detail', resourceId: 'task-id' }),
    );
    expect(result).toEqual({
      kind: 'denied',
      reason: 'RESOURCE_SCOPE_UNAVAILABLE',
    });
    expect(JSON.stringify(result)).not.toContain('db-secret-canary');
    expect(scopes.resolve).not.toHaveBeenCalled();
    await close();
  });

  it('denies when active Organization Membership evidence is absent', async () => {
    const scopes = scopeProvider({
      resolve: jest.fn().mockResolvedValue({ kind: 'denied' }),
    });
    const policy = permissionPolicy();
    const { boundary, close } = await createRuntimeBoundary({
      verifier: { verify: jest.fn().mockResolvedValue(verifiedContext) },
      scopeProvider: scopes,
      permissionPolicy: policy,
    });

    await expect(boundary.authorize(request())).resolves.toEqual({
      kind: 'denied',
      reason: 'PROJECT_SCOPE_DENIED',
    });
    expect(policy.decide).not.toHaveBeenCalled();
    await close();
  });

  it('fails closed and sanitizes Project resolver failures', async () => {
    const scopes = scopeProvider({
      resolve: jest.fn().mockRejectedValue(new Error('db-secret-canary')),
    });
    const { boundary, close } = await createRuntimeBoundary({
      verifier: { verify: jest.fn().mockResolvedValue(verifiedContext) },
      scopeProvider: scopes,
    });

    const result = await boundary.authorize(request());
    expect(result).toEqual({
      kind: 'denied',
      reason: 'PROJECT_SCOPE_UNAVAILABLE',
    });
    expect(JSON.stringify(result)).not.toContain('db-secret-canary');
    await close();
  });

  it('fails closed for malformed Project scope provider output', async () => {
    const policy = permissionPolicy();
    const malformedEvidence = new Proxy(resolvedScope, {
      getPrototypeOf() {
        throw new Error('scope provider proxy canary');
      },
    });
    const scopes = scopeProvider({
      resolve: jest.fn().mockResolvedValue(malformedEvidence),
    });
    const { boundary, close } = await createRuntimeBoundary({
      verifier: { verify: jest.fn().mockResolvedValue(verifiedContext) },
      scopeProvider: scopes,
      permissionPolicy: policy,
    });

    await expect(boundary.authorize(request())).resolves.toEqual({
      kind: 'denied',
      reason: 'PROJECT_SCOPE_UNAVAILABLE',
    });
    expect(policy.decide).not.toHaveBeenCalled();
    await close();
  });

  it('fails closed and sanitizes permission-policy failures', async () => {
    const policy = permissionPolicy({
      decide: jest.fn().mockRejectedValue(new Error('policy-secret-canary')),
    });
    const { boundary, close } = await createRuntimeBoundary({
      verifier: { verify: jest.fn().mockResolvedValue(verifiedContext) },
      scopeProvider: scopeProvider(),
      permissionPolicy: policy,
    });

    const result = await boundary.authorize(request());
    expect(result).toEqual({
      kind: 'denied',
      reason: 'PERMISSION_POLICY_UNAVAILABLE',
    });
    expect(JSON.stringify(result)).not.toContain('policy-secret-canary');
    await close();
  });

  it('returns an authorized scope only after both scope and policy explicitly allow', async () => {
    const policy = permissionPolicy({
      decide: jest.fn().mockResolvedValue('ALLOW'),
    });
    const { boundary, close } = await createRuntimeBoundary({
      verifier: { verify: jest.fn().mockResolvedValue(verifiedContext) },
      scopeProvider: scopeProvider(),
      permissionPolicy: policy,
    });

    await expect(boundary.authorize(request())).resolves.toEqual({
      kind: 'authorized',
      operation: 'list',
      actorUserId,
      gatewayServiceId: 'svc:be-gateway',
      projectId,
      organizationId,
      requestId: verifiedContext.requestId,
    });
    await close();
  });
});
