import { DynamicModule, Module } from '@nestjs/common';
import { MongooseModule, MongooseModuleOptions } from '@nestjs/mongoose';
import { TASK_DATABASE_NAME } from '../infrastructure/mongodb/task-contract';
import { TaskRuntimeConfig } from './task-runtime.config';
import { TaskHealthController } from './task-health.controller';
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
        TaskInboundContextTrustBoundary,
        TaskAuthorizationBoundary,
        TaskAuthorizationHttpGuard,
      ],
    };
  }
}
