import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { targetFingerprint } from './organization-membership-backfill.plan.mjs';

const TASK_DATABASE_NAME = 'continuum_task';
const IAM_DATABASE_NAME = 'continuum_iam';

const WORKSPACE_TASK_STATUSES = [
  'TODO',
  'IN_PROGRESS',
  'IN_REVIEW',
  'BLOCKED',
  'DONE',
  'CANCELLED',
];
const WORKSPACE_TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'];
const WORKSPACE_TASK_TYPES = ['TASK', 'BUG', 'STORY'];
const WORKSPACE_SPRINT_STATUSES = ['PLANNED', 'ACTIVE', 'COMPLETED'];

// Canonical index catalogue shared 1:1 with TaskWorkspaceRepository.ensureIndexes()
export const WORKSPACE_INDEX_CATALOGUE = {
  tasks: [
    { key: { projectId: 1, _id: 1 }, name: 'task_project_cursor' },
    {
      key: { projectId: 1, status: 1, _id: 1 },
      name: 'project_status_cursor',
    },
    {
      key: { projectId: 1, assigneeId: 1, _id: 1, status: 1 },
      name: 'project_assignee_cursor_status',
    },
    {
      key: { projectId: 1, sprintId: 1, _id: 1, status: 1 },
      name: 'project_sprint_cursor_status',
    },
    { key: { projectId: 1, dueDate: 1, _id: 1 }, name: 'project_due_cursor' },
    {
      key: { projectId: 1, parentId: 1, _id: 1 },
      name: 'project_parent_cursor',
    },
    {
      key: { projectId: 1, key: 1 },
      name: 'project_key_unique',
      unique: true,
      partialFilterExpression: { key: { $type: 'string' } },
    },
    { key: { organizationId: 1, _id: 1 }, name: 'org_cursor' },
    {
      key: { organizationId: 1, status: 1, _id: 1 },
      name: 'org_status_cursor',
    },
    {
      key: { organizationId: 1, projectId: 1, _id: 1 },
      name: 'org_project_cursor',
    },
    {
      key: { organizationId: 1, assigneeId: 1, _id: 1, status: 1 },
      name: 'org_assignee_cursor_status',
    },
    {
      key: { organizationId: 1, dueDate: 1, _id: 1 },
      name: 'org_due_cursor',
    },
    {
      key: { organizationId: 1, projectId: 1, status: 1, dueDate: 1 },
      name: 'org_project_status_due',
    },
  ],
  task_comments: [
    {
      key: { projectId: 1, taskId: 1, _id: 1 },
      name: 'task_comments_cursor',
    },
  ],
  task_events: [
    {
      key: { projectId: 1, taskId: 1, _id: -1 },
      name: 'task_events_project_task_cursor',
    },
    {
      key: { taskId: 1, version: 1 },
      name: 'task_event_task_mutation_version_unique',
      unique: true,
      partialFilterExpression: {
        eventType: { $in: ['TASK_STATUS_TRANSITIONED', 'TASK_UPDATED'] },
      },
    },
  ],
  task_worklogs: [
    {
      key: { projectId: 1, taskId: 1, _id: -1 },
      name: 'task_worklogs_cursor',
    },
  ],
  project_sprints: [
    {
      key: { projectId: 1, createdAt: -1, _id: -1 },
      name: 'project_sprints_created_desc',
    },
    {
      key: { projectId: 1 },
      name: 'project_one_active_sprint_unique',
      unique: true,
      partialFilterExpression: { status: 'ACTIVE' },
    },
  ],
  project_sprint_events: [
    {
      key: { sprintId: 1, version: 1 },
      name: 'sprint_event_version_unique',
      unique: true,
    },
    {
      key: { projectId: 1, sprintId: 1, occurredAt: -1, _id: -1 },
      name: 'project_sprint_events_cursor',
    },
  ],
  task_operations: [
    {
      key: { actorId: 1, projectId: 1, operationId: 1 },
      name: 'task_operation_actor_project_idempotency_unique',
      unique: true,
    },
    {
      key: { expiresAt: 1 },
      name: 'task_operation_expires_ttl',
      expireAfterSeconds: 0,
    },
  ],
};

