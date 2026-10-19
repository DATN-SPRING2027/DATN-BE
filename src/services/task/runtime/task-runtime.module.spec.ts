import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
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
  TASK_RESOURCE_PROJECT_RESOLVER,
  UnconfiguredTaskResourceProjectResolver,
} from './task-authorization-boundary';
import { TaskAuthorizationHttpGuard } from './task-authorization-http.guard';
import { TaskHealthController } from './task-health.controller';
import { TaskLifecycleCommandService } from './task-lifecycle-command';

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
        TaskInboundContextTrustBoundary,
        TaskAuthorizationHttpGuard,
        {
          provide: TASK_INBOUND_CONTEXT_VERIFIER,
          useClass: UnconfiguredTaskInboundContextVerifier,
        },
      ]),
    );
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
