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
    return {
      module: TaskRuntimeModule,
      imports: [
        MongooseModule.forRoot(config.mongoUri, {
          ...TASK_RUNTIME_MONGOOSE_OPTIONS,
        }),
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
        TaskInboundContextTrustBoundary,
        TaskAuthorizationBoundary,
        TaskAuthorizationHttpGuard,
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
          useClass: UnconfiguredTaskResourceProjectResolver,
        },
      ],
      exports: [
        TaskLifecycleCommandService,
        TaskInboundContextTrustBoundary,
        TaskAuthorizationBoundary,
        TaskAuthorizationHttpGuard,
      ],
    };
  }
}
