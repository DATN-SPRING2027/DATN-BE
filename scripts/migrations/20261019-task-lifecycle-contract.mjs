import mongoose from 'mongoose';
import { targetFingerprint } from './organization-membership-backfill.plan.mjs';
import {
  planTaskLifecycleContract,
  TASK_LIFECYCLE_INDEXES,
} from './task-lifecycle-contract.plan.mjs';

const TASK_DATABASE_NAME = 'continuum_task';
const TASK_COLLECTION = 'tasks';
const TASK_EVENT_COLLECTION = 'task_events';
const TASK_OPERATION_COLLECTION = 'task_operations';
const TASK_OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000;
const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'];
const TASK_BASE_REQUIRED_FIELDS = [
  '_id',
  'projectId',
  'title',
  'createdBy',
  'createdAt',
  'updatedAt',
  'version',
];
const TASK_CREATION_CHANGED_FIELDS = [
  'projectId',
  'title',
  'createdBy',
  'createdAt',
  'updatedAt',
  'version',
];
const TASK_TITLE_PATTERN = String.raw`[^\x{0009}-\x{000D}\x{0020}\x{0085}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}-\x{2029}\x{202F}\x{205F}\x{3000}]`;
const UUID_V4_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const REQUEST_ID_PATTERN = '^[A-Za-z0-9._-]{1,128}$';

// Keep these migration-time validators aligned with task-database-schema.ts.
const TASK_COLLECTION_VALIDATORS = buildTaskCollectionValidators();
const TASK_MIGRATION_COMPATIBILITY_VALIDATORS = buildTaskCollectionValidators({
  allowLegacyTaskDocuments: true,
});

const apply = process.argv.includes('--apply');
const taskWritesPaused = process.argv.includes('--task-writes-paused');
const expectedHash = process.argv
  .find((value) => value.startsWith('--expected-report-sha256='))
  ?.split('=')[1];
const uri = process.env.TASK_MONGODB_URI;

if (apply && !expectedHash)
  throw new Error('--apply requires a reviewed dry-run report SHA-256');
if (apply && !taskWritesPaused)
  throw new Error('--apply requires --task-writes-paused');
if (!uri)
  throw new Error('TASK_MONGODB_URI must be provided by the invoking process');

const fingerprint = targetFingerprint(uri, TASK_DATABASE_NAME);
const connection = mongoose.createConnection(uri, {
  dbName: TASK_DATABASE_NAME,
  autoIndex: false,
  serverSelectionTimeoutMS: 5000,
});