// Strict MongoDB $jsonSchema validators shared 1:1 with TaskWorkspaceRepository
export const WORKSPACE_COLLECTION_VALIDATORS = {
  tasks: {
    $jsonSchema: {
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
      properties: {
        _id: { bsonType: 'objectId' },
        organizationId: { bsonType: 'objectId' },
        projectId: { bsonType: 'objectId' },
        key: { bsonType: 'string', minLength: 1, maxLength: 32 },
        title: { bsonType: 'string', minLength: 1, maxLength: 255 },
        description: { bsonType: ['string', 'null'], maxLength: 20000 },
        type: { bsonType: 'string', enum: WORKSPACE_TASK_TYPES },
        status: { bsonType: 'string', enum: WORKSPACE_TASK_STATUSES },
        priority: { bsonType: 'string', enum: WORKSPACE_TASK_PRIORITIES },
        assigneeId: { bsonType: ['objectId', 'null'] },
        createdBy: { bsonType: 'objectId' },
        parentId: { bsonType: ['objectId', 'null'] },
        sprintId: { bsonType: ['objectId', 'null'] },
        labels: {
          bsonType: 'array',
          maxItems: 20,
          items: { bsonType: 'string', minLength: 1, maxLength: 40 },
        },
        steps: {
          bsonType: 'array',
          maxItems: 50,
          items: {
            bsonType: 'object',
            required: ['id', 'text', 'done'],
            additionalProperties: false,
            properties: {
              id: { bsonType: 'string', minLength: 1, maxLength: 64 },
              text: { bsonType: 'string', minLength: 1, maxLength: 500 },
              done: { bsonType: 'bool' },
            },
          },
        },
        dueDate: { bsonType: ['date', 'null'] },
        startDate: { bsonType: ['date', 'null'] },
        completedAt: { bsonType: ['date', 'null'] },
        createdAt: { bsonType: 'date' },
        updatedAt: { bsonType: 'date' },
        version: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      },
    },
  },
  task_events: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id',
        'taskId',
        'projectId',
        'actorType',
        'actorId',
        'source',
        'operationId',
        'correlationId',
      ],
      additionalProperties: false,
      properties: {
        _id: { bsonType: 'objectId' },
        taskId: { bsonType: 'objectId' },
        projectId: { bsonType: 'objectId' },
        organizationId: { bsonType: 'objectId' },
        eventName: { bsonType: 'string', enum: ['TASK_CREATED'] },
        eventType: {
          bsonType: 'string',
          enum: [
            'TASK_CREATED',
            'TASK_STATUS_TRANSITIONED',
            'TASK_UPDATED',
            'TASK_COMMENT_ADDED',
            'TASK_WORKLOG_ADDED',
          ],
        },
        actorType: { bsonType: 'string', enum: ['USER', 'SYSTEM'] },
        actorId: { bsonType: 'objectId' },
        source: {
          bsonType: 'string',
          enum: ['HUMAN', 'WEB', 'API', 'INTERNAL_SERVICE'],
        },
        changedFields: {
          bsonType: 'array',
          items: { bsonType: 'string' },
        },
        taskVersion: { bsonType: ['int', 'long', 'double'], minimum: 1 },
        version: { bsonType: ['int', 'long', 'double'], minimum: 1 },
        occurredAt: { bsonType: 'date' },
        timestamp: { bsonType: 'date' },
        operationId: { bsonType: 'string', minLength: 1, maxLength: 128 },
        correlationId: { bsonType: 'string', minLength: 1, maxLength: 128 },
        delta: {
          bsonType: 'object',
          additionalProperties: false,
          properties: {
            type: {
              bsonType: 'string',
              enum: [
                'STATUS_TRANSITION',
                'FIELD_UPDATE',
                'COMMENT_ADDED',
                'WORKLOG_ADDED',
              ],
            },
            fromStatus: {
              bsonType: 'string',
              enum: WORKSPACE_TASK_STATUSES,
            },
            toStatus: {
              bsonType: 'string',
              enum: WORKSPACE_TASK_STATUSES,
            },
            reason: { bsonType: 'string', maxLength: 500 },
            changedFields: {
              bsonType: 'array',
              minItems: 1,
              items: { bsonType: 'string' },
            },
            fromSprintId: { bsonType: ['objectId', 'null'] },
            toSprintId: { bsonType: ['objectId', 'null'] },
            commentId: { bsonType: 'objectId' },
            worklogId: { bsonType: 'objectId' },
            minutes: {
              bsonType: ['int', 'long', 'double'],
              minimum: 1,
              maximum: 1440,
            },
          },
        },
      },
    },
  },
  task_operations: {
    $jsonSchema: {
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
        operationId: { bsonType: 'string', minLength: 1, maxLength: 128 },
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
        result: { bsonType: 'object' },
        httpResponse: {
          bsonType: 'object',
          required: ['statusCode', 'body'],
          additionalProperties: false,
          properties: {
            statusCode: { bsonType: ['int', 'long', 'double'] },
            body: {},
            etag: { bsonType: 'string' },
            location: { bsonType: 'string' },
          },
        },
      },
    },
  },
  task_comments: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id',
        'taskId',
        'projectId',
        'organizationId',
        'authorId',
        'body',
        'createdAt',
      ],
      additionalProperties: false,
      properties: {
        _id: { bsonType: 'objectId' },
        taskId: { bsonType: 'objectId' },
        projectId: { bsonType: 'objectId' },
        organizationId: { bsonType: 'objectId' },
        authorId: { bsonType: 'objectId' },
        body: { bsonType: 'string', minLength: 1, maxLength: 5000 },
        createdAt: { bsonType: 'date' },
      },
    },
  },
  task_worklogs: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id',
        'taskId',
        'projectId',
        'organizationId',
        'authorId',
        'minutes',
        'note',
        'loggedAt',
        'createdAt',
      ],
      additionalProperties: false,
      properties: {
        _id: { bsonType: 'objectId' },
        taskId: { bsonType: 'objectId' },
        projectId: { bsonType: 'objectId' },
        organizationId: { bsonType: 'objectId' },
        authorId: { bsonType: 'objectId' },
        minutes: {
          bsonType: ['int', 'long', 'double'],
          minimum: 1,
          maximum: 1440,
        },
        note: { bsonType: ['string', 'null'], maxLength: 2000 },
        loggedAt: { bsonType: 'date' },
        createdAt: { bsonType: 'date' },
      },
    },
  },
  project_sprints: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id',
        'projectId',
        'organizationId',
        'name',
        'goal',
        'status',
        'startDate',
        'endDate',
        'createdBy',
        'createdAt',
        'completedAt',
        'version',
      ],
      additionalProperties: false,
      properties: {
        _id: { bsonType: 'objectId' },
        projectId: { bsonType: 'objectId' },
        organizationId: { bsonType: 'objectId' },
        name: { bsonType: 'string', minLength: 1, maxLength: 120 },
        goal: { bsonType: ['string', 'null'], maxLength: 1000 },
        status: { bsonType: 'string', enum: WORKSPACE_SPRINT_STATUSES },
        startDate: { bsonType: ['date', 'null'] },
        endDate: { bsonType: ['date', 'null'] },
        createdBy: { bsonType: 'objectId' },
        createdAt: { bsonType: 'date' },
        completedAt: { bsonType: ['date', 'null'] },
        version: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      },
    },
  },
  project_sprint_events: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id',
        'sprintId',
        'projectId',
        'organizationId',
        'eventType',
        'actorId',
        'actorType',
        'occurredAt',
        'version',
        'delta',
      ],
      additionalProperties: false,
      properties: {
        _id: { bsonType: 'objectId' },
        sprintId: { bsonType: 'objectId' },
        projectId: { bsonType: 'objectId' },
        organizationId: { bsonType: 'objectId' },
        eventType: {
          bsonType: 'string',
          enum: ['SPRINT_CREATED', 'SPRINT_UPDATED', 'SPRINT_COMPLETED'],
        },
        actorId: { bsonType: 'objectId' },
        actorType: { bsonType: 'string', enum: ['USER'] },
        occurredAt: { bsonType: 'date' },
        version: { bsonType: ['int', 'long', 'double'], minimum: 1 },
        delta: { bsonType: 'object' },
      },
    },
  },
};

