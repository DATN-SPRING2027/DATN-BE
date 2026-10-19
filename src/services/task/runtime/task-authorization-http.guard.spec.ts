import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  TASK_OPERATION_PERMISSION_POLICY,
  TASK_PROJECT_SCOPE_EVIDENCE_PROVIDER,
  TASK_RESOURCE_PROJECT_RESOLVER,
  type TaskOperationPermissionFacts,
  type TaskOperationPermissionPolicy,
  type TaskProjectScopeEvidenceProvider,
  type TaskResourceProjectResolver,
} from './task-authorization-boundary';
import {
  TASK_INBOUND_CONTEXT_VERIFIER,
  TaskInboundContextVerificationError,
  type TaskInboundContextVerifier,
} from './task-inbound-context';
import {
  RequireTaskAuthorization,
  TaskAuthorizationHttpGuard,
  getTaskAuthorizedRequestContext,
  type TaskHttpRequestBinding,
} from './task-authorization-http.guard';
import { TaskRuntimeModule } from './task-runtime.module';
import { TASK_DATABASE_NAME } from '../infrastructure/mongodb/task-contract';

const testSink = Symbol('TEST_TASK_HANDLER_SINK');
const actorUserId = '0123456789abcdef01234567';
const projectId = 'abcdef0123456789abcdef01';
const taskId = 'fedcba9876543210fedcba98';
const acceptedProof = 'test-only-opaque-proof';

interface HandlerSink {
  create: jest.Mock;
  list: jest.Mock;
  detail: jest.Mock;
}

@Controller('test/projects/:projectId/tasks')
class TestOnlyTaskController {
  constructor(@Inject(testSink) private readonly sink: HandlerSink) {}

  @Get()
  @UseGuards(TaskAuthorizationHttpGuard)
  @RequireTaskAuthorization({ operation: 'list', projectIdParam: 'projectId' })
  list(@Req() requestValue: unknown): { ok: true } {
    this.sink.list(getTaskAuthorizedRequestContext(requestValue));
    return { ok: true };
  }

  @Post()
  @UseGuards(TaskAuthorizationHttpGuard)
  @RequireTaskAuthorization({
    operation: 'create',
    projectIdParam: 'projectId',
  })
  create(@Body() body: unknown, @Req() requestValue: unknown): { ok: true } {
    this.sink.create(body, getTaskAuthorizedRequestContext(requestValue));
    return { ok: true };
  }

  @Get(':taskId')
  @UseGuards(TaskAuthorizationHttpGuard)
  @RequireTaskAuthorization({
    operation: 'detail',
    projectIdParam: 'projectId',
    resourceIdParam: 'taskId',
  })
  detail(@Req() requestValue: unknown): { ok: true } {
    this.sink.detail(getTaskAuthorizedRequestContext(requestValue));
    return { ok: true };
  }
}

function isBinding(value: unknown): value is TaskHttpRequestBinding {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    typeof (value as TaskHttpRequestBinding).method === 'string' &&
    typeof (value as TaskHttpRequestBinding).target === 'string' &&
    typeof (value as TaskHttpRequestBinding).projectId === 'string'
  );
}

function makeVerifier(
  verify: jest.MockedFunction<TaskInboundContextVerifier['verify']>,
): TaskInboundContextVerifier {
  return { verify };
}

