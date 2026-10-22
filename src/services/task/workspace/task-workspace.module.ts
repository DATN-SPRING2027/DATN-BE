import { Module } from '@nestjs/common';
import { IamModule } from '../../iam/iam.module';
import { TaskWorkspaceController } from './task-workspace.controller';
import {
  TASK_WORKSPACE_IAM_BRIDGE,
  TaskWorkspaceIamBridge,
} from './task-workspace-iam.bridge';
import {
  TASK_WORKSPACE_REPOSITORY,
  TaskWorkspaceRepository,
} from './task-workspace.repository';
import { TaskWorkspaceService } from './task-workspace.service';

@Module({
  imports: [IamModule],
  controllers: [TaskWorkspaceController],
  providers: [
    TaskWorkspaceRepository,
    {
      provide: TASK_WORKSPACE_REPOSITORY,
      useExisting: TaskWorkspaceRepository,
    },
    TaskWorkspaceIamBridge,
    {
      provide: TASK_WORKSPACE_IAM_BRIDGE,
      useExisting: TaskWorkspaceIamBridge,
    },
    TaskWorkspaceService,
  ],
  exports: [TaskWorkspaceService, TaskWorkspaceRepository],
})
export class TaskWorkspaceModule {}
