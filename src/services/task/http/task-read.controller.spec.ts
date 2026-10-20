import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { requestIdMiddleware } from '../../../common/http/request-id.middleware';
import type { TaskDocument } from '../infrastructure/mongodb/task-contract';
import { TaskDataRepository } from '../infrastructure/mongodb/task-data.repository';
import {
  TASK_OPERATION_PERMISSION_POLICY,
  TASK_PROJECT_SCOPE_EVIDENCE_PROVIDER,
  TASK_RESOURCE_PROJECT_RESOLVER,
  TaskAuthorizationBoundary,
  type TaskOperationPermissionPolicy,
  type TaskProjectScopeEvidenceProvider,
} from '../runtime/task-authorization-boundary';
import {
  TASK_INBOUND_CONTEXT_VERIFIER,
  TaskInboundContextVerificationError,
  type TaskInboundContextVerifier,
} from '../runtime/task-inbound-context';
import { RepositoryTaskResourceProjectResolver } from '../runtime/task-repository-resource-project.resolver';
import { TaskRuntimeModule } from '../runtime/task-runtime.module';
import { TaskReadController } from './task-read.controller';
import { TASK_READ_REPOSITORY, TaskReadService } from './task-read.service';

const actorUserId = '0123456789abcdef01234567';
const projectId = 'abcdef0123456789abcdef01';
const otherProjectId = 'fedcba9876543210fedcba98';
const acceptedProof = 'test-only-opaque-proof';
const base = `/tasks/projects/${projectId}/tasks`;

function taskId(n: number): string {
  return (0x650000000000 + n).toString(16).padStart(24, '0');
}

function storedTask(
  n: number,
  overrides: Partial<TaskDocument> = {},
): TaskDocument {
  return {
    _id: new Types.ObjectId(taskId(n)),
    projectId: new Types.ObjectId(projectId),
    title: `Task ${n}`,
    createdBy: new Types.ObjectId(actorUserId),
    createdAt: new Date('2026-10-19T01:00:00.000Z'),
    updatedAt: new Date('2026-10-19T01:00:00.000Z'),
    status: 'TODO',
    assigneeId: null,
    completedAt: null,
    version: 1,
    ...overrides,
  };
}

