import type { TaskDocument } from '../infrastructure/mongodb/task-contract';

/**
 * The approved DR-1 seven-field Task. The stored document also carries
 * `status`, `assigneeId` and `completedAt` since the lifecycle database
 * contract (PR #58); none of them is part of this slice, so the response is
 * built field by field and never spreads the document.
 */
export interface TaskResponse {
  id: string;
  projectId: string;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface TaskPageResponse {
  items: TaskResponse[];
  nextAfterId: string | null;
}

export function toTaskResponse(task: TaskDocument): TaskResponse {
  return {
    id: task._id.toHexString(),
    projectId: task.projectId.toHexString(),
    title: task.title,
    createdBy: task.createdBy.toHexString(),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    version: Number(task.version),
  };
}
