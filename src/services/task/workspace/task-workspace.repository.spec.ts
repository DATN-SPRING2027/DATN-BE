import { Types, type Connection } from 'mongoose';
import {
  WORKSPACE_TASKS_COLLECTION,
  type WorkspaceTaskDocument,
} from './task-workspace.types';
import { TaskWorkspaceRepository } from './task-workspace.repository';

describe('TaskWorkspaceRepository', () => {
  it('removes response-only subtask counts before updating a legacy task document', async () => {
    const taskId = new Types.ObjectId().toHexString();
    const organizationId = new Types.ObjectId().toHexString();
    const projectId = new Types.ObjectId().toHexString();
    const actorId = new Types.ObjectId().toHexString();
    const session = {
      endSession: jest.fn().mockResolvedValue(undefined),
      withTransaction: jest.fn(),
    };
    session.withTransaction.mockImplementation(
      async (work: (activeSession: unknown) => Promise<unknown>) =>
        work(session),
    );

    const updatedTask = {
      _id: new Types.ObjectId(taskId),
      parentId: null,
      version: 2,
    } as WorkspaceTaskDocument;
    const tasks = {
      findOneAndUpdate: jest.fn().mockResolvedValue(updatedTask),
    };
    const events = { insertOne: jest.fn().mockResolvedValue({}) };
    const db = {
      client: { startSession: jest.fn(() => session) },
      collection: jest.fn((name: string) =>
        name === WORKSPACE_TASKS_COLLECTION ? tasks : events,
      ),
    };
    const connection = {
      useDb: jest.fn(() => ({ db })),
    } as unknown as Connection;
    const repository = new TaskWorkspaceRepository(connection);

    await repository.updateTaskFields({
      organizationId,
      projectId,
      taskId,
      actorId,
      expectedVersion: 1,
      correlationId: 'correlation-1',
      updates: { assigneeId: new Types.ObjectId() },
      changedFields: ['assigneeId'],
    });

    expect(tasks.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: new Types.ObjectId(taskId),
        projectId: new Types.ObjectId(projectId),
        version: 1,
      },
      expect.objectContaining({ $unset: { subtaskCounts: '' } }),
      expect.objectContaining({ returnDocument: 'after', session }),
    );
    expect(events.insertOne).toHaveBeenCalledTimes(1);
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });
});
