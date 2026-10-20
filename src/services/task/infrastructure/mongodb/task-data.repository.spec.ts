import mongoose, { Types } from 'mongoose';
import {
  TASK_DATABASE_NAME,
  TASK_EVENT_COLLECTION,
  buildTaskCreationDocuments,
  type TaskDocument,
} from './task-contract';
import { TaskDataRepository } from './task-data.repository';

describe('TaskDataRepository history reads', () => {
  it('uses only indexed, approved event variants for count and page queries', async () => {
    const taskId = new Types.ObjectId();
    const projectId = new Types.ObjectId();
    const countDocuments = jest.fn().mockResolvedValue(1);
    const { event } = buildTaskCreationDocuments({
      taskId,
      eventId: new Types.ObjectId(),
      projectId,
      actorId: new Types.ObjectId(),
      input: { title: 'History test' },
      createdAt: new Date('2026-10-19T00:00:00.000Z'),
      operationId: '00000000-0000-4000-8000-000000000001',
      correlationId: '00000000-0000-4000-8000-000000000002',
    });
    const toArray = jest.fn().mockResolvedValue([event]);
    const aggregate = jest.fn().mockReturnValue({ toArray });
    const eventCollection = { countDocuments, aggregate };
    const getCollection = jest.fn(() => eventCollection);
    const database = {
      databaseName: TASK_DATABASE_NAME,
      collection: getCollection,
    } as unknown as mongoose.mongo.Db;
    const repository = new TaskDataRepository(database);
    jest.spyOn(repository, 'getById').mockResolvedValue({
      _id: taskId,
      projectId,
    } as unknown as TaskDocument);
    const expectedFilter = {
      $or: [
        { taskId, projectId, eventName: 'TASK_CREATED' },
        { taskId, projectId, eventType: 'TASK_STATUS_TRANSITIONED' },
      ],
    };

    await expect(
      repository.listHistory(String(projectId), String(taskId), {
        page: 1,
        limit: 20,
      }),
    ).resolves.toEqual({ events: [event], total: 1 });

    expect(getCollection).toHaveBeenCalledWith(TASK_EVENT_COLLECTION);
    expect(countDocuments).toHaveBeenCalledWith(expectedFilter);
    expect(aggregate).toHaveBeenCalledWith([
      { $match: expectedFilter },
      { $set: { historyVersion: { $ifNull: ['$taskVersion', '$version'] } } },
      { $sort: { historyVersion: 1, _id: 1 } },
      { $skip: 0 },
      { $limit: 20 },
      { $unset: 'historyVersion' },
    ]);
  });
});