function inMemoryRepository(documents: TaskDocument[]) {
  return {
    getById: jest.fn((requestedProjectId: string, requestedTaskId: string) =>
      Promise.resolve(
        documents.find(
          (document) =>
            document.projectId.toHexString() === requestedProjectId &&
            document._id.toHexString() === requestedTaskId,
        ) ?? null,
      ),
    ),
    listByProject: jest.fn(
      (
        requestedProjectId: string,
        query: { limit: number; afterId?: string },
      ) =>
        Promise.resolve(
          documents
            .filter(
              (document) =>
                document.projectId.toHexString() === requestedProjectId &&
                (!query.afterId ||
                  document._id.toHexString() > query.afterId.toLowerCase()),
            )
            .sort((a, b) =>
              a._id.toHexString().localeCompare(b._id.toHexString()),
            )
            .slice(0, query.limit),
        ),
    ),
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
        requestId: 'request-id-from-verified-test-proof',
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
  documents?: TaskDocument[];
  verifier?: TaskInboundContextVerifier;
  scope?: TaskProjectScopeEvidenceProvider;
  policy?: TaskOperationPermissionPolicy;
  repository?: ReturnType<typeof inMemoryRepository>;
  boundary?: Pick<TaskAuthorizationBoundary, 'authorize'>;
}): Promise<{
  app: INestApplication;
  http: App;
  repository: ReturnType<typeof inMemoryRepository>;
}> {
  const repository =
    options.repository ?? inMemoryRepository(options.documents ?? []);
  const runtimeProviders =
    TaskRuntimeModule.register({
      mongoUri: 'mongodb://127.0.0.1:27017/continuum_task',
      port: 3100,
    }).providers ?? [];
  const builder = Test.createTestingModule({
    controllers: [TaskReadController],
    providers: [
      ...runtimeProviders,
      TaskReadService,
      { provide: TASK_READ_REPOSITORY, useValue: repository },
    ],
  });
  // The runtime providers build TaskDataRepository from a Mongo connection;
  // this suite needs no database, so the in-memory repository replaces it.
  builder.overrideProvider(TaskDataRepository).useValue(repository);
  builder
    .overrideProvider(TASK_RESOURCE_PROJECT_RESOLVER)
    .useValue(new RepositoryTaskResourceProjectResolver(repository));
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
  if (options.boundary) {
    builder
      .overrideProvider(TaskAuthorizationBoundary)
      .useValue(options.boundary);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  // Mirrors main.ts, which installs the request id middleware before routes.
  app.use(requestIdMiddleware);
  await app.init();
  return { app, http: app.getHttpServer() as App, repository };
}

function authorized(test: request.Test): request.Test {
  return test.set('Authorization', `Bearer ${acceptedProof}`);
}

const sevenFields = [
  'createdAt',
  'createdBy',
  'id',
  'projectId',
  'title',
  'updatedAt',
  'version',
];

describe('Task list and detail routes (dormant seven-field slice)', () => {
  jest.setTimeout(20_000);
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    jest.restoreAllMocks();
  });

  describe('list', () => {
    it('returns one page with exactly the seven approved fields, default limit 20 and no-store', async () => {
      const documents = [
        storedTask(1, {
          status: 'CANCELLED',
          assigneeId: new Types.ObjectId(actorUserId),
          completedAt: new Date('2026-10-20T00:00:00.000Z'),
          version: 3,
        }),
        storedTask(2),
      ];
      const test = await createApp({
        documents,
        verifier: acceptingVerifier(),
        scope: resolvedScope,
        policy: allowPolicy,
      });
      app = test.app;

      const response = await authorized(request(test.http).get(base));

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.body as object).sort()).toEqual([
        'items',
        'nextAfterId',
      ]);
      const body = response.body as {
        items: Record<string, unknown>[];
        nextAfterId: string | null;
      };
      expect(body.items.map((item) => item.id)).toEqual([taskId(1), taskId(2)]);
      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual(sevenFields);
      }
      expect(body.items[0]).toEqual({
        id: taskId(1),
        projectId,
        title: 'Task 1',
        createdBy: actorUserId,
        createdAt: '2026-10-19T01:00:00.000Z',
        updatedAt: '2026-10-19T01:00:00.000Z',
        version: 3,
      });
      expect(body.nextAfterId).toBeNull();
      expect(test.repository.listByProject).toHaveBeenCalledWith(projectId, {
        limit: 20,
      });
      expect(JSON.stringify(response.body)).not.toMatch(
        /CANCELLED|assigneeId|completedAt|status/,
      );
    });

    it('sets nextAfterId to the last id only when the page is full, allowing one empty final page', async () => {
      const test = await createApp({
        documents: [storedTask(1), storedTask(2), storedTask(3)],
        verifier: acceptingVerifier(),
        scope: resolvedScope,
        policy: allowPolicy,
      });
      app = test.app;

      const first = await authorized(request(test.http).get(`${base}?limit=2`));
      const firstBody = first.body as {
        items: { id: string }[];
        nextAfterId: string | null;
      };
      expect(firstBody.items.map((item) => item.id)).toEqual([
        taskId(1),
        taskId(2),
      ]);
      expect(firstBody.nextAfterId).toBe(taskId(2));

      const second = await authorized(
        request(test.http).get(`${base}?limit=2&afterId=${taskId(2)}`),
      );
      const secondBody = second.body as {
        items: { id: string }[];
        nextAfterId: string | null;
      };
      expect(secondBody.items.map((item) => item.id)).toEqual([taskId(3)]);
      expect(secondBody.nextAfterId).toBeNull();

      const exactlyFull = await authorized(
        request(test.http).get(`${base}?limit=1&afterId=${taskId(2)}`),
      );
      const exactlyFullBody = exactlyFull.body as {
        items: unknown[];
        nextAfterId: string | null;
      };
      expect(exactlyFullBody.items).toHaveLength(1);
      expect(exactlyFullBody.nextAfterId).toBe(taskId(3));

      const emptyFinal = await authorized(
        request(test.http).get(`${base}?limit=1&afterId=${taskId(3)}`),
      );
      expect(emptyFinal.body).toEqual({ items: [], nextAfterId: null });
    });

    it('ignores unknown query parameters because the slice has no filter, sort, page or total', async () => {
      const test = await createApp({
        documents: [storedTask(1), storedTask(2)],
        verifier: acceptingVerifier(),
        scope: resolvedScope,
        policy: allowPolicy,
      });
      app = test.app;

      const response = await authorized(
        request(test.http).get(`${base}?status=DONE&sort=-createdAt&page=2`),
      );

      expect(response.status).toBe(200);
      expect(test.repository.listByProject).toHaveBeenCalledWith(projectId, {
        limit: 20,
      });
    });

    it.each([
      'limit=0',
      'limit=101',
      'limit=abc',
      'limit=1.5',
      'limit=',
      'afterId=xyz',
      `afterId=${'g'.repeat(24)}`,
      `afterId=${taskId(1)}0`,
    ])(
      'returns 422 TASK_VALIDATION_FAILED for %s only after authorization succeeds',
      async (query) => {
        const test = await createApp({
          documents: [storedTask(1)],
          verifier: acceptingVerifier(),
          scope: resolvedScope,
          policy: allowPolicy,
        });
        app = test.app;

        const response = await authorized(
          request(test.http).get(`${base}?${query}`),
        );

        expect(response.status).toBe(422);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['www-authenticate']).toBeUndefined();
        const body = response.body as {
          code: string;
          details: { messages: string[] };
        };
        expect(body.code).toBe('TASK_VALIDATION_FAILED');
        expect(Array.isArray(body.details.messages)).toBe(true);
        expect(test.repository.listByProject).not.toHaveBeenCalled();
      },
    );

    it('answers 401 and never validates the query for an unauthenticated caller', async () => {
      const test = await createApp({
        verifier: acceptingVerifier(),
        scope: resolvedScope,
        policy: allowPolicy,
      });
      app = test.app;

      const response = await request(test.http).get(`${base}?limit=0`);

      expect(response.status).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(response.headers['cache-control']).toBe('no-store');
      expect((response.body as { code: string }).code).toBe(
        'TASK_UNAUTHENTICATED',
      );
    });

    it('answers a generic 500 without leaking the failure when the repository fails after authorization', async () => {
      const repository = inMemoryRepository([storedTask(1)]);
      repository.listByProject.mockRejectedValue(new Error('db-secret-canary'));
      const test = await createApp({
        repository,
        verifier: acceptingVerifier(),
        scope: resolvedScope,
        policy: allowPolicy,
      });
      app = test.app;

      const response = await authorized(
        request(test.http).get(base).set('x-request-id', 'req-from-test'),
      );

      expect(response.status).toBe(500);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['www-authenticate']).toBeUndefined();
      expect(response.body).toEqual({
        code: 'HTTP_500',
        message: 'Internal server error',
        details: {},
        requestId: 'req-from-test',
      });
      expect(JSON.stringify(response.body)).not.toContain('db-secret-canary');
    });
  });

  describe('detail', () => {
    it('returns the Task with exactly the seven approved fields and no-store', async () => {
      const test = await createApp({
        documents: [storedTask(1, { status: 'DONE', version: 2 })],
        verifier: acceptingVerifier(),
        scope: resolvedScope,
        policy: allowPolicy,
      });
      app = test.app;

      const response = await authorized(
        request(test.http).get(`${base}/${taskId(1)}`),
      );

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.body as object).sort()).toEqual(sevenFields);
      expect((response.body as { version: number }).version).toBe(2);
      expect(test.repository.getById).toHaveBeenCalledWith(
        projectId,
        taskId(1),
      );
    });

    it('answers 404 TASK_NOT_FOUND for a Task of another Project without evaluating the policy', async () => {
      const foreign = storedTask(1, {
        projectId: new Types.ObjectId(otherProjectId),
      });
      const policy = { decide: jest.fn(() => 'ALLOW' as const) };
      const test = await createApp({
        documents: [foreign],
        verifier: acceptingVerifier(),
        scope: resolvedScope,
        policy,
      });
      app = test.app;

      const response = await authorized(
        request(test.http).get(`${base}/${taskId(1)}`),
      );

      expect(response.status).toBe(404);
      expect(response.headers['cache-control']).toBe('no-store');
      expect((response.body as { code: string }).code).toBe('TASK_NOT_FOUND');
      expect(policy.decide).not.toHaveBeenCalled();
    });

    it.each([
      ['malformed taskId', `${base}/not-an-id`],
      ['unknown taskId', `${base}/${taskId(99)}`],
      [
        'malformed projectId',
        `/tasks/projects/not-a-project/tasks/${taskId(1)}`,
      ],
    ])('answers 404 for a %s', async (_label, path) => {
      const test = await createApp({
        documents: [storedTask(1)],
        verifier: acceptingVerifier(),
        scope: resolvedScope,
        policy: allowPolicy,
      });
      app = test.app;

      const response = await authorized(request(test.http).get(path));

      expect(response.status).toBe(404);
      expect((response.body as { code: string }).code).toBe('TASK_NOT_FOUND');
    });

    it('answers 404 for a malformed projectId on the list route as well', async () => {
      const test = await createApp({
        documents: [storedTask(1)],
        verifier: acceptingVerifier(),
        scope: resolvedScope,
        policy: allowPolicy,
      });
      app = test.app;

      const response = await authorized(
        request(test.http).get('/tasks/projects/not-a-project/tasks'),
      );

      expect(response.status).toBe(404);
    });

    it('answers 503 when the persistence lookup for the Task fails', async () => {
      const repository = inMemoryRepository([storedTask(1)]);
      repository.getById.mockRejectedValue(new Error('db-secret-canary'));
      const test = await createApp({
        repository,
        verifier: acceptingVerifier(),
        scope: resolvedScope,
        policy: allowPolicy,
      });
      app = test.app;

      const response = await authorized(
        request(test.http).get(`${base}/${taskId(1)}`),
      );

      expect(response.status).toBe(503);
      expect(response.headers['cache-control']).toBe('no-store');
      expect((response.body as { code: string }).code).toBe(
        'TASK_AUTHORIZATION_UNAVAILABLE',
      );
      expect(JSON.stringify(response.body)).not.toContain('db-secret-canary');
    });
  });

  describe('authorization outcomes follow ERR-1 and never answer 403', () => {
    const scenarios: [
      string,
      number,
      string,
      () => Parameters<typeof createApp>[0],
      boolean,
    ][] = [
      [
        'a verifier rejection',
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
        'an unsupported token profile (credential rejected)',
        401,
        'TASK_UNAUTHENTICATED',
        () => ({
          verifier: {
            verify: () => {
              throw new TaskInboundContextVerificationError(
                'UNSUPPORTED_PROFILE',
              );
            },
          },
          scope: resolvedScope,
          policy: allowPolicy,
        }),
        true,
      ],
      [
        'a verifier that is unavailable',
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
        'a verifier whose key resolution fails',
        503,
        'TASK_AUTHORIZATION_UNAVAILABLE',
        () => ({
          verifier: {
            verify: () => {
              throw new TaskInboundContextVerificationError(
                'KEY_RESOLUTION_FAILED',
              );
            },
          },
          scope: resolvedScope,
          policy: allowPolicy,
        }),
        true,
      ],
      [
        'a verifier that raises an unexpected error',
        503,
        'TASK_AUTHORIZATION_UNAVAILABLE',
        () => ({
          verifier: {
            verify: () => {
              throw new Error('verifier-secret-canary');
            },
          },
          scope: resolvedScope,
          policy: allowPolicy,
        }),
        true,
      ],
      [
        'a verifier that returns a malformed context',
        503,
        'TASK_AUTHORIZATION_UNAVAILABLE',
        () => ({
          verifier: { verify: () => ({ unexpected: true }) as never },
          scope: resolvedScope,
          policy: allowPolicy,
        }),
        true,
      ],
      [
        'a missing Authorization header',
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
        'a verified context bound to another Project',
        404,
        'TASK_NOT_FOUND',
        () => ({
          verifier: {
            verify: () => ({
              actorUserId,
              gatewayServiceId: 'gateway-test-fixture',
              projectId: otherProjectId,
              requestId: 'request-id-from-verified-test-proof',
            }),
          },
          scope: resolvedScope,
          policy: allowPolicy,
        }),
        true,
      ],
      [
        'denied Project scope (non-member)',
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
      [
        'unavailable scope evidence',
        503,
        'TASK_AUTHORIZATION_UNAVAILABLE',
        () => ({
          verifier: acceptingVerifier(),
          scope: { resolve: () => ({ kind: 'unavailable' as const }) },
          policy: allowPolicy,
        }),
        true,
      ],
      [
        'a failing permission policy',
        503,
        'TASK_AUTHORIZATION_UNAVAILABLE',
        () => ({
          verifier: acceptingVerifier(),
          scope: resolvedScope,
          policy: {
            decide: () => {
              throw new Error('policy-secret-canary');
            },
          },
        }),
        true,
      ],
    ];

    it.each(scenarios)(
      '%s -> %i %s on list and detail, with the existing error shape',
      async (_label, status, code, options, withProof) => {
        const test = await createApp({
          documents: [storedTask(1)],
          ...options(),
        });
        app = test.app;

        for (const path of [base, `${base}/${taskId(1)}`]) {
          let call = request(test.http)
            .get(path)
            .set('x-request-id', 'req-from-test');
          if (withProof) call = authorized(call);
          const response = await call;

          expect(response.status).toBe(status);
          expect(response.headers['cache-control']).toBe('no-store');
          if (status === 401) {
            expect(response.headers['www-authenticate']).toBe('Bearer');
          } else {
            expect(response.headers['www-authenticate']).toBeUndefined();
          }
          expect(response.body).toEqual({
            code,
            message: expect.any(String) as string,
            details: {},
            requestId: 'req-from-test',
          });
          expect(JSON.stringify(response.body)).not.toMatch(
            /canary|Bearer|test-only-opaque-proof/,
          );
        }
        expect(test.repository.listByProject).not.toHaveBeenCalled();
      },
    );
  });

  describe('a malformed internal authorization request is a server fault (ERR-2)', () => {
    it('answers a generic 500 on list and detail, logs the reason internally and never echoes it', async () => {
      const errorLog = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const test = await createApp({
        documents: [storedTask(1)],
        boundary: {
          authorize: () =>
            Promise.resolve({
              kind: 'denied' as const,
              reason: 'INVALID_REQUEST' as const,
            }),
        },
      });
      app = test.app;

      for (const path of [base, `${base}/${taskId(1)}`]) {
        const response = await authorized(
          request(test.http).get(path).set('x-request-id', 'req-from-test'),
        );

        expect(response.status).toBe(500);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['www-authenticate']).toBeUndefined();
        expect(response.body).toEqual({
          code: 'HTTP_500',
          message: 'Internal server error',
          details: {},
          requestId: 'req-from-test',
        });
        expect(JSON.stringify(response.body)).not.toContain('INVALID_REQUEST');
      }
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('INVALID_REQUEST'),
      );
      expect(test.repository.listByProject).not.toHaveBeenCalled();
      expect(test.repository.getById).not.toHaveBeenCalled();
    });
  });

  describe('dormant defaults stay deny-by-default', () => {
    it('stays unavailable (503, not 401) with the default unconfigured verifier', async () => {
      const test = await createApp({});
      app = test.app;

      const response = await authorized(request(test.http).get(base));

      expect(response.status).toBe(503);
      expect(response.headers['www-authenticate']).toBeUndefined();
      expect(test.repository.listByProject).not.toHaveBeenCalled();
    });

    it('stays unavailable (503) with a verifier but the default scope evidence', async () => {
      const test = await createApp({ verifier: acceptingVerifier() });
      app = test.app;

      const response = await authorized(request(test.http).get(base));

      expect(response.status).toBe(503);
      expect(test.repository.listByProject).not.toHaveBeenCalled();
    });

    it('denies (404) with verifier and scope but the default DenyAll policy', async () => {
      const test = await createApp({
        documents: [storedTask(1)],
        verifier: acceptingVerifier(),
        scope: resolvedScope,
      });
      app = test.app;

      const list = await authorized(request(test.http).get(base));
      const detail = await authorized(
        request(test.http).get(`${base}/${taskId(1)}`),
      );

      expect(list.status).toBe(404);
      expect(detail.status).toBe(404);
      expect(test.repository.listByProject).not.toHaveBeenCalled();
    });
  });
});