async function createTestApplication(options?: {
  verifier?: TaskInboundContextVerifier;
  scope?: TaskProjectScopeEvidenceProvider;
  policy?: TaskOperationPermissionPolicy;
  resourceResolver?: TaskResourceProjectResolver;
  rawBodyCapture?: boolean;
  events?: string[];
}) {
  const recordHandler = (name: keyof HandlerSink): jest.Mock =>
    jest.fn(() => options?.events?.push(`handler:${name}`));
  const sink: HandlerSink = {
    create: recordHandler('create'),
    list: recordHandler('list'),
    detail: recordHandler('detail'),
  };
  const runtimeModule = TaskRuntimeModule.register({
    mongoUri: 'mongodb://127.0.0.1:27017/continuum_task',
    port: 3100,
  });
  const testScope: TaskProjectScopeEvidenceProvider = {
    resolve: () => ({
      kind: 'resolved',
      evidence: {
        actorUserId,
        projectId,
        organizationId: 'organization-from-test-fixture',
        organizationMembershipStatus: 'ACTIVE',
      },
    }),
  };
  const builder = Test.createTestingModule({
    controllers: [TestOnlyTaskController],
    providers: [
      {
        provide: getConnectionToken(),
        useValue: { db: { databaseName: TASK_DATABASE_NAME } },
      },
      ...(runtimeModule.providers ?? []),
      { provide: testSink, useValue: sink },
    ],
  });
  builder
    .overrideProvider(TASK_PROJECT_SCOPE_EVIDENCE_PROVIDER)
    .useValue(options?.scope ?? testScope);
  if (options?.verifier) {
    builder
      .overrideProvider(TASK_INBOUND_CONTEXT_VERIFIER)
      .useValue(options.verifier);
  }
  if (options?.policy) {
    builder
      .overrideProvider(TASK_OPERATION_PERMISSION_POLICY)
      .useValue(options.policy);
  }
  if (options?.resourceResolver) {
    builder
      .overrideProvider(TASK_RESOURCE_PROJECT_RESOLVER)
      .useValue(options.resourceResolver);
  }
  const moduleRef = await builder.compile();
  const resolvedApp = moduleRef.createNestApplication({
    rawBody: options?.rawBodyCapture !== false,
  });
  await resolvedApp.init();

  return {
    app: resolvedApp,
    sink,
    httpServer: resolvedApp.getHttpServer() as App,
    close: async () => resolvedApp.close(),
  };
}

function acceptingVerifier(
  onVerify?: (candidate: unknown, binding: unknown) => void,
): TaskInboundContextVerifier {
  return makeVerifier(
    jest.fn((candidate: unknown, binding: unknown) => {
      onVerify?.(candidate, binding);
      if (candidate !== acceptedProof || !isBinding(binding)) {
        throw new TaskInboundContextVerificationError('INVALID_SIGNATURE');
      }
      return {
        actorUserId,
        gatewayServiceId: 'gateway-test-fixture',
        projectId: binding.projectId,
        requestId: 'request-id-from-verified-test-proof',
      };
    }),
  );
}

