import { Types } from 'mongoose';
import {
  buildTaskCreationDocuments,
  isUuidV4,
  isValidTaskTitle,
  parseTaskCreateInput,
  resolveCorrelationId,
} from './task-contract';
import {
  TASK_EVENT_JSON_SCHEMA,
  TASK_JSON_SCHEMA,
  TASK_PERSISTENCE_INDEXES,
} from './task-database-schema';

describe('D-03 Task persistence contract', () => {
  it('preserves title exactly and rejects only empty or all-W values', () => {
    for (const whitespace of [
      '\u0009',
      '\u000a',
      '\u000b',
      '\u000c',
      '\u000d',
      '\u0020',
      '\u0085',
      '\u00a0',
      '\u1680',
      ...Array.from({ length: 11 }, (_, index) =>
        String.fromCodePoint(0x2000 + index),
      ),
      '\u2028',
      '\u2029',
      '\u202f',
      '\u205f',
      '\u3000',
    ]) {
      expect(isValidTaskTitle(whitespace)).toBe(false);
      expect(isValidTaskTitle(` ${whitespace}\t`)).toBe(false);
    }

    expect(isValidTaskTitle('  Nhiệm vụ  ')).toBe(true);
    expect(isValidTaskTitle('\u200b')).toBe(true);
    expect(isValidTaskTitle('x'.repeat(30_000))).toBe(true);
  });

  it('accepts only title as caller input and leaves its value untouched', () => {
    const title = '  giữ nguyên  ';
    expect(parseTaskCreateInput({ title })).toEqual({ title });
    expect(parseTaskCreateInput({ title: '\u200b' })).toEqual({
      title: '\u200b',
    });
    expect(parseTaskCreateInput({ title: '  ' })).toBeNull();
    expect(
      parseTaskCreateInput({ title, projectId: new Types.ObjectId() }),
    ).toBeNull();
    expect(
      parseTaskCreateInput({ title, createdBy: new Types.ObjectId() }),
    ).toBeNull();
    expect(parseTaskCreateInput({ title, version: 1 })).toBeNull();
    expect(parseTaskCreateInput(null)).toBeNull();
  });

  it('uses only a valid trusted request ID and otherwise generates a UUID v4', () => {
    expect(resolveCorrelationId('request-01._valid')).toBe('request-01._valid');
    expect(isUuidV4(resolveCorrelationId('invalid request id'))).toBe(true);
    expect(isUuidV4(resolveCorrelationId('x'.repeat(129)))).toBe(true);
  });

  it('DATN-373 O0 builds required event identity links and the exact creation event', () => {
    const taskId = new Types.ObjectId('000000000000000000000001');
    const eventId = new Types.ObjectId('000000000000000000000002');
    const projectId = new Types.ObjectId('000000000000000000000003');
    const actorId = new Types.ObjectId('000000000000000000000004');
    const createdAt = new Date('2026-10-14T00:00:00.000Z');
    const result = buildTaskCreationDocuments({
      taskId,
      eventId,
      projectId,
      actorId,
      input: { title: '  unchanged  ' },
      createdAt,
      operationId: 'fcb44b8d-3a0e-49b7-b9bd-cd00caf6e58a',
      correlationId: 'request-01',
    });

    expect(Object.keys(result.task).sort()).toEqual(
      [
        '_id',
        'projectId',
        'title',
        'createdBy',
        'createdAt',
        'updatedAt',
        'version',
      ].sort(),
    );
    expect(result.task).toEqual({
      _id: taskId,
      projectId,
      title: '  unchanged  ',
      createdBy: actorId,
      createdAt,
      updatedAt: createdAt,
      version: 1,
    });
    expect(result.event).toEqual({
      _id: eventId,
      taskId,
      projectId,
      eventName: 'TASK_CREATED',
      actorType: 'USER',
      actorId,
      source: 'HUMAN',
      changedFields: [
        'projectId',
        'title',
        'createdBy',
        'createdAt',
        'updatedAt',
        'version',
      ],
      taskVersion: 1,
      occurredAt: createdAt,
      operationId: 'fcb44b8d-3a0e-49b7-b9bd-cd00caf6e58a',
      correlationId: 'request-01',
    });
    expect(result.event._id).toBeInstanceOf(Types.ObjectId);
    expect(result.event.taskId).toEqual(result.task._id);
    expect(result.event.projectId).toEqual(result.task.projectId);
    expect(JSON.stringify(result.event)).not.toContain('unchanged');
    expect(Object.keys(result.event).sort()).toEqual(
      [
        '_id',
        'taskId',
        'projectId',
        'eventName',
        'actorType',
        'actorId',
        'source',
        'changedFields',
        'taskVersion',
        'occurredAt',
        'operationId',
        'correlationId',
      ].sort(),
    );
  });

  it('declares closed schemas and only the approved query indexes', () => {
    expect(TASK_JSON_SCHEMA.required).toEqual([
      '_id',
      'projectId',
      'title',
      'createdBy',
      'createdAt',
      'updatedAt',
      'version',
    ]);
    expect(Object.keys(TASK_JSON_SCHEMA.properties).sort()).toEqual(
      [
        '_id',
        'projectId',
        'title',
        'createdBy',
        'createdAt',
        'updatedAt',
        'version',
      ].sort(),
    );
    expect(TASK_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(TASK_JSON_SCHEMA.properties.title.pattern).not.toContain(
      '\\x{200B}',
    );
    expect(TASK_EVENT_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(TASK_PERSISTENCE_INDEXES).toEqual({
      tasks: [
        {
          key: { projectId: 1, _id: 1 },
          name: 'task_project_cursor',
        },
      ],
      task_events: [
        {
          key: { taskId: 1, taskVersion: 1 },
          name: 'task_event_task_version_unique',
          unique: true,
        },
      ],
    });
  });
});
