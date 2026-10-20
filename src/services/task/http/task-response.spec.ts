import { Types } from 'mongoose';
import type { TaskDocument } from '../infrastructure/mongodb/task-contract';
import { toTaskResponse } from './task-response';

const taskId = '650000000000000000000001';
const projectId = 'abcdef0123456789abcdef01';
const actorId = '0123456789abcdef01234567';

function storedTask(overrides: Partial<TaskDocument> = {}): TaskDocument {
  return {
    _id: new Types.ObjectId(taskId),
    projectId: new Types.ObjectId(projectId),
    title: '  Giữ nguyên tiêu đề  ',
    createdBy: new Types.ObjectId(actorId),
    createdAt: new Date('2026-10-19T01:02:03.456Z'),
    updatedAt: new Date('2026-10-19T01:02:03.456Z'),
    status: 'TODO',
    assigneeId: null,
    completedAt: null,
    version: 1,
    ...overrides,
  };
}

describe('toTaskResponse (DR-1 seven-field Task)', () => {
  it('returns exactly the seven approved fields as lowercase hex ids and ISO-8601 UTC dates', () => {
    expect(toTaskResponse(storedTask())).toEqual({
      id: taskId,
      projectId,
      title: '  Giữ nguyên tiêu đề  ',
      createdBy: actorId,
      createdAt: '2026-10-19T01:02:03.456Z',
      updatedAt: '2026-10-19T01:02:03.456Z',
      version: 1,
    });
  });

  it('never exposes lifecycle or assignment fields stored since PR #58', () => {
    const response = toTaskResponse(
      storedTask({
        status: 'CANCELLED',
        assigneeId: new Types.ObjectId(actorId),
        completedAt: new Date('2026-10-20T00:00:00.000Z'),
        version: 3,
        updatedAt: new Date('2026-10-20T00:00:00.000Z'),
      }),
    );

    expect(Object.keys(response).sort()).toEqual(
      [
        'createdAt',
        'createdBy',
        'id',
        'projectId',
        'title',
        'updatedAt',
        'version',
      ].sort(),
    );
    expect(response.version).toBe(3);
    expect(response.updatedAt).toBe('2026-10-20T00:00:00.000Z');
    expect(JSON.stringify(response)).not.toMatch(
      /CANCELLED|assigneeId|completedAt|status/,
    );
  });
});
