import { Inject, Injectable } from '@nestjs/common';
import {
  TASK_READ_REPOSITORY,
  type TaskReadRepository,
} from '../http/task-read.service';
import type { TaskResourceProjectResolver } from './task-authorization-boundary';

/**
 * Resolves a Task's persisted owning Project, scoped by the requested Project.
 * It does not grant access and does not replace scope evidence or the
 * permission policy; a persistence failure is rethrown so the boundary can
 * report it as unavailable instead of as a missing Task.
 */
@Injectable()
export class RepositoryTaskResourceProjectResolver implements TaskResourceProjectResolver {
  constructor(
    @Inject(TASK_READ_REPOSITORY)
    private readonly repository: TaskReadRepository,
  ) {}

  readonly resolveProjectId = async (input: {
    resourceId: string;
    requestedProjectId: string;
  }): Promise<string | undefined> => {
    const task = await this.repository.getById(
      input.requestedProjectId,
      input.resourceId,
    );
    return task ? task.projectId.toHexString() : undefined;
  };
}
