import { createHash } from 'node:crypto';

export const TASK_LIFECYCLE_INDEXES = {
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
};

const LEGACY_TASK_EVENT_INDEX = {
  key: { taskId: 1, taskVersion: 1 },
  name: 'task_event_task_version_unique',
  unique: true,
};

export function planTaskLifecycleContract(snapshot) {
  const issues = [];
  const taskEvents = snapshot.collections.task_events;
  const taskOperations = snapshot.collections.task_operations;

  if (snapshot.databaseName !== 'continuum_task')
    issues.push('TASK_DATABASE_NAME_MISMATCH');
  if (snapshot.collections.tasks?.objectType !== 'collection')
    issues.push('TASK_COLLECTION_MISSING_OR_INVALID');
  if (taskEvents?.objectType !== 'collection')
    issues.push('TASK_EVENT_COLLECTION_MISSING_OR_INVALID');
  if (
    taskOperations?.objectType !== null &&
    taskOperations?.objectType !== undefined &&
    taskOperations.objectType !== 'collection'
  )
    issues.push('TASK_OPERATION_COLLECTION_INVALID');
  if (snapshot.tasks.invalidDocuments > 0)
    issues.push('TASK_DOCUMENTS_INVALID');
  if (snapshot.taskEvents.invalidDocuments > 0)
    issues.push('TASK_EVENT_DOCUMENTS_INVALID');
  if (snapshot.taskOperations.invalidDocuments > 0)
    issues.push('TASK_OPERATION_DOCUMENTS_INVALID');
  if (snapshot.taskEvents.duplicateCreationVersions > 0)
    issues.push('DUPLICATE_TASK_CREATION_EVENT_VERSIONS');
  if (snapshot.taskEvents.duplicateMutationVersions > 0)
    issues.push('DUPLICATE_TASK_MUTATION_EVENT_VERSIONS');
  if (snapshot.taskOperations.duplicateKeys > 0)
    issues.push('DUPLICATE_TASK_OPERATION_KEYS');

  const legacyEventIndex = (taskEvents?.indexes ?? []).find(
    ({ name }) => name === LEGACY_TASK_EVENT_INDEX.name,
  );
  let legacyEventIndexAction = 'KEEP_ABSENT';
  if (legacyEventIndex) {
    if (!sameIndex(legacyEventIndex, LEGACY_TASK_EVENT_INDEX)) {
      issues.push('LEGACY_TASK_EVENT_INDEX_CONFLICT');
      legacyEventIndexAction = 'CONFLICT';
    } else {
      legacyEventIndexAction = 'DROP_EXACT_LEGACY_INDEX';
    }
  }
  const taskEventIndexes = planIndexes(
    (taskEvents?.indexes ?? []).filter(
      ({ name }) =>
        !(
          name === LEGACY_TASK_EVENT_INDEX.name &&
          legacyEventIndexAction === 'DROP_EXACT_LEGACY_INDEX'
        ),
    ),
    TASK_LIFECYCLE_INDEXES.task_events,
    'task_events',
    issues,
  );
  const taskOperationIndexes = planIndexes(
    taskOperations?.indexes ?? [],
    TASK_LIFECYCLE_INDEXES.task_operations,
    'task_operations',
    issues,
  );

  const report = {
    databaseName: snapshot.databaseName,
    targetFingerprint: snapshot.targetFingerprint,
    collections: {
      tasks: snapshot.collections.tasks?.objectType ?? null,
      task_events: taskEvents?.objectType ?? null,
      task_operations: taskOperations?.objectType ?? null,
    },
    taskCount: snapshot.tasks.count,
    tasksToBackfill: {
      status: snapshot.tasks.missingStatus,
      assigneeId: snapshot.tasks.missingAssigneeId,
      completedAt: snapshot.tasks.missingCompletedAt,
    },
    invalidTaskDocuments: snapshot.tasks.invalidDocuments,
    invalidTaskEventDocuments: snapshot.taskEvents.invalidDocuments,
    invalidTaskOperationDocuments: snapshot.taskOperations.invalidDocuments,
    eventCount: snapshot.taskEvents.count,
    operationCount: snapshot.taskOperations.count,
    legacyEventIndexAction,
    taskEventIndexes,
    taskOperationIndexes,
    duplicateCreationVersions: snapshot.taskEvents.duplicateCreationVersions,
    duplicateMutationVersions: snapshot.taskEvents.duplicateMutationVersions,
    duplicateOperationKeys: snapshot.taskOperations.duplicateKeys,
    issues: [...new Set(issues)].sort(),
    preservesTaskAndEventDocuments: true,
    clean: issues.length === 0,
  };
  const reportSha256 = createHash('sha256')
    .update(JSON.stringify(report))
    .digest('hex');
  return { ...report, reportSha256 };
}

function planIndexes(existingIndexes, desiredIndexes, collectionName, issues) {
  return desiredIndexes.map((desired) => {
    const named = existingIndexes.find(({ name }) => name === desired.name);
    if (named) {
      if (!sameIndex(named, desired)) {
        issues.push(`INDEX_CONFLICT:${collectionName}:${desired.name}`);
        return { ...desired, action: 'CONFLICT' };
      }
      return { ...desired, action: 'KEEP' };
    }

    const sameKeyIndex = existingIndexes.find((candidate) =>
      sameKey(candidate.key, desired.key),
    );
    if (sameKeyIndex) {
      issues.push(`SAME_KEY_INDEX_CONFLICT:${collectionName}:${desired.name}`);
      return { ...desired, action: 'CONFLICT' };
    }
    return { ...desired, action: 'CREATE' };
  });
}

function sameIndex(actual, expected) {
  return (
    actual.name === expected.name &&
    sameKey(actual.key, expected.key) &&
    sameOptions(actual, expected)
  );
}

function sameKey(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function sameOptions(actual, expected) {
  return (
    Boolean(actual.unique) === Boolean(expected.unique) &&
    Boolean(actual.sparse) === Boolean(expected.sparse) &&
    Boolean(actual.hidden) === Boolean(expected.hidden) &&
    (actual.expireAfterSeconds ?? null) ===
      (expected.expireAfterSeconds ?? null) &&
    JSON.stringify(actual.partialFilterExpression ?? null) ===
      JSON.stringify(expected.partialFilterExpression ?? null) &&
    normalizedCollation(actual.collation) ===
      normalizedCollation(expected.collation)
  );
}

function normalizedCollation(collation) {
  if (!collation || collation.locale === 'simple') return null;
  const options = Object.fromEntries(
    Object.entries(collation)
      .filter(([key]) => key !== 'version')
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify(options);
}
