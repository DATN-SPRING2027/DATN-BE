import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { requestIdMiddleware } from '../../../common/http/request-id.middleware';
import {
  parseTaskCreateInput,
  type TaskCreationContext,
  type TaskDocument,
} from '../infrastructure/mongodb/task-contract';
import {
  TaskDataRepository,
  type TaskCreateResult,
} from '../infrastructure/mongodb/task-data.repository';
import {
  TASK_OPERATION_PERMISSION_POLICY,
  TASK_PROJECT_SCOPE_EVIDENCE_PROVIDER,
  type TaskOperationPermissionPolicy,
  type TaskProjectScopeEvidenceProvider,
} from '../runtime/task-authorization-boundary';
import {
  TASK_INBOUND_CONTEXT_VERIFIER,
  TaskInboundContextVerificationError,
  type TaskInboundContextVerifier,
} from '../runtime/task-inbound-context';
import { TaskRuntimeModule } from '../runtime/task-runtime.module';
import { TaskCreateController } from './task-create.controller';
import { TaskHttpExceptionFilter } from './task-http-exception.filter';

const actorUserId = '0123456789abcdef01234567';
const projectId = 'abcdef0123456789abcdef01';
const newTaskId = '650000000000000000000001';
const acceptedProof = 'test-only-opaque-proof';
const path = `/tasks/projects/${projectId}/tasks`;
const requestIdFromProof = 'request-id-from-verified-test-proof';

function committedTask(
  context: TaskCreationContext,
  title: string,
): TaskDocument {
  return {
    _id: new Types.ObjectId(newTaskId),
    projectId: context.projectId,
    title,
    createdBy: context.actorId,
    createdAt: new Date('2026-10-20T01:00:00.000Z'),
    updatedAt: new Date('2026-10-20T01:00:00.000Z'),
    status: 'TODO',
    assigneeId: null,
    completedAt: null,
    version: 1,
  };
}

/** Validates like the real repository (parseTaskCreateInput) and commits in memory. */
function fakeRepository(fixedResult?: TaskCreateResult | Error) {
  return {
    create: jest.fn(
      (
        context: TaskCreationContext,
        body: unknown,
      ): Promise<TaskCreateResult> => {
        if (fixedResult instanceof Error) return Promise.reject(fixedResult);
        if (fixedResult) return Promise.resolve(fixedResult);
        const input = parseTaskCreateInput(body);
        if (!input) {
          return Promise.resolve({
            state: 'REJECTED',
            reason: 'INVALID_INPUT',
          });
        }
        return Promise.resolve({
          state: 'COMMITTED',
          task: committedTask(context, input.title),
          reconciled: false,
        });
      },
    ),
    getById: jest.fn(() => Promise.resolve(null)),
    listByProject: jest.fn(() => Promise.resolve([])),
  };
}

function acceptingVerifier(): TaskInboundContextVerifier {
  return {
    verify: jest.fn((candidate: unknown, binding: unknown) => {
      const requested = (binding as { projectId?: string }).projectId;
      if (candidate !== acceptedProof || typeof requested !== 'string') {
        throw new TaskInboundContextVerificationError('INVALID_SIGNATURE');
      }
      return {
        actorUserId,
        gatewayServiceId: 'gateway-test-fixture',
        projectId: requested,
        requestId: requestIdFromProof,
      };
    }),
  };
}

const resolvedScope: TaskProjectScopeEvidenceProvider = {
  resolve: () => ({
    kind: 'resolved',
    evidence: {
      actorUserId,
      projectId,
      organizationId: 'organization-from-test-fixture',
      organizationMembershipStatus: 'ACTIVE',
      projectMembershipStatus: 'ACTIVE',
    },
  }),
};

const allowPolicy: TaskOperationPermissionPolicy = { decide: () => 'ALLOW' };

