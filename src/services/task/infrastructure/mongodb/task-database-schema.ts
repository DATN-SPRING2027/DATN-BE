import mongoose from 'mongoose';
import {
  TASK_CREATION_CHANGED_FIELDS,
  TASK_STATUSES,
  TASK_TITLE_PATTERN,
} from './task-contract';

const TASK_OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000;

const taskProperties = {
  _id: { bsonType: 'objectId' },
  projectId: { bsonType: 'objectId' },
  title: { bsonType: 'string', pattern: TASK_TITLE_PATTERN },
  createdBy: { bsonType: 'objectId' },
  createdAt: { bsonType: 'date' },
  updatedAt: { bsonType: 'date' },
  status: { bsonType: 'string', enum: [...TASK_STATUSES] },
  assigneeId: { bsonType: ['objectId', 'null'] },
  completedAt: { bsonType: ['date', 'null'] },
  version: { bsonType: ['int', 'long', 'double'], minimum: 1 },
};

const taskCreationEventProperties = {
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

const taskStatusEventProperties = {
  _id: { bsonType: 'objectId' },
  taskId: { bsonType: 'objectId' },
  projectId: { bsonType: 'objectId' },
  actorId: { bsonType: 'objectId' },
  actorType: { bsonType: 'string', enum: ['USER', 'SYSTEM'] },
  source: {
    bsonType: 'string',
    enum: ['WEB', 'API', 'INTERNAL_SERVICE'],
  },
  eventType: { bsonType: 'string', enum: ['TASK_STATUS_TRANSITIONED'] },
  operationId: {
    bsonType: 'string',
    pattern:
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  },
  correlationId: {
    bsonType: 'string',
    pattern: '^[A-Za-z0-9._-]{1,128}$',
  },
  timestamp: { bsonType: 'date' },
  version: { bsonType: ['int', 'long', 'double'], minimum: 2 },
  changedFields: { bsonType: 'array', enum: [['status']] },
  delta: {
    bsonType: 'object',
    required: ['type', 'fromStatus', 'toStatus'],
    additionalProperties: false,
    properties: {
      type: { bsonType: 'string', enum: ['STATUS_TRANSITION'] },
      fromStatus: { bsonType: 'string', enum: [...TASK_STATUSES] },
      toStatus: { bsonType: 'string', enum: [...TASK_STATUSES] },
      reason: { bsonType: 'string' },
    },
  },
};

const taskOperationProperties = {
  _id: { bsonType: 'objectId' },
  actorId: { bsonType: 'objectId' },
  projectId: { bsonType: 'objectId' },
  operationId: {
    bsonType: 'string',
    pattern:
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  },
  fingerprint: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
  state: { bsonType: 'string', enum: ['IN_PROGRESS', 'COMMITTED', 'REJECTED'] },
  taskId: { bsonType: 'objectId' },
  createdAt: { bsonType: 'date' },
  updatedAt: { bsonType: 'date' },
  leaseUntil: { bsonType: 'date' },
  expiresAt: { bsonType: 'date' },
  result: {
    bsonType: 'object',
    oneOf: [
      {
        required: ['outcome', 'status', 'version', 'completedAt', 'updatedAt'],
        additionalProperties: false,
        properties: {
          outcome: { bsonType: 'string', enum: ['COMMITTED'] },
          status: { bsonType: 'string', enum: [...TASK_STATUSES] },
          version: { bsonType: ['int', 'long', 'double'], minimum: 1 },
          completedAt: { bsonType: ['date', 'null'] },
          updatedAt: { bsonType: 'date' },
        },
      },
      {
        required: ['outcome', 'code'],
        additionalProperties: false,
        properties: {
          outcome: { bsonType: 'string', enum: ['REJECTED'] },
          code: { bsonType: 'string', minLength: 1, maxLength: 80 },
          currentStatus: { bsonType: 'string', enum: [...TASK_STATUSES] },
          currentVersion: { bsonType: ['int', 'long', 'double'], minimum: 1 },
        },
      },
    ],
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
    'status',
    'assigneeId',
    'completedAt',
    'version',
  ],
  additionalProperties: false,
  properties: taskProperties,
} as const;

export const TASK_EVENT_JSON_SCHEMA = {
  bsonType: 'object',
  oneOf: [
    {
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
      properties: taskCreationEventProperties,
    },
    {
      required: [
        '_id',
        'taskId',
        'projectId',
        'actorId',
        'actorType',
        'source',
        'eventType',
        'operationId',
        'timestamp',
        'version',
        'changedFields',
        'delta',
      ],
      additionalProperties: false,
      properties: taskStatusEventProperties,
    },
  ],
} as const;

export const TASK_OPERATION_JSON_SCHEMA = {
  bsonType: 'object',
  required: [
    '_id',
    'actorId',
    'projectId',
    'operationId',
    'fingerprint',
    'state',
    'taskId',
    'createdAt',
    'updatedAt',
    'leaseUntil',
    'expiresAt',
  ],
  additionalProperties: false,
  properties: taskOperationProperties,
} as const;

export const TASK_COLLECTION_VALIDATORS = {
  tasks: {
    $and: [
      { $jsonSchema: TASK_JSON_SCHEMA },
      {
        $expr: {
          $and: [
            { $gte: ['$updatedAt', '$createdAt'] },
            {
              $cond: [
                { $isNumber: '$version' },
                { $eq: ['$version', { $trunc: '$version' }] },
                false,
              ],
            },
            { $eq: [{ $type: '$status' }, 'string'] },
            { $in: [{ $type: '$assigneeId' }, ['objectId', 'null']] },
            { $in: [{ $type: '$completedAt' }, ['date', 'null']] },
            {
              $eq: [
                { $eq: ['$status', 'DONE'] },
                { $eq: [{ $type: '$completedAt' }, 'date'] },
              ],
            },
          ],
        },
      },
    ],
  },
  task_events: {
    $or: [
      { $jsonSchema: TASK_EVENT_JSON_SCHEMA.oneOf[0] },
      {
        $and: [
          { $jsonSchema: TASK_EVENT_JSON_SCHEMA.oneOf[1] },
          {
            $expr: {
              $and: [
                {
                  $cond: [
                    { $isNumber: '$version' },
                    { $eq: ['$version', { $trunc: '$version' }] },
                    false,
                  ],
                },
                {
                  $or: [
                    {
                      $and: [
                        { $eq: ['$delta.fromStatus', 'TODO'] },
                        {
                          $in: [
                            '$delta.toStatus',
                            ['IN_PROGRESS', 'CANCELLED'],
                          ],
                        },
                      ],
                    },
                    {
                      $and: [
                        { $eq: ['$delta.fromStatus', 'IN_PROGRESS'] },
                        {
                          $in: [
                            '$delta.toStatus',
                            ['BLOCKED', 'DONE', 'CANCELLED'],
                          ],
                        },
                      ],
                    },
                    {
                      $and: [
                        { $eq: ['$delta.fromStatus', 'BLOCKED'] },
                        {
                          $in: [
                            '$delta.toStatus',
                            ['IN_PROGRESS', 'CANCELLED'],
                          ],
                        },
                      ],
                    },
                    {
                      $and: [
                        { $eq: ['$delta.fromStatus', 'DONE'] },
                        { $eq: ['$delta.toStatus', 'IN_PROGRESS'] },
                      ],
                    },
                  ],
                },
                {
                  $ne: ['$delta.fromStatus', '$delta.toStatus'],
                },
                {
                  $or: [
                    {
                      $and: [
                        { $in: ['$delta.toStatus', ['BLOCKED', 'CANCELLED']] },
                        {
                          $gte: [
                            {
                              $cond: [
                                {
                                  $eq: [{ $type: '$delta.reason' }, 'string'],
                                },
                                { $strLenCP: '$delta.reason' },
                                0,
                              ],
                            },
                            5,
                          ],
                        },
                      ],
                    },
                    {
                      $and: [
                        { $in: ['$delta.fromStatus', ['BLOCKED', 'DONE']] },
                        { $eq: ['$delta.toStatus', 'IN_PROGRESS'] },
                        {
                          $gte: [
                            {
                              $cond: [
                                {
                                  $eq: [{ $type: '$delta.reason' }, 'string'],
                                },
                                { $strLenCP: '$delta.reason' },
                                0,
                              ],
                            },
                            5,
                          ],
                        },
                      ],
                    },
                    {
                      $and: [
                        {
                          $not: [
                            {
                              $in: [
                                '$delta.toStatus',
                                ['BLOCKED', 'CANCELLED'],
                              ],
                            },
                          ],
                        },
                        {
                          $not: [
                            {
                              $and: [
                                {
                                  $in: [
                                    '$delta.fromStatus',
                                    ['BLOCKED', 'DONE'],
                                  ],
                                },
                                { $eq: ['$delta.toStatus', 'IN_PROGRESS'] },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  },
  task_operations: {
    $and: [
      { $jsonSchema: TASK_OPERATION_JSON_SCHEMA },
      {
        $expr: {
          $and: [
            { $gte: ['$updatedAt', '$createdAt'] },
            {
              $eq: [
                '$expiresAt',
                {
                  $cond: [
                    { $eq: [{ $type: '$createdAt' }, 'date'] },
                    { $add: ['$createdAt', TASK_OPERATION_RETENTION_MS] },
                    null,
                  ],
                },
              ],
            },
            {
              $or: [
                {
                  $and: [
                    { $eq: ['$state', 'IN_PROGRESS'] },
                    { $eq: [{ $type: '$result' }, 'missing'] },
                  ],
                },
                {
                  $and: [
                    { $eq: ['$state', 'COMMITTED'] },
                    { $eq: ['$result.outcome', 'COMMITTED'] },
                    {
                      $eq: [
                        { $eq: ['$result.status', 'DONE'] },
                        { $eq: [{ $type: '$result.completedAt' }, 'date'] },
                      ],
                    },
                    {
                      $cond: [
                        { $isNumber: '$result.version' },
                        {
                          $eq: [
                            '$result.version',
                            { $trunc: '$result.version' },
                          ],
                        },
                        false,
                      ],
                    },
                  ],
                },
                {
                  $and: [
                    { $eq: ['$state', 'REJECTED'] },
                    { $eq: ['$result.outcome', 'REJECTED'] },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  },
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
      name: 'task_event_task_creation_version_unique',
      unique: true,
      partialFilterExpression: { eventName: 'TASK_CREATED' },
    },
    {
      key: { taskId: 1, version: 1 },
      name: 'task_event_task_mutation_version_unique',
      unique: true,
      partialFilterExpression: { eventType: 'TASK_STATUS_TRANSITIONED' },
    },
  ],
  task_operations: [
    {
      key: { actorId: 1, projectId: 1, operationId: 1 },
      name: 'task_operation_actor_project_key_unique',
      unique: true,
    },
    {
      key: { expiresAt: 1 },
      name: 'task_operation_expiry_ttl',
      expireAfterSeconds: 0,
    },
  ],
} as const;

export function taskValidatorCommand(collectionName: string) {
  if (
    collectionName !== 'tasks' &&
    collectionName !== 'task_events' &&
    collectionName !== 'task_operations'
  )
    throw new Error('Unsupported Task persistence collection');
  return {
    collMod: collectionName,
    validator: TASK_COLLECTION_VALIDATORS[collectionName],
    validationLevel: 'strict',
    validationAction: 'error',
  } satisfies mongoose.mongo.Document;
}
