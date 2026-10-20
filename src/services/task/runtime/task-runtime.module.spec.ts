import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { TASK_DATABASE_NAME } from '../infrastructure/mongodb/task-contract';
import {
  TaskRuntimeModule,
  TASK_RUNTIME_MONGOOSE_OPTIONS,
} from './task-runtime.module';
import {
  TASK_INBOUND_CONTEXT_VERIFIER,
  TaskInboundContextTrustBoundary,
  UnconfiguredTaskInboundContextVerifier,
} from './task-inbound-context';
import {
  DenyAllTaskOperationPermissionPolicy,
  TASK_OPERATION_PERMISSION_POLICY,
  TASK_PROJECT_SCOPE_EVIDENCE_PROVIDER,
  TASK_RESOURCE_PROJECT_RESOLVER,
  UnconfiguredTaskProjectScopeEvidenceProvider,
  UnconfiguredTaskResourceProjectResolver,
} from './task-authorization-boundary';
import { TaskAuthorizationHttpGuard } from './task-authorization-http.guard';
import { TaskHealthController } from './task-health.controller';
import { TaskLifecycleCommandService } from './task-lifecycle-command';
import {
  TASK_HISTORY_ACCESS_EVIDENCE_PROVIDER,
  TaskHistoryAccessAuthorizationBoundary,
  TaskHistoryQueryService,
  UnconfiguredTaskHistoryAccessEvidenceProvider,
} from './task-history-query';
import { TaskCreateController } from '../http/task-create.controller';
import { TaskCreateService } from '../http/task-create.service';
import { TaskReadController } from '../http/task-read.controller';
import {
  TASK_READ_REPOSITORY,
  TaskReadService,
} from '../http/task-read.service';
import { RepositoryTaskResourceProjectResolver } from './task-repository-resource-project.resolver';
import { TaskDataRepository } from '../infrastructure/mongodb/task-data.repository';

describe('TaskRuntimeModule MongoDB options', () => {
  it('selects only continuum_task and disables automatic schema creation', () => {
    expect(TASK_RUNTIME_MONGOOSE_OPTIONS).toMatchObject({
      dbName: TASK_DATABASE_NAME,
      autoCreate: false,
      autoIndex: false,
      serverSelectionTimeoutMS: 30_000,
      retryAttempts: 1,
      retryDelay: 0,
    });
  });

  it('exposes an injectable trust boundary with a deny-by-default verifier', () => {
    const runtimeModule = TaskRuntimeModule.register({
      mongoUri: 'mongodb://127.0.0.1:27017/continuum_task',
      port: 3100,
    });

    expect(Reflect.getMetadata('controllers', TaskRuntimeModule)).toEqual([
      TaskHealthController,
    ]);

    expect(runtimeModule.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provide: TaskLifecycleCommandService }),
        expect.objectContaining({ provide: TaskHistoryQueryService }),
        TaskInboundContextTrustBoundary,
        TaskAuthorizationHttpGuard,
        TaskHistoryAccessAuthorizationBoundary,
        {
          provide: TASK_INBOUND_CONTEXT_VERIFIER,
          useClass: UnconfiguredTaskInboundContextVerifier,
        },
        {
          provide: TASK_HISTORY_ACCESS_EVIDENCE_PROVIDER,
          useClass: UnconfiguredTaskHistoryAccessEvidenceProvider,
        },
      ]),
    );
    expect(runtimeModule.exports).toContain(TaskHistoryQueryService);
    expect(runtimeModule.exports).toContain(TaskInboundContextTrustBoundary);
    expect(runtimeModule.exports).toContain(TaskAuthorizationHttpGuard);
    expect(runtimeModule.providers).toContainEqual({
      provide: TASK_RESOURCE_PROJECT_RESOLVER,
      useClass: UnconfiguredTaskResourceProjectResolver,
    });
  });

  it('uses the default Nest DI verifier and rejects caller identity headers', async () => {
    const dynamicModule = TaskRuntimeModule.register({
      mongoUri: 'mongodb://127.0.0.1:27017/continuum_task',
      port: 3100,
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        {
          provide: getConnectionToken(),
          useValue: { db: { databaseName: TASK_DATABASE_NAME } },
        },
        ...(dynamicModule.providers ?? []),
      ],
    }).compile();
    const boundary = moduleRef.get(TaskInboundContextTrustBoundary);

    await expect(
      boundary.verify(
        {
          'x-actor-user-id': '0123456789abcdef01234567',
          'x-project-id': 'abcdef0123456789abcdef01',
        },
        { method: 'GET', target: '/internal/tasks' },
      ),
    ).resolves.toEqual({
      kind: 'rejected',
      reason: 'VERIFIER_UNAVAILABLE',
    });
    await moduleRef.close();
  });

  it('fails Nest DI compilation when the verifier provider is absent', async () => {
    await expect(
      Test.createTestingModule({
        providers: [TaskInboundContextTrustBoundary],
      }).compile(),
    ).rejects.toThrow();
  });
});

