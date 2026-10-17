import { createHash } from 'node:crypto';

export const PLATFORM_INCIDENT_COLLECTIONS = Object.freeze([
  'platform_incidents',
  'platform_incident_history',
  'platform_incident_operations',
]);

export const PLATFORM_INCIDENT_INDEXES = Object.freeze([
  Object.freeze({
    collection: 'platform_incidents',
    name: 'platform_incident_status_list',
    key: Object.freeze({ status: 1, updatedAt: -1, _id: -1 }),
  }),
  Object.freeze({
    collection: 'platform_incidents',
    name: 'platform_incident_service_status_list',
    key: Object.freeze({
      affectedServiceId: 1,
      status: 1,
      updatedAt: -1,
      _id: -1,
    }),
  }),
  Object.freeze({
    collection: 'platform_incident_history',
    name: 'platform_incident_history_order',
    key: Object.freeze({ incidentId: 1, occurredAt: 1, _id: 1 }),
  }),
  Object.freeze({
    collection: 'platform_incident_operations',
    name: 'platform_incident_operation_key',
    key: Object.freeze({ actorUserId: 1, idempotencyKeyHash: 1 }),
    unique: true,
  }),
  Object.freeze({
    collection: 'platform_incident_operations',
    name: 'platform_incident_operation_history',
    key: Object.freeze({ incidentId: 1, committedAt: -1 }),
  }),
]);

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;

const hash = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

function sameIndex(actual, desired) {
  return (
    hash(actual.key) === hash(desired.key) &&
    Boolean(actual.unique) === Boolean(desired.unique) &&
    !actual.sparse &&
    actual.expireAfterSeconds === undefined &&
    hash(actual.partialFilterExpression ?? null) === hash(null) &&
    (!actual.collation || actual.collation.locale === 'simple')
  );
}

export function planPlatformIncidentStorage(snapshot, options = {}) {
  const rollback = options.rollback === true;
  const issues = [];
  const createCollections = [];
  const desiredIndexes = [];
  const collectionEvidence = {};

  for (const collection of PLATFORM_INCIDENT_COLLECTIONS) {
    const state = snapshot.collections?.[collection] ?? {
      objectType: null,
      documentCount: 0,
      indexes: [],
      duplicateKeys: 0,
    };
    const indexes = Array.isArray(state.indexes) ? state.indexes : [];
    if (state.objectType !== null && state.objectType !== 'collection') {
      issues.push(`COLLECTION_TYPE_CONFLICT:${collection}`);
    } else if (!rollback && state.objectType === null) {
      createCollections.push(collection);
    }
    if (
      !Number.isSafeInteger(state.documentCount) ||
      state.documentCount < 0 ||
      !Number.isSafeInteger(state.duplicateKeys) ||
      state.duplicateKeys < 0
    ) {
      issues.push(`INVALID_INSPECTION:${collection}`);
    }
    collectionEvidence[collection] = {
      objectType: state.objectType ?? null,
      documentCount: Number.isSafeInteger(state.documentCount)
        ? state.documentCount
        : null,
      indexNames: indexes.map((index) => index.name).sort(),
    };

    for (const desired of PLATFORM_INCIDENT_INDEXES.filter(
      (index) => index.collection === collection,
    )) {
      const named = indexes.find((index) => index.name === desired.name);
      const equivalent = indexes.find((index) => sameIndex(index, desired));
      let action;
      if (rollback) {
        if (!named) action = 'SKIP';
        else if (sameIndex(named, desired)) action = 'DROP';
        else {
          action = 'CONFLICT';
          issues.push(`INDEX_CONFLICT:${collection}:${desired.name}`);
        }
      } else if (named && sameIndex(named, desired)) action = 'KEEP';
      else if (named || equivalent) {
        action = 'CONFLICT';
        issues.push(`INDEX_CONFLICT:${collection}:${desired.name}`);
      } else action = 'CREATE';

      if (!rollback && desired.unique && state.duplicateKeys > 0) {
        issues.push(`DUPLICATE_KEYS:${collection}:${desired.name}`);
      }
      desiredIndexes.push({ ...desired, action });
    }
  }

  const plan = {
    migration: 'platform-incidents-storage-v1',
    databaseName: snapshot.databaseName,
    targetFingerprint: snapshot.targetFingerprint,
    rollback,
    clean: issues.length === 0,
    issues: [...new Set(issues)].sort(),
    collections: collectionEvidence,
    createCollections,
    dropCollections: [],
    desiredIndexes,
  };
  return {
    ...plan,
    reportSha256: hash(plan),
  };
}
