import { DynamicModule, Module } from '@nestjs/common';
import {
  getConnectionToken,
  MongooseModule,
  MongooseModuleOptions,
} from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { TASK_DATABASE_NAME } from '../infrastructure/mongodb/task-contract';
import { TaskDataRepository } from '../infrastructure/mongodb/task-data.repository';
import { TaskRuntimeConfig } from './task-runtime.config';
import { TaskHealthController } from './task-health.controller';
import { TaskLifecycleCommandService } from './task-lifecycle-command';
import {
  TASK_HISTORY_ACCESS_EVIDENCE_PROVIDER,
  TaskHistoryAccessAuthorizationBoundary,
  TaskHistoryQueryService,
  UnconfiguredTaskHistoryAccessEvidenceProvider,
} from './task-history-query';
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
  TaskAuthorizationBoundary,
  UnconfiguredTaskProjectScopeEvidenceProvider,
  UnconfiguredTaskResourceProjectResolver,
} from './task-authorization-boundary';
import { TaskAuthorizationHttpGuard } from './task-authorization-http.guard';
import { TaskCreateController } from '../http/task-create.controller';
import {
  TASK_CREATE_REPOSITORY,
  TaskCreateService,
} from '../http/task-create.service';
import { TaskReadController } from '../http/task-read.controller';
import {
  TASK_READ_REPOSITORY,
  TaskReadService,
} from '../http/task-read.service';
import { RepositoryTaskResourceProjectResolver } from './task-repository-resource-project.resolver';

export const TASK_RUNTIME_MONGOOSE_OPTIONS: MongooseModuleOptions = {
  dbName: TASK_DATABASE_NAME,
  autoCreate: false,
  autoIndex: false,
  serverSelectionTimeoutMS: 30_000,
  retryAttempts: 1,
  retryDelay: 0,
};

@Module({
  controllers: [TaskHealthController],
})
export class TaskRuntimeModule {
  static register(config: TaskRuntimeConfig): DynamicModule {
    // Routes stay off unless TASK_ROUTES_ENABLED is exactly true. Enabling them
    // adds only the list and detail controller and a resolver that reads the
    // persisted owning Project; the verifier, scope evidence and policy
    // defaults below stay deny-by-default either way.
    const routesEnabled = config.routesEnabled === true;
    // Create needs its own explicit flag on top of the routes flag.
    const createRouteEnabled =
      routesEnabled && config.createRouteEnabled === true;
    return {
      module: TaskRuntimeModule,
      imports: [
        MongooseModule.forRoot(config.mongoUri, {
          ...TASK_RUNTIME_MONGOOSE_OPTIONS,
        }),
      ],
      controllers: [
        ...(routesEnabled ? [TaskReadController] : []),
        ...(createRouteEnabled ? [TaskCreateController] : []),
      ],
      providers: [
        {
          provide: TaskDataRepository,
          useFactory: (connection: Connection) => {
            if (!connection.db)
              throw new Error('Task MongoDB connection is unavailable');
            return new TaskDataRepository(connection.db);
          },
          inject: [getConnectionToken()],
        },
        {
          provide: TaskLifecycleCommandService,
          useFactory: (repository: TaskDataRepository) =>
            new TaskLifecycleCommandService(repository),
          inject: [TaskDataRepository],
        },
        {
          provide: TaskHistoryQueryService,
          useFactory: (
            authorizationBoundary: TaskAuthorizationBoundary,
            historyAccessBoundary: TaskHistoryAccessAuthorizationBoundary,
            repository: TaskDataRepository,
          ) =>
            new TaskHistoryQueryService(
              authorizationBoundary,
              historyAccessBoundary,
              repository,
            ),
          inject: [
            TaskAuthorizationBoundary,
            TaskHistoryAccessAuthorizationBoundary,
            TaskDataRepository,
          ],
        },
        TaskInboundContextTrustBoundary,
        TaskAuthorizationBoundary,
        TaskAuthorizationHttpGuard,
        TaskHistoryAccessAuthorizationBoundary,
        {
          provide: TASK_HISTORY_ACCESS_EVIDENCE_PROVIDER,
          useClass: UnconfiguredTaskHistoryAccessEvidenceProvider,
        },
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
        {
          provide: TASK_RESOURCE_PROJECT_RESOLVER,
          useClass: routesEnabled
            ? RepositoryTaskResourceProjectResolver
            : UnconfiguredTaskResourceProjectResolver,
        },
        // The read service reuses the single TaskDataRepository above.
        ...(routesEnabled
          ? [
              {
                provide: TASK_READ_REPOSITORY,
                useExisting: TaskDataRepository,
              },
              TaskReadService,
            ]
          : []),
        ...(createRouteEnabled
          ? [
              {
                provide: TASK_CREATE_REPOSITORY,
                useExisting: TaskDataRepository,
              },
              TaskCreateService,
            ]
          : []),
      ],
      exports: [
        TaskLifecycleCommandService,
        TaskHistoryQueryService,
        TaskHistoryAccessAuthorizationBoundary,
        TaskInboundContextTrustBoundary,
        TaskAuthorizationBoundary,
        TaskAuthorizationHttpGuard,
      ],
    };
  }
}
