import mongoose from 'mongoose';
import {
  TASK_CREATION_CHANGED_FIELDS,
  TASK_TITLE_PATTERN,
} from './task-contract';

const taskProperties = {
  _id: { bsonType: 'objectId' },
  projectId: { bsonType: 'objectId' },
  title: { bsonType: 'string', pattern: TASK_TITLE_PATTERN },
  createdBy: { bsonType: 'objectId' },
  createdAt: { bsonType: 'date' },
  updatedAt: { bsonType: 'date' },
  version: { bsonType: ['int', 'double'], enum: [1] },
};

const taskEventProperties = {
  _id: { bsonType: 'objectId' },
  taskId: { bsonType: 'objectId' },
  projectId: { bsonType: 'objectId' },
  eventName: { bsonType: 'string', enum: ['TASK_CREATED'] },
  actorType: { bsonType: 'string', enum: ['USER'] },
  actorId: { bsonType: 'objectId' },
  source: { bsonType: 'string', enum: ['HUMAN'] },
  changedFields: {
    bsonType: 'array',
    enum: [[...TASK_CREATION_CHANGED_FIELDS]],
  },
  taskVersion: { bsonType: ['int', 'double'], enum: [1] },
  occurredAt: { bsonType: 'date' },
  operationId: {
    bsonType: 'string',
    pattern:
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  },
  correlationId: {
    bsonType: 'string',
    pattern: '^[A-Za-z0-9._-]{1,128}$',
  },
};

export const TASK_JSON_SCHEMA = {
  bsonType: 'object',
  required: [
    '_id',
    'projectId',
    'title',
    'createdBy',
    'createdAt',
    'updatedAt',
    'version',
  ],
  additionalProperties: false,
  properties: taskProperties,
} as const;

export const TASK_EVENT_JSON_SCHEMA = {
  bsonType: 'object',
  required: [
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
  ],
  additionalProperties: false,
  properties: taskEventProperties,
} as const;

export const TASK_COLLECTION_VALIDATORS = {
  tasks: {
    $and: [
      { $jsonSchema: TASK_JSON_SCHEMA },
      { $expr: { $eq: ['$createdAt', '$updatedAt'] } },
    ],
  },
  task_events: { $jsonSchema: TASK_EVENT_JSON_SCHEMA },
} as const;

export const TASK_PERSISTENCE_INDEXES = {
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
} as const;

export function taskValidatorCommand(collectionName: string) {
  if (collectionName !== 'tasks' && collectionName !== 'task_events')
    throw new Error('Unsupported Task persistence collection');
  return {
    collMod: collectionName,
    validator: TASK_COLLECTION_VALIDATORS[collectionName],
    validationLevel: 'strict',
    validationAction: 'error',
  } satisfies mongoose.mongo.Document;
}