describe('TaskAuthorizationHttpGuard over a real Nest HTTP boundary', () => {
  jest.setTimeout(20_000);

  it('rejects forged actor and Project headers without an Authorization proof', async () => {
    const verifier = acceptingVerifier();
    const test = await createTestApplication({ verifier });
    try {
      const response = await request(test.httpServer)
        .get(`/test/projects/${projectId}/tasks`)
        .set('x-actor-user-id', actorUserId)
        .set('x-project-id', projectId);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(test.sink.list).not.toHaveBeenCalled();
      expect(verifier.verify).not.toHaveBeenCalled();
      expect(JSON.stringify(response.body)).not.toContain(actorUserId);
    } finally {
      await test.close();
    }
  });

  it('uses only the verifier-produced actor and ignores spoofed identity headers', async () => {
    const policyFacts: TaskOperationPermissionFacts[] = [];
    const verifier = acceptingVerifier();
    const policy: TaskOperationPermissionPolicy = {
      decide: jest.fn((facts: TaskOperationPermissionFacts) => {
        policyFacts.push(facts);
        return 'ALLOW';
      }),
    };
    const test = await createTestApplication({ verifier, policy });
    try {
      const response = await request(test.httpServer)
        .get(`/test/projects/${projectId}/tasks`)
        .set('Authorization', `Bearer ${acceptedProof}`)
        .set('x-actor-user-id', 'forged-user')
        .set('x-project-id', 'forged-project');

      expect(verifier.verify).toHaveBeenCalledTimes(1);
      expect(policy.decide).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
      expect(verifier.verify).toHaveBeenCalledTimes(1);
      expect(verifier.verify).toHaveBeenCalledWith(
        acceptedProof,
        expect.objectContaining({
          method: 'GET',
          target: `/test/projects/${projectId}/tasks`,
          projectId,
        }),
      );
      expect(policyFacts[0]).toMatchObject({
        actorUserId,
        projectId,
        gatewayServiceId: 'gateway-test-fixture',
        operation: 'list',
      });
      expect(test.sink.list).toHaveBeenCalledTimes(1);
      expect(test.sink.list).toHaveBeenCalledWith({
        kind: 'authorized',
        operation: 'list',
        actorUserId,
        gatewayServiceId: 'gateway-test-fixture',
        projectId,
        organizationId: 'organization-from-test-fixture',
        requestId: 'request-id-from-verified-test-proof',
      });
    } finally {
      await test.close();
    }
  });

  it('keeps the default verifier unavailable and the default policy deny-only', async () => {
    const test = await createTestApplication();
    try {
      const response = await request(test.httpServer)
        .get(`/test/projects/${projectId}/tasks`)
        .set('Authorization', `Bearer ${acceptedProof}`);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(test.sink.list).not.toHaveBeenCalled();
      expect(JSON.stringify(response.body)).not.toContain(acceptedProof);
    } finally {
      await test.close();
    }
  });

  it.each([
    'INVALID_SIGNATURE',
    'WRONG_AUDIENCE',
    'EXPIRED',
    'UNKNOWN_KEY_ID',
  ] as const)(
    'does not call the handler for verifier rejection %s',
    async (reason) => {
      const verifier = makeVerifier(
        jest.fn((_candidate: unknown, _binding: unknown) => {
          void _candidate;
          void _binding;
          throw new TaskInboundContextVerificationError(reason);
        }),
      );
      const test = await createTestApplication({
        verifier,
        policy: { decide: () => 'ALLOW' },
      });
      try {
        const response = await request(test.httpServer)
          .get(`/test/projects/${projectId}/tasks`)
          .set('Authorization', `Bearer ${acceptedProof}`);

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(test.sink.list).not.toHaveBeenCalled();
        expect(JSON.stringify(response.body)).not.toContain(acceptedProof);
      } finally {
        await test.close();
      }
    },
  );

  it('does not call the handler or expose provider details after verifier failure', async () => {
    const verifier = makeVerifier(
      jest.fn((_candidate: unknown, _binding: unknown) => {
        void _candidate;
        void _binding;
        throw new Error('private key provider detail');
      }),
    );
    const test = await createTestApplication({
      verifier,
      policy: { decide: () => 'ALLOW' },
    });
    try {
      const response = await request(test.httpServer)
        .get(`/test/projects/${projectId}/tasks`)
        .set('Authorization', `Bearer ${acceptedProof}`);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(test.sink.list).not.toHaveBeenCalled();
      expect(JSON.stringify(response.body)).not.toContain(acceptedProof);
      expect(JSON.stringify(response.body)).not.toContain(
        'private key provider',
      );
    } finally {
      await test.close();
    }
  });

  it('rejects verified context bound to another Project before evaluating policy', async () => {
    const verifier = makeVerifier(
      jest.fn((_candidate: unknown, _binding: unknown) => {
        void _candidate;
        void _binding;
        return {
          actorUserId,
          gatewayServiceId: 'gateway-test-fixture',
          projectId: 'ffffffffffffffffffffffff',
          requestId: 'request-id-from-verified-test-proof',
        };
      }),
    );
    const policy = { decide: jest.fn(() => 'ALLOW' as const) };
    const test = await createTestApplication({ verifier, policy });
    try {
      const response = await request(test.httpServer)
        .get(`/test/projects/${projectId}/tasks`)
        .set('Authorization', `Bearer ${acceptedProof}`);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(test.sink.list).not.toHaveBeenCalled();
      expect(policy.decide).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it.each([
    ['scope unavailable', { kind: 'unavailable' }],
    ['scope denied', { kind: 'denied' }],
  ] as const)(
    'stops before the handler when Project scope is %s',
    async (_label, result) => {
      const verifier = acceptingVerifier();
      const scope = { resolve: jest.fn(() => result) };
      const policy = { decide: jest.fn(() => 'ALLOW' as const) };
      const test = await createTestApplication({ verifier, scope, policy });
      try {
        const response = await request(test.httpServer)
          .get(`/test/projects/${projectId}/tasks`)
          .set('Authorization', `Bearer ${acceptedProof}`);

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(test.sink.list).not.toHaveBeenCalled();
        expect(policy.decide).not.toHaveBeenCalled();
      } finally {
        await test.close();
      }
    },
  );

  it('stops before the handler when permission policy denies or fails', async () => {
    const verifier = acceptingVerifier();
    for (const policy of [
      { decide: () => 'DENY' as const },
      {
        decide: () => {
          throw new Error('policy provider secret');
        },
      },
    ]) {
      const test = await createTestApplication({ verifier, policy });
      try {
        const response = await request(test.httpServer)
          .get(`/test/projects/${projectId}/tasks`)
          .set('Authorization', `Bearer ${acceptedProof}`);

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(test.sink.list).not.toHaveBeenCalled();
        expect(JSON.stringify(response.body)).not.toContain(acceptedProof);
        expect(JSON.stringify(response.body)).not.toContain(
          'policy provider secret',
        );
      } finally {
        await test.close();
      }
    }
  });

  it('binds method, target, Project and original body bytes before allowing a mutation', async () => {
    const expectedBody = Buffer.from('{"title":"Task"}');
    const expectedBodySha256 = createHash('sha256')
      .update(expectedBody)
      .digest('base64url');
    const receivedBindings: TaskHttpRequestBinding[] = [];
    const verifier = makeVerifier(
      jest.fn((candidate: unknown, binding: unknown) => {
        if (isBinding(binding)) receivedBindings.push(binding);
        if (
          candidate !== acceptedProof ||
          !isBinding(binding) ||
          binding.method !== 'POST' ||
          binding.target !== `/test/projects/${projectId}/tasks` ||
          binding.projectId !== projectId ||
          binding.bodySha256 !== expectedBodySha256
        ) {
          throw new TaskInboundContextVerificationError('REQUEST_MISMATCH');
        }
        return {
          actorUserId,
          gatewayServiceId: 'gateway-test-fixture',
          projectId,
          requestId: 'request-id-from-verified-test-proof',
        };
      }),
    );
    const policy: TaskOperationPermissionPolicy = { decide: () => 'ALLOW' };
    const test = await createTestApplication({ verifier, policy });
    try {
      const accepted = await request(test.httpServer)
        .post(`/test/projects/${projectId}/tasks`)
        .set('Authorization', `Bearer ${acceptedProof}`)
        .set('content-type', 'application/json')
        .send(expectedBody.toString('utf8'));

      expect(accepted.status).toBeGreaterThanOrEqual(200);
      expect(accepted.status).toBeLessThan(300);
      expect(receivedBindings[0]).toMatchObject({
        method: 'POST',
        target: `/test/projects/${projectId}/tasks`,
        projectId,
      });
      expect(typeof receivedBindings[0].bodySha256).toBe('string');
      expect(receivedBindings[0].bodySha256).toBe(expectedBodySha256);

      const changedBody = await request(test.httpServer)
        .post(`/test/projects/${projectId}/tasks`)
        .set('Authorization', `Bearer ${acceptedProof}`)
        .set('content-type', 'application/json')
        .send('{"title":"Changed"}');

      expect(changedBody.status).toBeGreaterThanOrEqual(400);
      expect(receivedBindings[1].bodySha256).not.toBe(
        receivedBindings[0].bodySha256,
      );
      expect(test.sink.create).toHaveBeenCalledTimes(1);

      const changedTarget = await request(test.httpServer)
        .post(`/test/projects/${projectId}/tasks?mode=other`)
        .set('Authorization', `Bearer ${acceptedProof}`)
        .set('content-type', 'application/json')
        .send(expectedBody.toString('utf8'));
      expect(changedTarget.status).toBeGreaterThanOrEqual(400);
      expect(receivedBindings[2].target).toBe(
        `/test/projects/${projectId}/tasks?mode=other`,
      );
      expect(test.sink.create).toHaveBeenCalledTimes(1);

      const changedMethod = await request(test.httpServer)
        .get(`/test/projects/${projectId}/tasks`)
        .set('Authorization', `Bearer ${acceptedProof}`);
      expect(changedMethod.status).toBeGreaterThanOrEqual(400);
      expect(receivedBindings[3].method).toBe('GET');
      expect(test.sink.create).toHaveBeenCalledTimes(1);
      expect(test.sink.list).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it('fails closed when raw body capture is absent for a mutation', async () => {
    const verifier = acceptingVerifier();
    const test = await createTestApplication({
      verifier,
      policy: { decide: () => 'ALLOW' },
      rawBodyCapture: false,
    });
    try {
      const response = await request(test.httpServer)
        .post(`/test/projects/${projectId}/tasks`)
        .set('Authorization', `Bearer ${acceptedProof}`)
        .send({ title: 'Task' });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(verifier.verify).not.toHaveBeenCalled();
      expect(test.sink.create).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it('verifies delegation, resolves scope, checks permission, then calls detail handler', async () => {
    const events: string[] = [];
    const verifier: TaskInboundContextVerifier = {
      verify: jest.fn(() => {
        events.push('verify');
        return {
          actorUserId,
          gatewayServiceId: 'gateway-test-fixture',
          projectId,
          requestId: 'request-id-from-verified-test-proof',
        };
      }),
    };
    const resolveProjectId = jest.fn((): string | undefined => {
      events.push('resource-scope');
      return projectId;
    });
    const resolver: TaskResourceProjectResolver = { resolveProjectId };
    const scope: TaskProjectScopeEvidenceProvider = {
      resolve: jest.fn(() => {
        events.push('project-scope');
        return {
          kind: 'resolved',
          evidence: {
            actorUserId,
            projectId,
            organizationId: 'organization-from-test-fixture',
            organizationMembershipStatus: 'ACTIVE',
          },
        };
      }),
    };
    const policy: TaskOperationPermissionPolicy = {
      decide: jest.fn(() => {
        events.push('permission');
        return 'ALLOW';
      }),
    };
    const test = await createTestApplication({
      verifier,
      resourceResolver: resolver,
      scope,
      policy,
      events,
    });
    try {
      const allowed = await request(test.httpServer)
        .get(`/test/projects/${projectId}/tasks/${taskId}`)
        .set('Authorization', `Bearer ${acceptedProof}`);
      expect(allowed.status).toBe(200);
      expect(resolver.resolveProjectId).toHaveBeenCalledWith({
        resourceId: taskId,
        requestedProjectId: projectId,
      });
      expect(policy.decide).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        'verify',
        'resource-scope',
        'project-scope',
        'permission',
        'handler:detail',
      ]);

      resolveProjectId.mockReturnValueOnce(undefined);
      const missing = await request(test.httpServer)
        .get(`/test/projects/${projectId}/tasks/${taskId}`)
        .set('Authorization', `Bearer ${acceptedProof}`);
      expect(missing.status).toBeGreaterThanOrEqual(400);
      expect(test.sink.detail).toHaveBeenCalledTimes(1);
      expect(policy.decide).toHaveBeenCalledTimes(1);

      resolveProjectId.mockImplementationOnce(() => {
        throw new Error('private resource lookup detail');
      });
      const unavailable = await request(test.httpServer)
        .get(`/test/projects/${projectId}/tasks/${taskId}`)
        .set('Authorization', `Bearer ${acceptedProof}`);
      expect(unavailable.status).toBeGreaterThanOrEqual(400);
      expect(test.sink.detail).toHaveBeenCalledTimes(1);
      expect(policy.decide).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(unavailable.body)).not.toContain(
        'private resource lookup detail',
      );
    } finally {
      await test.close();
    }
  });
});