describe('TaskRuntimeModule Task routes flag', () => {
  const disabled = {
    mongoUri: 'mongodb://127.0.0.1:27017/continuum_task',
    port: 3100,
  };

  it('registers no Task route controller unless routes are explicitly enabled', () => {
    for (const config of [
      disabled,
      { ...disabled, routesEnabled: false as const },
    ]) {
      const runtimeModule = TaskRuntimeModule.register(config);
      expect(runtimeModule.controllers ?? []).toEqual([]);
      expect(runtimeModule.providers).not.toContain(TaskReadService);
      expect(runtimeModule.providers).toContainEqual({
        provide: TASK_RESOURCE_PROJECT_RESOLVER,
        useClass: UnconfiguredTaskResourceProjectResolver,
      });
    }
  });

  it('registers the create controller only when both the routes flag and the create flag are on', () => {
    const cases: [Record<string, boolean>, unknown[]][] = [
      [{}, []],
      [{ routesEnabled: true }, [TaskReadController]],
      [{ createRouteEnabled: true }, []],
      [
        { routesEnabled: true, createRouteEnabled: true },
        [TaskReadController, TaskCreateController],
      ],
    ];
    for (const [flags, controllers] of cases) {
      const runtimeModule = TaskRuntimeModule.register({
        ...disabled,
        ...flags,
      });
      expect(runtimeModule.controllers ?? []).toEqual(controllers);
      expect((runtimeModule.providers ?? []).includes(TaskCreateService)).toBe(
        controllers.includes(TaskCreateController),
      );
    }
  });

  it('adds only the list and detail controller and the repository-backed resolver when enabled, keeping every default deny provider', () => {
    const runtimeModule = TaskRuntimeModule.register({
      ...disabled,
      routesEnabled: true,
    });

    expect(runtimeModule.controllers).toEqual([TaskReadController]);
    expect(runtimeModule.providers).toContain(TaskReadService);
    expect(runtimeModule.providers).toContainEqual(
      expect.objectContaining({ provide: TASK_READ_REPOSITORY }),
    );
    expect(runtimeModule.providers).toContainEqual({
      provide: TASK_RESOURCE_PROJECT_RESOLVER,
      useClass: RepositoryTaskResourceProjectResolver,
    });
    expect(runtimeModule.providers).toEqual(
      expect.arrayContaining([
        {
          provide: TASK_INBOUND_CONTEXT_VERIFIER,
          useClass: UnconfiguredTaskInboundContextVerifier,
        },
        {
          provide: TASK_PROJECT_SCOPE_EVIDENCE_PROVIDER,
          useClass: UnconfiguredTaskProjectScopeEvidenceProvider,
        },
        {
          provide: TASK_OPERATION_PERMISSION_POLICY,
          useClass: DenyAllTaskOperationPermissionPolicy,
        },
      ]),
    );
  });

  it('builds the read repository from the Task database connection and wires the resolver through Nest DI', async () => {
    const runtimeModule = TaskRuntimeModule.register({
      ...disabled,
      routesEnabled: true,
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        ...(runtimeModule.providers ?? []),
        {
          provide: getConnectionToken(),
          useValue: { db: { databaseName: TASK_DATABASE_NAME } },
        },
      ],
    }).compile();

    expect(moduleRef.get(TASK_READ_REPOSITORY)).toBeInstanceOf(
      TaskDataRepository,
    );
    // The read service reuses the single repository the runtime already builds.
    expect(moduleRef.get(TASK_READ_REPOSITORY)).toBe(
      moduleRef.get(TaskDataRepository),
    );
    expect(moduleRef.get(TaskReadService)).toBeInstanceOf(TaskReadService);
    expect(moduleRef.get(TASK_RESOURCE_PROJECT_RESOLVER)).toBeInstanceOf(
      RepositoryTaskResourceProjectResolver,
    );
    await moduleRef.close();
  });

  it('refuses to build the read repository without a connected database', async () => {
    const runtimeModule = TaskRuntimeModule.register({
      ...disabled,
      routesEnabled: true,
    });
    await expect(
      Test.createTestingModule({
        providers: [
          ...(runtimeModule.providers ?? []),
          { provide: getConnectionToken(), useValue: {} },
        ],
      }).compile(),
    ).rejects.toThrow('Task MongoDB connection is unavailable');
  });
});
