import { Types, type Connection } from 'mongoose';
import {
  WORKSPACE_TASKS_COLLECTION,
  type WorkspaceTaskDocument,
} from './task-workspace.types';
import { TaskWorkspaceRepository } from './task-workspace.repository';

describe('TaskWorkspaceRepository', () => {
  it('loads deadline candidates through the Task repository with stable bounded pagination', async () => {
    const dueDate = new Date('2026-10-24T10:00:00.000Z');
    const cursorId = new Types.ObjectId();
    const expectedTasks = [
      {
        _id: new Types.ObjectId(),
        projectId: new Types.ObjectId(),
        organizationId: new Types.ObjectId(),
        title: 'Task',
        status: 'IN_PROGRESS',
        assigneeId: new Types.ObjectId(),
        dueDate,
      },
    ];
    const cursor = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue(expectedTasks),
    };
    const find = jest.fn((...args: [Record<string, unknown>, unknown]) => {
      void args;
      return cursor;
    });
    const tasks = { find };
    const db = { collection: jest.fn(() => tasks) };
    const repository = new TaskWorkspaceRepository({
      useDb: jest.fn(() => ({ db })),
    } as unknown as Connection);

    await expect(
      repository.listTasksForDeadlineNotifications({
        through: dueDate,
        after: { dueDate, id: cursorId },
        limit: 200,
      }),
    ).resolves.toEqual(expectedTasks);

    const filter = tasks.find.mock.calls[0]?.[0];
    expect(filter).toEqual(
      expect.objectContaining({
        dueDate: { $ne: null, $lte: dueDate },
        assigneeId: { $ne: null },
        status: { $nin: ['DONE', 'CANCELLED'] },
      }),
    );
    expect(filter?.$and).toEqual([
      expect.objectContaining({
        $or: [
          { dueDate: { $gt: dueDate } },
          { dueDate, _id: { $gt: cursorId } },
        ],
      }),
    ]);
    expect(cursor.sort).toHaveBeenCalledWith({ dueDate: 1, _id: 1 });
    expect(cursor.limit).toHaveBeenCalledWith(200);
  });

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

  it('allocates task keys with hyphenated project codes and skips pre-seeded key collisions', async () => {
    const projectId = new Types.ObjectId().toHexString();
    let counterSeq = 0;
    const counters = {
      findOneAndUpdate: jest.fn(
        (
          _filter: unknown,
          update: { $inc?: { seq: number }; $max?: { seq: number } },
        ) => {
          if (update.$inc?.seq) counterSeq += update.$inc.seq;
          if (update.$max?.seq && update.$max.seq > counterSeq) {
            counterSeq = update.$max.seq;
          }
          return Promise.resolve({
            _id: new Types.ObjectId(projectId),
            seq: counterSeq,
          });
        },
      ),
    };
    const tasks = {
      findOne: jest.fn((query: { key: string }) =>
        Promise.resolve(
          query.key === 'CONT-FE-1' ? { _id: new Types.ObjectId() } : null,
        ),
      ),
      find: jest.fn(() => ({
        toArray: jest
          .fn()
          .mockResolvedValue([{ key: 'CONT-FE-1' }, { key: 'CONT-FE-2' }]),
      })),
    };
    const db = {
      collection: jest.fn((name: string) =>
        name === WORKSPACE_TASKS_COLLECTION ? tasks : counters,
      ),
    };
    const repository = new TaskWorkspaceRepository({
      useDb: jest.fn(() => ({ db })),
    } as unknown as Connection);

    await expect(
      repository.allocateNextTaskKey(projectId, 'CONT-FE'),
    ).resolves.toBe('CONT-FE-3');
    await expect(
      repository.allocateNextTaskKey(projectId, 'CONT-FE'),
    ).resolves.toBe('CONT-FE-4');
  });

  it('recognizes hyphenated task keys in listTasks search queries', async () => {
    const organizationId = new Types.ObjectId().toHexString();
    const projectId = new Types.ObjectId().toHexString();
    const cursor = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maxTimeMS: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([]),
    };
    const tasks = { find: jest.fn(() => cursor) };
    const db = { collection: jest.fn(() => tasks) };
    const repository = new TaskWorkspaceRepository({
      useDb: jest.fn(() => ({ db })),
    } as unknown as Connection);

    await repository.listTasks({
      organizationId,
      projectId,
      limit: 50,
      q: 'cont-fe-2',
    });

    const queryArg = (
      tasks.find.mock.calls[0] as unknown as [Record<string, unknown>]
    )?.[0];
    expect(queryArg?.$and).toEqual([
      {
        $or: [
          { key: 'CONT-FE-2' },
          { title: { $regex: 'cont-fe-2', $options: 'i' } },
        ],
      },
    ]);
  });

  it('unsets legacy subtaskCounts during transitionTaskStatus so seeded tasks pass MongoDB $jsonSchema validation', async () => {
    const organizationId = new Types.ObjectId().toHexString();
    const projectId = new Types.ObjectId().toHexString();
    const taskId = new Types.ObjectId().toHexString();
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
      status: 'IN_PROGRESS',
      version: 2,
    } as WorkspaceTaskDocument;
    const tasks = {
      findOneAndUpdate: jest.fn().mockResolvedValue(updatedTask),
      aggregate: jest.fn(() => ({
        toArray: jest.fn().mockResolvedValue([]),
      })),
    };
    const events = { insertOne: jest.fn().mockResolvedValue({}) };
    const db = {
      client: { startSession: jest.fn(() => session) },
      collection: jest.fn((name: string) =>
        name === WORKSPACE_TASKS_COLLECTION ? tasks : events,
      ),
    };
    const repository = new TaskWorkspaceRepository({
      useDb: jest.fn(() => ({ db })),
    } as unknown as Connection);

    await repository.transitionTaskStatus({
      organizationId,
      projectId,
      taskId,
      actorId,
      expectedVersion: 1,
      fromStatus: 'TODO',
      toStatus: 'IN_PROGRESS',
      operationId: 'op-seed-transition-1',
      correlationId: 'corr-seed-transition-1',
    });

    expect(tasks.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: new Types.ObjectId(taskId),
        projectId: new Types.ObjectId(projectId),
        status: 'TODO',
        version: 1,
      },
      expect.objectContaining({ $unset: { subtaskCounts: '' } }),
      expect.objectContaining({ returnDocument: 'after', session }),
    );
  });
});