export async function inspectWorkspaceMigration(db, iamDb, targetUri = '') {
  const fingerprint = targetFingerprint(targetUri, TASK_DATABASE_NAME);
  const existingCollections = await db.listCollections().toArray();
  const collectionNames = new Set(existingCollections.map((c) => c.name));

  const tasksCol = db.collection('tasks');
  const totalTasks = collectionNames.has('tasks')
    ? await tasksCol.countDocuments({})
    : 0;
  const tasksMissingWorkspaceFields = collectionNames.has('tasks')
    ? await tasksCol.countDocuments({
        $or: [
          { organizationId: { $exists: false } },
          { key: { $exists: false } },
          { type: { $exists: false } },
          { priority: { $exists: false } },
          { status: { $exists: false } },
          { labels: { $exists: false } },
          { steps: { $exists: false } },
        ],
      })
    : 0;

  let unresolvedProjectIds = [];
  if (collectionNames.has('tasks') && tasksMissingWorkspaceFields > 0) {
    const projectIds = await tasksCol.distinct('projectId', {
      organizationId: { $exists: false },
    });
    if (projectIds.length > 0) {
      const projects = await iamDb
        .collection('projects')
        .find({ _id: { $in: projectIds } }, { projection: { _id: 1 } })
        .toArray();
      const foundSet = new Set(projects.map((p) => p._id.toHexString()));
      unresolvedProjectIds = projectIds
        .map((id) => id.toHexString())
        .filter((hex) => !foundSet.has(hex));
    }
  }

  const summary = {
    migration: '20261022-task-workspace-fields',
    target: fingerprint,
    clean: unresolvedProjectIds.length === 0,
    totalTasks,
    tasksMissingWorkspaceFields,
    unresolvedProjectIds,
    plannedCollections: [
      'tasks',
      'task_events',
      'task_operations',
      'task_counters',
      'project_sprints',
      'project_sprint_events',
      'task_comments',
      'task_worklogs',
    ],
    plannedTaskIndexes: WORKSPACE_INDEX_CATALOGUE.tasks.map((i) => i.name),
  };

  const reportSha256 = createHash('sha256')
    .update(JSON.stringify(summary))
    .digest('hex');

  return {
    ...summary,
    reportSha256,
  };
}

