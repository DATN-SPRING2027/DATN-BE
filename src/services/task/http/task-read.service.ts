import { Inject, Injectable } from '@nestjs/common';
import type { TaskDataRepository } from '../infrastructure/mongodb/task-data.repository';
import { taskNotFoundException } from '../runtime/task-authorization-http.errors';
import {
  toTaskResponse,
  type TaskPageResponse,
  type TaskResponse,
} from './task-response';

export const TASK_READ_REPOSITORY = Symbol('TASK_READ_REPOSITORY');

/** Read-only view of the existing repository; no schema or index change. */
export type TaskReadRepository = Pick<
  TaskDataRepository,
  'getById' | 'listByProject'
>;

/** LIMIT-1: the approved default page size. DR-6 fixes the 1-100 range. */
export const DEFAULT_TASK_PAGE_LIMIT = 20;

@Injectable()
export class TaskReadService {
  constructor(
    @Inject(TASK_READ_REPOSITORY)
    private readonly repository: TaskReadRepository,
  ) {}

  async list(
    projectId: string,
    query: { limit?: number; afterId?: string },
  ): Promise<TaskPageResponse> {
    const limit = query.limit ?? DEFAULT_TASK_PAGE_LIMIT;
    const documents = await this.repository.listByProject(projectId, {
      limit,
      ...(query.afterId ? { afterId: query.afterId } : {}),
    });
    const items = documents.map(toTaskResponse);
    // CURSOR-1: the id of the last item when the page is full, otherwise null.
    return {
      items,
      nextAfterId: items.length === limit ? items[items.length - 1].id : null,
    };
  }

  async detail(projectId: string, taskId: string): Promise<TaskResponse> {
    const document = await this.repository.getById(projectId, taskId);
    if (!document) throw taskNotFoundException();
    return toTaskResponse(document);
  }
}
