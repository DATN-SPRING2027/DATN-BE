import { Types } from 'mongoose';
import type { TaskDocument } from '../infrastructure/mongodb/task-contract';
import { RepositoryTaskResourceProjectResolver } from './task-repository-resource-project.resolver';

const projectId = 'abcdef0123456789abcdef01';
const taskId = '650000000000000000000001';

function storedTask(): TaskDocument {
  return {
    _id: new Types.ObjectId(taskId),
    projectId: new Types.ObjectId(projectId),
    title: 'Task',
    createdBy: new Types.ObjectId('0123456789abcdef01234567'),
    createdAt: new Date('2026-10-19T00:00:00.000Z'),
    updatedAt: new Date('2026-10-19T00:00:00.000Z'),
    status: 'TODO',
    assigneeId: null,
    completedAt: null,
    version: 1,
  };
}

describe('RepositoryTaskResourceProjectResolver', () => {
  it('resolves the owning Project of a Task by looking it up scoped to the requested Project', async () => {
    const repository = {
      getById: jest.fn().mockResolvedValue(storedTask()),
      listByProject: jest.fn(),
    };
    const resolver = new RepositoryTaskResourceProjectResolver(repository);

    await expect(
      resolver.resolveProjectId({
        resourceId: taskId,
        requestedProjectId: projectId,
      }),
    ).resolves.toBe(projectId);
    expect(repository.getById).toHaveBeenCalledWith(projectId, taskId);
    expect(repository.listByProject).not.toHaveBeenCalled();
  });

  it('returns undefined for a Task that does not exist in that Project', async () => {
    const repository = {
      getById: jest.fn().mockResolvedValue(null),
      listByProject: jest.fn(),
    };
    const resolver = new RepositoryTaskResourceProjectResolver(repository);

    await expect(
      resolver.resolveProjectId({
        resourceId: taskId,
        requestedProjectId: projectId,
      }),
    ).resolves.toBeUndefined();
  });

  it('does not swallow persistence failures, so the boundary can report them as unavailable', async () => {
    const failure = new Error('connection reset');
    const repository = {
      getById: jest.fn().mockRejectedValue(failure),
      listByProject: jest.fn(),
    };
    const resolver = new RepositoryTaskResourceProjectResolver(repository);

    await expect(
      resolver.resolveProjectId({
        resourceId: taskId,
        requestedProjectId: projectId,
      }),
    ).rejects.toBe(failure);
  });
});