export async function syncCollectionIndexes(collection, specs) {
  const existing = await collection
    .listIndexes()
    .toArray()
    .catch(() => []);

  for (const spec of specs) {
    const targetKeyJson = JSON.stringify(spec.key);
    for (const idx of existing) {
      if (idx.name === '_id_') continue;
      const sameName = idx.name === spec.name;
      const sameKey = JSON.stringify(idx.key) === targetKeyJson;
      if (!sameName && !sameKey) continue;

      const sameUnique = Boolean(idx.unique) === Boolean(spec.unique);
      const sameTtl =
        (idx.expireAfterSeconds ?? undefined) ===
        (spec.expireAfterSeconds ?? undefined);
      const samePartial =
        JSON.stringify(idx.partialFilterExpression ?? null) ===
        JSON.stringify(spec.partialFilterExpression ?? null);

      if (!sameName || !sameKey || !sameUnique || !sameTtl || !samePartial) {
        await collection.dropIndex(idx.name).catch(() => undefined);
      }
    }

    await collection.createIndex(spec.key, {
      name: spec.name,
      ...(spec.unique ? { unique: true } : {}),
      ...(spec.expireAfterSeconds !== undefined
        ? { expireAfterSeconds: spec.expireAfterSeconds }
        : {}),
      ...(spec.partialFilterExpression
        ? { partialFilterExpression: spec.partialFilterExpression }
        : {}),
    });
  }
}

