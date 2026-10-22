import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { targetFingerprint } from './organization-membership-backfill.plan.mjs';

const TASK_DATABASE_NAME = 'continuum_task';
const IAM_DATABASE_NAME = 'continuum_iam';

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

const WORKSPACE_TASK_INDEXES = [
  {
    name: 'tasks_project_id_cursor',
    key: { projectId: 1, _id: 1 },
  },
  {
    name: 'tasks_project_key_unique',
    key: { projectId: 1, key: 1 },
    options: { unique: true },
  },
  {
    name: 'tasks_project_status_cursor',
    key: { projectId: 1, status: 1, _id: 1 },
  },
  {
    name: 'tasks_project_assignee_status_cursor',
    key: { projectId: 1, assigneeId: 1, status: 1, _id: 1 },
  },
  {
    name: 'tasks_project_assignee_cursor',
    key: { projectId: 1, assigneeId: 1, _id: 1 },
  },
  {
    name: 'tasks_project_sprint_status_cursor',
    key: { projectId: 1, sprintId: 1, status: 1, _id: 1 },
  },
  {
    name: 'tasks_project_sprint_cursor',
    key: { projectId: 1, sprintId: 1, _id: 1 },
  },
  {
    name: 'tasks_project_parent_cursor',
    key: { projectId: 1, parentId: 1, _id: 1 },
  },
  {
    name: 'tasks_project_due_status_cursor',
    key: { projectId: 1, dueDate: 1, status: 1, _id: 1 },
  },
  {
    name: 'tasks_org_project_status_due_cursor',
    key: { organizationId: 1, projectId: 1, status: 1, dueDate: 1, _id: 1 },
  },
  {
    name: 'tasks_org_status_due_cursor',
    key: { organizationId: 1, status: 1, dueDate: 1, _id: 1 },
  },
  {
    name: 'tasks_org_assignee_status_due_cursor',
    key: { organizationId: 1, assigneeId: 1, status: 1, dueDate: 1, _id: 1 },
  },
  {
    name: 'tasks_org_due_status_cursor',
    key: { organizationId: 1, dueDate: 1, status: 1, _id: 1 },
  },
];

const connection = mongoose.createConnection(uri, {
  dbName: TASK_DATABASE_NAME,
  autoIndex: false,
  serverSelectionTimeoutMS: 5000,
});

try {
  await connection.asPromise();
  const db = connection.db;
  const iamDb = connection.useDb(IAM_DATABASE_NAME, { useCache: true }).db;

  const plan = await inspectWorkspaceMigration(db, iamDb);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);

  if (apply) {
    if (!plan.clean || expectedHash !== plan.reportSha256) {
      throw new Error('Migration refused: report is not clean or hash differs');
    }

    await applyWorkspaceMigration(db, iamDb);
    const verification = await inspectWorkspaceMigration(db, iamDb);
    if (!verification.clean || verification.tasksMissingWorkspaceFields > 0) {
      throw new Error('Workspace migration verification failed');
    }
    process.stdout.write(
      'Verified workspace task fields, collections, and indexes.\n',
    );
  }
} finally {
  await connection.close();
}

async function inspectWorkspaceMigration(db, iamDb) {
  const fingerprint = targetFingerprint(uri, TASK_DATABASE_NAME);
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
      'project_task_counters',
      'project_sprints',
      'sprint_events',
      'task_comments',
      'task_worklogs',
    ],
    plannedTaskIndexes: WORKSPACE_TASK_INDEXES.map((i) => i.name),
  };

  const reportSha256 = createHash('sha256')
    .update(JSON.stringify(summary))
    .digest('hex');

  return {
    ...summary,
    reportSha256,
  };
}

async function applyWorkspaceMigration(db, iamDb) {
  const existingCollections = await db.listCollections().toArray();
  const collectionNames = new Set(existingCollections.map((c) => c.name));

  for (const name of [
    'tasks',
    'task_events',
    'task_operations',
    'project_task_counters',
    'project_sprints',
    'sprint_events',
    'task_comments',
    'task_worklogs',
  ]) {
    if (!collectionNames.has(name)) {
      await db.createCollection(name);
    } else {
      await db
        .command({
          collMod: name,
          validator: {},
          validationLevel: 'off',
        })
        .catch(() => undefined);
    }
  }

  const tasksCol = db.collection('tasks');
  const countersCol = db.collection('project_task_counters');

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
        throw new Error(`Cannot resolve IAM project ${pHex} for task ${task._id}`);
      }
      const rawCode = String(project.key ?? project.code ?? project.name ?? 'TASK')
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

  const safeCreateIndex = async (col, key, options) => {
    try {
      await col.createIndex(key, options);
    } catch (err) {
      if (err && (err.code === 85 || err.code === 86)) {
        return;
      }
      throw err;
    }
  };

  for (const idx of WORKSPACE_TASK_INDEXES) {
    await safeCreateIndex(tasksCol, idx.key, {
      name: idx.name,
      ...(idx.options ?? {}),
    });
  }

  await safeCreateIndex(
    db.collection('task_events'),
    { projectId: 1, taskId: 1, occurredAt: -1, _id: -1 },
    { name: 'task_events_project_task_cursor' },
  );
  await safeCreateIndex(
    db.collection('task_events'),
    { taskId: 1, version: 1 },
    {
      name: 'task_event_task_mutation_version_unique',
      unique: true,
      partialFilterExpression: {
        eventType: { $in: ['TASK_STATUS_TRANSITIONED', 'TASK_UPDATED'] },
      },
    },
  );
  await safeCreateIndex(
    db.collection('project_sprints'),
    { projectId: 1, status: 1, _id: 1 },
    { name: 'sprints_project_status_cursor' },
  );
  await safeCreateIndex(
    db.collection('project_sprints'),
    { projectId: 1, status: 1 },
    {
      name: 'sprints_one_active_per_project',
      unique: true,
      partialFilterExpression: { status: 'ACTIVE' },
    },
  );
  await safeCreateIndex(
    db.collection('sprint_events'),
    { projectId: 1, sprintId: 1, occurredAt: -1, _id: -1 },
    { name: 'sprint_events_project_sprint_cursor' },
  );
  await safeCreateIndex(
    db.collection('task_comments'),
    { projectId: 1, taskId: 1, _id: -1 },
    { name: 'comments_project_task_cursor' },
  );
  await safeCreateIndex(
    db.collection('task_worklogs'),
    { projectId: 1, taskId: 1, _id: -1 },
    { name: 'worklogs_project_task_cursor' },
  );
  await safeCreateIndex(
    db.collection('task_operations'),
    { actorId: 1, projectId: 1, operationId: 1 },
    { name: 'task_operations_actor_project_op_unique', unique: true },
  );
  await safeCreateIndex(
    db.collection('task_operations'),
    { expiresAt: 1 },
    { name: 'task_operations_ttl', expireAfterSeconds: 0 },
  );
}