try {
  await connection.asPromise();
  const database = connection.db;
  if (!database || database.databaseName !== TASK_DATABASE_NAME)
    throw new Error('Connected database does not match continuum_task');

  const plan = await inspect(database);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);

  if (apply) {
    if (!plan.clean || expectedHash !== plan.reportSha256)
      throw new Error('Migration refused: report is not clean or hash differs');

    await database.command({
      collMod: TASK_COLLECTION,
      validator: TASK_MIGRATION_COMPATIBILITY_VALIDATORS.tasks,
      validationLevel: 'strict',
      validationAction: 'error',
    });
    await database.command({
      collMod: TASK_EVENT_COLLECTION,
      validator: TASK_COLLECTION_VALIDATORS.task_events,
      validationLevel: 'strict',
      validationAction: 'error',
    });

    if (plan.collections?.task_operations?.objectType !== 'collection') {
      await database.createCollection(TASK_OPERATION_COLLECTION, {
        validator: TASK_COLLECTION_VALIDATORS.task_operations,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    } else {
      await database.command({
        collMod: TASK_OPERATION_COLLECTION,
        validator: TASK_COLLECTION_VALIDATORS.task_operations,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    }

    await database.collection(TASK_COLLECTION).updateMany(
      {
        $or: [
          { status: { $exists: false } },
          { assigneeId: { $exists: false } },
          { completedAt: { $exists: false } },
        ],
      },
      [
        {
          $set: {
            status: { $ifNull: ['$status', 'TODO'] },
            assigneeId: { $ifNull: ['$assigneeId', null] },
            completedAt: { $ifNull: ['$completedAt', null] },
          },
        },
      ],
    );

    await database.command({
      collMod: TASK_COLLECTION,
      validator: TASK_COLLECTION_VALIDATORS.tasks,
      validationLevel: 'strict',
      validationAction: 'error',
    });

    const eventCollection = database.collection(TASK_EVENT_COLLECTION);
    if (plan.legacyEventIndexAction === 'DROP_EXACT_LEGACY_INDEX')
      await eventCollection.dropIndex('task_event_task_version_unique');
    await createPlannedIndexes(eventCollection, plan.taskEventIndexes);
    await createPlannedIndexes(
      database.collection(TASK_OPERATION_COLLECTION),
      plan.taskOperationIndexes,
    );

    const verification = await inspect(database, {
      allowLegacyTaskDocuments: false,
    });
    const indexesVerified = [
      ...verification.taskEventIndexes,
      ...verification.taskOperationIndexes,
    ].every(({ action }) => action === 'KEEP');
    if (
      !verification.clean ||
      !indexesVerified ||
      verification.tasksToBackfill.status !== 0 ||
      verification.tasksToBackfill.assigneeId !== 0 ||
      verification.tasksToBackfill.completedAt !== 0 ||
      verification.legacyEventIndexAction !== 'KEEP_ABSENT'
    )
      throw new Error('Task lifecycle migration verification failed');

    process.stdout.write(
      'Verified lifecycle validators, additive backfill, and indexes; Task and history documents were preserved.\n',
    );
  }
} finally {
  await connection.close();
}

async function inspect(database, { allowLegacyTaskDocuments = true } = {}) {
  const collections = {};
  for (const name of [
    TASK_COLLECTION,
    TASK_EVENT_COLLECTION,
    TASK_OPERATION_COLLECTION,
  ]) {
    const entry = await database
      .listCollections({ name }, { nameOnly: true })
      .next();
    collections[name] = {
      objectType: entry?.type ?? null,
      indexes:
        entry?.type === 'collection'
          ? await database.collection(name).indexes()
          : [],
    };
  }

  const taskCollection = database.collection(TASK_COLLECTION);
  const eventCollection = database.collection(TASK_EVENT_COLLECTION);
  const operationCollection = database.collection(TASK_OPERATION_COLLECTION);
  const [
    taskCount,
    missingStatus,
    missingAssigneeId,
    missingCompletedAt,
    invalidTaskDocuments,
    eventCount,
    invalidTaskEventDocuments,
    duplicateCreationVersions,
    duplicateMutationVersions,
    operationCount,
    invalidTaskOperationDocuments,
    duplicateKeys,
  ] = await Promise.all([
    collections[TASK_COLLECTION].objectType === 'collection'
      ? taskCollection.countDocuments()
      : 0,
    collections[TASK_COLLECTION].objectType === 'collection'
      ? taskCollection.countDocuments({ status: { $exists: false } })
      : 0,
    collections[TASK_COLLECTION].objectType === 'collection'
      ? taskCollection.countDocuments({ assigneeId: { $exists: false } })
      : 0,
    collections[TASK_COLLECTION].objectType === 'collection'
      ? taskCollection.countDocuments({ completedAt: { $exists: false } })
      : 0,
    collections[TASK_COLLECTION].objectType === 'collection'
      ? countInvalidDocuments(
          taskCollection,
          allowLegacyTaskDocuments
            ? TASK_MIGRATION_COMPATIBILITY_VALIDATORS.tasks
            : TASK_COLLECTION_VALIDATORS.tasks,
        )
      : 0,
    collections[TASK_EVENT_COLLECTION].objectType === 'collection'
      ? eventCollection.countDocuments()
      : 0,
    collections[TASK_EVENT_COLLECTION].objectType === 'collection'
      ? countInvalidDocuments(
          eventCollection,
          TASK_COLLECTION_VALIDATORS.task_events,
        )
      : 0,
    collections[TASK_EVENT_COLLECTION].objectType === 'collection'
      ? countDuplicateGroups(eventCollection, 'creation')
      : 0,
    collections[TASK_EVENT_COLLECTION].objectType === 'collection'
      ? countDuplicateGroups(eventCollection, 'mutation')
      : 0,
    collections[TASK_OPERATION_COLLECTION].objectType === 'collection'
      ? operationCollection.countDocuments()
      : 0,
    collections[TASK_OPERATION_COLLECTION].objectType === 'collection'
      ? countInvalidDocuments(
          operationCollection,
          TASK_COLLECTION_VALIDATORS.task_operations,
        )
      : 0,
    collections[TASK_OPERATION_COLLECTION].objectType === 'collection'
      ? countDuplicateOperationKeys(operationCollection)
      : 0,
  ]);

  return planTaskLifecycleContract({
    databaseName: database.databaseName,
    targetFingerprint: fingerprint,
    collections,
    tasks: {
      count: taskCount,
      missingStatus,
      missingAssigneeId,
      missingCompletedAt,
      invalidDocuments: invalidTaskDocuments,
    },
    taskEvents: {
      count: eventCount,
      invalidDocuments: invalidTaskEventDocuments,
      indexes: collections[TASK_EVENT_COLLECTION].indexes,
      duplicateCreationVersions,
      duplicateMutationVersions,
    },
    taskOperations: {
      count: operationCount,
      invalidDocuments: invalidTaskOperationDocuments,
      indexes: collections[TASK_OPERATION_COLLECTION].indexes,
      duplicateKeys,
    },
  });
}

async function countInvalidDocuments(collection, validator) {
  return collection.countDocuments({ $nor: [validator] });
}

async function countDuplicateGroups(collection, kind) {
  const match =
    kind === 'creation'
      ? { eventName: 'TASK_CREATED' }
      : { eventType: 'TASK_STATUS_TRANSITIONED' };
  const versionField = kind === 'creation' ? '$taskVersion' : '$version';
  const groups = await collection
    .aggregate([
      { $match: match },
      {
        $group: {
          _id: { taskId: '$taskId', version: versionField },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $count: 'duplicates' },
    ])
    .toArray();
  return groups[0]?.duplicates ?? 0;
}

async function countDuplicateOperationKeys(collection) {
  const groups = await collection
    .aggregate([
      {
        $group: {
          _id: {
            actorId: '$actorId',
            projectId: '$projectId',
            operationId: '$operationId',
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $count: 'duplicates' },
    ])
    .toArray();
  return groups[0]?.duplicates ?? 0;
}

async function createPlannedIndexes(collection, indexes) {
  for (const { action, key, name, ...options } of indexes) {
    if (action === 'CREATE')
      await collection.createIndex(key, { name, ...options });
    if (action === 'CONFLICT')
      throw new Error(`Refusing conflicting index ${name}`);
  }
}

function buildTaskCollectionValidators({
  allowLegacyTaskDocuments = false,
} = {}) {
  const taskProperties = {
    _id: { bsonType: 'objectId' },
    projectId: { bsonType: 'objectId' },
    title: { bsonType: 'string', pattern: TASK_TITLE_PATTERN },
    createdBy: { bsonType: 'objectId' },
    createdAt: { bsonType: 'date' },
    updatedAt: { bsonType: 'date' },
    status: { bsonType: 'string', enum: TASK_STATUSES },
    assigneeId: { bsonType: ['objectId', 'null'] },
    completedAt: { bsonType: ['date', 'null'] },
    version: { bsonType: ['int', 'long', 'double'], minimum: 1 },
  };
  const taskJsonSchema = {
    bsonType: 'object',
    required: [
      ...TASK_BASE_REQUIRED_FIELDS,
      ...(allowLegacyTaskDocuments
        ? []
        : ['status', 'assigneeId', 'completedAt']),
    ],
    additionalProperties: false,
    properties: taskProperties,
  };
  const legacyTaskShape = {
    $and: [
      { $eq: [{ $type: '$status' }, 'missing'] },
      { $eq: [{ $type: '$assigneeId' }, 'missing'] },
      { $eq: [{ $type: '$completedAt' }, 'missing'] },
    ],
  };
  const lifecycleTaskShape = {
    $and: [
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
  };

  const creationEventSchema = {
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
    properties: {
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
      operationId: { bsonType: 'string', pattern: UUID_V4_PATTERN },
      correlationId: { bsonType: 'string', pattern: REQUEST_ID_PATTERN },
    },
  };
  const statusEventSchema = {
    bsonType: 'object',
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
    properties: {
      _id: { bsonType: 'objectId' },
      taskId: { bsonType: 'objectId' },
      projectId: { bsonType: 'objectId' },
      actorId: { bsonType: 'objectId' },
      actorType: { bsonType: 'string', enum: ['USER', 'SYSTEM'] },
      source: {
        bsonType: 'string',
        enum: ['WEB', 'API', 'INTERNAL_SERVICE'],
      },
      eventType: {
        bsonType: 'string',
        enum: ['TASK_STATUS_TRANSITIONED'],
      },
      operationId: { bsonType: 'string', pattern: UUID_V4_PATTERN },
      correlationId: { bsonType: 'string', pattern: REQUEST_ID_PATTERN },
      timestamp: { bsonType: 'date' },
      version: { bsonType: ['int', 'long', 'double'], minimum: 2 },
      changedFields: { bsonType: 'array', enum: [['status']] },
      delta: {
        bsonType: 'object',
        required: ['type', 'fromStatus', 'toStatus'],
        additionalProperties: false,
        properties: {
          type: { bsonType: 'string', enum: ['STATUS_TRANSITION'] },
          fromStatus: { bsonType: 'string', enum: TASK_STATUSES },
          toStatus: { bsonType: 'string', enum: TASK_STATUSES },
          reason: { bsonType: 'string' },
        },
      },
    },
  };
  const operationSchema = {
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
    properties: {
      _id: { bsonType: 'objectId' },
      actorId: { bsonType: 'objectId' },
      projectId: { bsonType: 'objectId' },
      operationId: { bsonType: 'string', pattern: UUID_V4_PATTERN },
      fingerprint: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      state: {
        bsonType: 'string',
        enum: ['IN_PROGRESS', 'COMMITTED', 'REJECTED'],
      },
      taskId: { bsonType: 'objectId' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
      leaseUntil: { bsonType: 'date' },
      expiresAt: { bsonType: 'date' },
      result: {
        bsonType: 'object',
        oneOf: [
          {
            required: [
              'outcome',
              'status',
              'version',
              'completedAt',
              'updatedAt',
            ],
            additionalProperties: false,
            properties: {
              outcome: { bsonType: 'string', enum: ['COMMITTED'] },
              status: { bsonType: 'string', enum: TASK_STATUSES },
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
              currentStatus: { bsonType: 'string', enum: TASK_STATUSES },
              currentVersion: {
                bsonType: ['int', 'long', 'double'],
                minimum: 1,
              },
            },
          },
        ],
      },
    },
  };

  return {
    tasks: {
      $and: [
        { $jsonSchema: taskJsonSchema },
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
              ...(allowLegacyTaskDocuments
                ? [{ $or: [legacyTaskShape, lifecycleTaskShape] }]
                : [lifecycleTaskShape]),
            ],
          },
        },
      ],
    },
    task_events: {
      $or: [
        { $jsonSchema: creationEventSchema },
        {
          $and: [
            { $jsonSchema: statusEventSchema },
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
                  { $ne: ['$delta.fromStatus', '$delta.toStatus'] },
                  {
                    $or: [
                      {
                        $and: [
                          {
                            $in: ['$delta.toStatus', ['BLOCKED', 'CANCELLED']],
                          },
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
                            $in: ['$delta.fromStatus', ['BLOCKED', 'DONE']],
                          },
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
        { $jsonSchema: operationSchema },
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
                          {
                            $eq: [{ $type: '$result.completedAt' }, 'date'],
                          },
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
  };
}