export async function applyWorkspaceMigration(db, iamDb) {
  const existingCollections = await db.listCollections().toArray();
  const collectionNames = new Set(existingCollections.map((c) => c.name));

  // Ensure all collections exist and upgrade validators to the expanded Workspace $jsonSchema
  // before backfilling legacy tasks so new Workspace fields pass strict validation.
  for (const name of [
    'tasks',
    'task_events',
    'task_operations',
    'task_counters',
    'project_sprints',
    'project_sprint_events',
    'task_comments',
    'task_worklogs',
  ]) {
    const validator = WORKSPACE_COLLECTION_VALIDATORS[name];
    if (!collectionNames.has(name)) {
      await db.createCollection(
        name,
        validator
          ? {
              validator,
              validationLevel: 'strict',
              validationAction: 'error',
            }
          : {},
      );
    } else if (validator) {
      await db.command({
        collMod: name,
        validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    }
  }

  const tasksCol = db.collection('tasks');
  const countersCol = db.collection('task_counters');

  const legacyTasks = await tasksCol
    .find({
      $or: [
        { organizationId: { $exists: false } },
        { key: { $exists: false } },
      ],
    })
    .sort({ projectId: 1, _id: 1 })
    .toArray();

  if (legacyTasks.length > 0) {
    const projectIds = [
      ...new Set(legacyTasks.map((t) => t.projectId.toHexString())),
    ].map((id) => new mongoose.Types.ObjectId(id));
    const projects = await iamDb
      .collection('projects')
      .find(
        { _id: { $in: projectIds } },
        { projection: { _id: 1, organizationId: 1, key: 1, code: 1, name: 1 } },
      )
      .toArray();
    const projectMap = new Map(projects.map((p) => [p._id.toHexString(), p]));

    for (const task of legacyTasks) {
      const pHex = task.projectId.toHexString();
      const project = projectMap.get(pHex);
      if (!project) {
        throw new Error(
          `Cannot resolve IAM project ${pHex} for task ${task._id}`,
        );
      }
      const rawCode = String(
        project.key ?? project.code ?? project.name ?? 'TASK',
      )
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 10);
      const code = rawCode.length >= 2 ? rawCode : 'TASK';

      let key = task.key;
      if (!key) {
        const counterDoc = await countersCol.findOneAndUpdate(
          { _id: task.projectId },
          { $inc: { seq: 1 } },
          { upsert: true, returnDocument: 'after' },
        );
        const seq = counterDoc?.seq ?? 1;
        key = `${code}-${seq}`;
      }

      await tasksCol.updateOne(
        { _id: task._id },
        {
          $set: {
            organizationId: task.organizationId ?? project.organizationId,
            key,
            type: task.type ?? 'TASK',
            priority: task.priority ?? 'MEDIUM',
            status: task.status ?? 'TODO',
            assigneeId: task.assigneeId ?? null,
            parentId: task.parentId ?? null,
            sprintId: task.sprintId ?? null,
            labels: Array.isArray(task.labels) ? task.labels : [],
            steps: Array.isArray(task.steps) ? task.steps : [],
            dueDate: task.dueDate ?? null,
            startDate: task.startDate ?? null,
            completedAt: task.completedAt ?? null,
            description: task.description ?? null,
          },
        },
      );
    }
  }

  for (const [collName, specs] of Object.entries(WORKSPACE_INDEX_CATALOGUE)) {
    await syncCollectionIndexes(db.collection(collName), specs);
  }
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) ===
    path.resolve(process.argv[1]);

if (isDirectExecution) {
  const apply = process.argv.includes('--apply');
  const taskWritesPaused = process.argv.includes('--task-writes-paused');
  const expectedHash = process.argv
    .find((value) => value.startsWith('--expected-report-sha256='))
    ?.split('=')[1];
  const uri = process.env.TASK_MONGODB_URI || process.env.MONGODB_URI;

  if (apply && !expectedHash) {
    throw new Error('--apply requires a reviewed dry-run report SHA-256');
  }
  if (apply && !taskWritesPaused) {
    throw new Error('--apply requires --task-writes-paused');
  }
  if (!uri) {
    throw new Error(
      'TASK_MONGODB_URI or MONGODB_URI must be provided by the invoking process',
    );
  }

  const connection = mongoose.createConnection(uri, {
    dbName: TASK_DATABASE_NAME,
    autoIndex: false,
    serverSelectionTimeoutMS: 5000,
  });

  try {
    await connection.asPromise();
    const db = connection.db;
    const iamDb = connection.useDb(IAM_DATABASE_NAME, { useCache: true }).db;

    const plan = await inspectWorkspaceMigration(db, iamDb, uri);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);

    if (apply) {
      if (!plan.clean || expectedHash !== plan.reportSha256) {
        throw new Error(
          'Migration refused: report is not clean or hash differs',
        );
      }

      await applyWorkspaceMigration(db, iamDb);
      const verification = await inspectWorkspaceMigration(db, iamDb, uri);
      if (!verification.clean || verification.tasksMissingWorkspaceFields > 0) {
        throw new Error('Workspace migration verification failed');
      }
      process.stdout.write(
        'Verified workspace task fields, strict validators, collections, and canonical indexes.\n',
      );
    }
  } finally {
    await connection.close();
  }
}
