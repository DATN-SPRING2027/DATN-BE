import { createHash } from 'node:crypto';

export const PLATFORM_REQUEST_TRACE_INDEXES = Object.freeze([
  Object.freeze({
    name: 'platform_audit_request_id_trace',
    key: Object.freeze({ requestId: 1, occurredAt: 1, _id: 1 }),
  }),
  Object.freeze({
    name: 'platform_audit_correlation_id_trace',
    key: Object.freeze({ correlationId: 1, occurredAt: 1, _id: 1 }),
  }),
]);

const collectionName = 'audit_logs_iam';
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
    !actual.unique &&
    !actual.sparse &&
    actual.expireAfterSeconds === undefined &&
    hash(actual.partialFilterExpression ?? null) === hash(null) &&
    (!actual.collation || actual.collation.locale === 'simple')
  );
}

export function planPlatformRequestTraceIndexes(snapshot, options = {}) {
  const rollback = options.rollback === true;
  const issues = [];
  const state = snapshot.collection ?? { objectType: null, indexes: [] };
  const indexes = Array.isArray(state.indexes) ? state.indexes : [];
  const desiredIndexes = [];

  if (state.objectType !== 'collection')
    issues.push('AUDIT_COLLECTION_MISSING_OR_INVALID');

  for (const desired of PLATFORM_REQUEST_TRACE_INDEXES) {
    const named = indexes.find((index) => index.name === desired.name);
    const equivalent = indexes.find((index) => sameIndex(index, desired));
    let action;
    if (rollback) {
      if (!named) action = 'SKIP';
      else if (sameIndex(named, desired)) action = 'DROP';
      else {
        action = 'CONFLICT';
        issues.push(`INDEX_CONFLICT:${desired.name}`);
      }
    } else if (named && sameIndex(named, desired)) action = 'KEEP';
    else if (named || equivalent) {
      action = 'CONFLICT';
      issues.push(`INDEX_CONFLICT:${desired.name}`);
    } else action = 'CREATE';
    desiredIndexes.push({ ...desired, action });
  }

  const plan = {
    migration: 'platform-request-trace-index-v1',
    databaseName: snapshot.databaseName,
    targetFingerprint: snapshot.targetFingerprint,
    collection: {
      name: collectionName,
      objectType: state.objectType ?? null,
      documentCount: Number.isSafeInteger(state.documentCount)
        ? state.documentCount
        : null,
      indexNames: indexes.map((index) => index.name).sort(),
    },
    rollback,
    clean: issues.length === 0,
    issues: [...new Set(issues)].sort(),
    desiredIndexes,
    dropCollections: [],
    dropDocuments: false,
  };
  return { ...plan, reportSha256: hash(plan) };
}