async function createApp(options: {
  repository?: ReturnType<typeof fakeRepository>;
  verifier?: TaskInboundContextVerifier;
  scope?: TaskProjectScopeEvidenceProvider;
  policy?: TaskOperationPermissionPolicy;
}): Promise<{
  app: INestApplication;
  http: App;
  repository: ReturnType<typeof fakeRepository>;
}> {
  const repository = options.repository ?? fakeRepository();
  const runtimeProviders =
    TaskRuntimeModule.register({
      mongoUri: 'mongodb://127.0.0.1:27017/continuum_task',
      port: 3100,
      routesEnabled: true,
      createRouteEnabled: true,
    }).providers ?? [];
  const builder = Test.createTestingModule({
    controllers: [TaskCreateController],
    providers: runtimeProviders,
  });
  builder.overrideProvider(TaskDataRepository).useValue(repository);
  if (options.verifier) {
    builder
      .overrideProvider(TASK_INBOUND_CONTEXT_VERIFIER)
      .useValue(options.verifier);
  }
  if (options.scope) {
    builder
      .overrideProvider(TASK_PROJECT_SCOPE_EVIDENCE_PROVIDER)
      .useValue(options.scope);
  }
  if (options.policy) {
    builder
      .overrideProvider(TASK_OPERATION_PERMISSION_POLICY)
      .useValue(options.policy);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  // Mirrors main.ts: request id first, and the Task filter for errors raised
  // outside a route (the body parser).
  app.use(requestIdMiddleware);
  app.useGlobalFilters(new TaskHttpExceptionFilter());
  await app.init();
  return { app, http: app.getHttpServer() as App, repository };
}

const allowed = {
  verifier: acceptingVerifier,
  scope: resolvedScope,
  policy: allowPolicy,
};

function authorizedPost(http: App, body: unknown) {
  return request(http)
    .post(path)
    .set('Authorization', `Bearer ${acceptedProof}`)
    .set('x-request-id', 'req-from-test')
    .send(body as object);
}

describe('Task create route (dormant; DATN-97 create contract)', () => {
  jest.setTimeout(20_000);
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(
    options: Parameters<typeof createApp>[0] = {},
  ): Promise<Awaited<ReturnType<typeof createApp>>> {
    const test = await createApp({
      verifier: allowed.verifier(),
      scope: allowed.scope,
      policy: allowed.policy,
      ...options,
    });
    app = test.app;
    return test;
  }

  it('creates the Task with the verified actor and the path Project, answering 201 with the seven fields', async () => {
    const test = await start();

    const response = await authorizedPost(test.http, {
      title: 'Write the report',
    });

    expect(response.status).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.location).toBe(`/internal${path}/${newTaskId}`);
    expect(response.body).toEqual({
      id: newTaskId,
      projectId,
      title: 'Write the report',
      createdBy: actorUserId,
      createdAt: '2026-10-20T01:00:00.000Z',
      updatedAt: '2026-10-20T01:00:00.000Z',
      version: 1,
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /status|assigneeId|completedAt/,
    );
    expect(test.repository.create).toHaveBeenCalledTimes(1);
    const [context, body] = test.repository.create.mock.calls[0];
    expect(context.projectId.toHexString()).toBe(projectId);
    expect(context.actorId.toHexString()).toBe(actorUserId);
    expect(context.requestId).toBe(requestIdFromProof);
    expect(body).toEqual({ title: 'Write the report' });
  });

  it('keeps the title as given, with no trimming and no length cap', async () => {
    const test = await start();
    const title = `  ${'é'.repeat(600)}  `;

    const response = await authorizedPost(test.http, { title });

    expect(response.status).toBe(201);
    expect((response.body as { title: string }).title).toBe(title);
  });

  it.each([
    ['no property', {}],
    ['an empty title', { title: '' }],
    ['a white-space-only title', { title: ' \t 　 ' }],
    ['a non-string title', { title: 5 }],
    ['an unknown property', { title: 'ok', extra: 1 }],
    ['a caller-set createdBy', { title: 'ok', createdBy: actorUserId }],
    ['a caller-set id', { title: 'ok', id: newTaskId }],
    ['an array body', ['title']],
  ])(
    'answers 422 TASK_VALIDATION_FAILED for %s, after authorization',
    async (_label, body) => {
      const test = await start();

      const response = await authorizedPost(test.http, body);

      expect(response.status).toBe(422);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({
        code: 'TASK_VALIDATION_FAILED',
        message: 'Request validation failed',
        details: { messages: [expect.any(String) as string] },
        requestId: 'req-from-test',
      });
    },
  );

  it('answers 422 for a body that is not valid JSON, the only validation that precedes authorization', async () => {
    const test = await start();

    const response = await request(test.http)
      .post(path)
      .set('Content-Type', 'application/json')
      .set('x-request-id', 'req-from-test')
      .send('{"title": ');

    expect(response.status).toBe(422);
    expect(response.headers['cache-control']).toBe('no-store');
    expect((response.body as { code: string }).code).toBe(
      'TASK_VALIDATION_FAILED',
    );
    expect(test.repository.create).not.toHaveBeenCalled();
  });

  it('authorizes an empty body before returning 422 for the missing Task title', async () => {
    const verifier = allowed.verifier();
    const test = await start({ verifier });

    const response = await request(test.http)
      .post(path)
      .set('Authorization', `Bearer ${acceptedProof}`)
      .set('Content-Type', 'application/json')
      .set('x-request-id', 'req-from-test');

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      code: 'TASK_VALIDATION_FAILED',
      message: 'Request validation failed',
      details: { messages: [expect.any(String) as string] },
      requestId: 'req-from-test',
    });
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(test.repository.create).toHaveBeenCalledTimes(1);
    expect(test.repository.create.mock.calls[0][1]).toEqual({});
  });

  describe('authorization runs before the body is validated and before anything is written', () => {
    const invalidBody = {};
    const scenarios: [
      string,
      number,
      string,
      () => Parameters<typeof createApp>[0],
      boolean,
    ][] = [
      [
        'a missing credential',
        401,
        'TASK_UNAUTHENTICATED',
        () => ({
          verifier: acceptingVerifier(),
          scope: resolvedScope,
          policy: allowPolicy,
        }),
        false,
      ],
      [
        'a refused credential',
        401,
        'TASK_UNAUTHENTICATED',
        () => ({
          verifier: {
            verify: () => {
              throw new TaskInboundContextVerificationError('EXPIRED');
            },
          },
          scope: resolvedScope,
          policy: allowPolicy,
        }),
        true,
      ],
      [
        'a verifier that cannot verify',
        503,
        'TASK_AUTHORIZATION_UNAVAILABLE',
        () => ({
          verifier: {
            verify: () => {
              throw new TaskInboundContextVerificationError(
                'VERIFIER_UNAVAILABLE',
              );
            },
          },
          scope: resolvedScope,
          policy: allowPolicy,
        }),
        true,
      ],
      [
        'a non-member',
        404,
        'TASK_NOT_FOUND',
        () => ({
          verifier: acceptingVerifier(),
          scope: { resolve: () => ({ kind: 'denied' as const }) },
          policy: allowPolicy,
        }),
        true,
      ],
      [
        'a denied permission',
        404,
        'TASK_NOT_FOUND',
        () => ({
          verifier: acceptingVerifier(),
          scope: resolvedScope,
          policy: { decide: () => 'DENY' as const },
        }),
        true,
      ],
    ];

    it.each(scenarios)(
      '%s -> %i %s, even with an invalid body',
      async (_label, status, code, options, withProof) => {
        const test = await start(options());

        let call = request(test.http)
          .post(path)
          .set('x-request-id', 'req-from-test');
        if (withProof)
          call = call.set('Authorization', `Bearer ${acceptedProof}`);
        const response = await call.send(invalidBody);

        expect(response.status).toBe(status);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['www-authenticate']).toBe(
          status === 401 ? 'Bearer' : undefined,
        );
        expect(response.body).toEqual({
          code,
          message: expect.any(String) as string,
          details: {},
          requestId: 'req-from-test',
        });
        expect(test.repository.create).not.toHaveBeenCalled();
      },
    );

    it('stays unavailable (503) with the default unconfigured verifier and never writes', async () => {
      const test = await createApp({});
      app = test.app;

      const response = await authorizedPost(test.http, { title: 'ok' });

      expect(response.status).toBe(503);
      expect(test.repository.create).not.toHaveBeenCalled();
    });
  });

  describe('repository results (CREATE-2, DR7D-1)', () => {
    it('answers 201 for a commit that the repository reconciled', async () => {
      const context = {
        projectId: new Types.ObjectId(projectId),
        actorId: new Types.ObjectId(actorUserId),
      } as TaskCreationContext;
      const test = await start({
        repository: fakeRepository({
          state: 'COMMITTED',
          task: committedTask(context, 'Reconciled'),
          reconciled: true,
        }),
      });

      const response = await authorizedPost(test.http, { title: 'Reconciled' });

      expect(response.status).toBe(201);
      expect((response.body as { title: string }).title).toBe('Reconciled');
    });

    it('answers 503 RETRY_LATER with Retry-After for a confirmed abort', async () => {
      const test = await start({
        repository: fakeRepository({
          state: 'ABORTED',
          reason: 'TRANSACTION_ABORTED',
        }),
      });

      const response = await authorizedPost(test.http, { title: 'ok' });

      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toBe('1');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({
        code: 'RETRY_LATER',
        message: expect.any(String) as string,
        details: {},
        requestId: 'req-from-test',
      });
    });

    it('answers 503 TASK_CREATE_UNCERTAIN with only the taskId for an unknown outcome', async () => {
      const test = await start({
        repository: fakeRepository({
          state: 'UNCERTAIN',
          taskId: newTaskId,
          eventId: '650000000000000000000002',
          operationId: '11111111-2222-4333-8444-555555555555',
          reason: 'NO_MATCHING_PAIR_AT_SNAPSHOT',
        }),
      });

      const response = await authorizedPost(test.http, { title: 'ok' });

      expect(response.status).toBe(503);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['retry-after']).toBeUndefined();
      expect(response.body).toEqual({
        code: 'TASK_CREATE_UNCERTAIN',
        message: expect.any(String) as string,
        details: { taskId: newTaskId },
        requestId: 'req-from-test',
      });
      expect(JSON.stringify(response.body)).not.toMatch(
        /eventId|operationId|NO_MATCHING_PAIR/,
      );
    });

    it('answers a generic 500 for a rejected trusted context, which is a server fault', async () => {
      const test = await start({
        repository: fakeRepository({
          state: 'REJECTED',
          reason: 'INVALID_TRUSTED_CONTEXT',
        }),
      });

      const response = await authorizedPost(test.http, { title: 'ok' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        code: 'HTTP_500',
        message: 'Internal server error',
        details: {},
        requestId: 'req-from-test',
      });
      expect(JSON.stringify(response.body)).not.toContain(
        'INVALID_TRUSTED_CONTEXT',
      );
    });

    it('answers a generic 500 without leaking a repository failure', async () => {
      const test = await start({
        repository: fakeRepository(new Error('db-secret-canary')),
      });

      const response = await authorizedPost(test.http, { title: 'ok' });

      expect(response.status).toBe(500);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(response.body)).not.toContain('canary');
    });
  });

  it('has no Idempotency-Key: the header is ignored and a retry creates another Task (DR7C-1)', async () => {
    const test = await start();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await authorizedPost(test.http, { title: 'same' }).set(
        'Idempotency-Key',
        'client-key-1',
      );
      expect(response.status).toBe(201);
    }

    expect(test.repository.create).toHaveBeenCalledTimes(2);
  });
});
