import assert from 'node:assert/strict';
import test from 'node:test';
import {
  planPlatformRequestTraceIndexes,
  PLATFORM_REQUEST_TRACE_INDEXES,
} from './platform-request-trace-index.plan.mjs';

const emptySnapshot = () => ({
  databaseName: 'continuum_audit_fixture',
  targetFingerprint: 'f'.repeat(64),
  collection: { objectType: 'collection', documentCount: 7, indexes: [] },
});

const installedSnapshot = () => {
  const snapshot = emptySnapshot();
  snapshot.collection.indexes = PLATFORM_REQUEST_TRACE_INDEXES.map((index) => ({
    name: index.name,
    key: index.key,
    unique: false,
  }));
  return snapshot;
};

test('plans only additive trace lookup indexes and preserves audit documents', () => {
  const snapshot = emptySnapshot();
  const before = structuredClone(snapshot);
  const plan = planPlatformRequestTraceIndexes(snapshot);
  assert.equal(plan.clean, true);
  assert.deepEqual(snapshot, before);
  assert.equal(plan.collection.documentCount, 7);
  assert.equal(
    plan.desiredIndexes.filter((index) => index.action === 'CREATE').length,
    2,
  );
  assert.deepEqual(plan.dropCollections, []);
  assert.equal(plan.dropDocuments, false);
});

test('emits an idempotent KEEP plan after both indexes are installed', () => {
  const plan = planPlatformRequestTraceIndexes(installedSnapshot());
  assert.equal(plan.clean, true);
  assert.equal(
    plan.desiredIndexes.every((index) => index.action === 'KEEP'),
    true,
  );
});

test('blocks when the owner audit collection is missing or not a collection', () => {
  const missing = emptySnapshot();
  missing.collection.objectType = null;
  assert.ok(
    planPlatformRequestTraceIndexes(missing).issues.includes(
      'AUDIT_COLLECTION_MISSING_OR_INVALID',
    ),
  );
  const view = emptySnapshot();
  view.collection.objectType = 'view';
  assert.ok(
    planPlatformRequestTraceIndexes(view).issues.includes(
      'AUDIT_COLLECTION_MISSING_OR_INVALID',
    ),
  );
});

test('blocks conflicting named or equivalent indexes before applying', () => {
  const namedConflict = installedSnapshot();
  namedConflict.collection.indexes[0].key = { requestId: 1 };
  assert.ok(
    planPlatformRequestTraceIndexes(namedConflict).issues.includes(
      'INDEX_CONFLICT:platform_audit_request_id_trace',
    ),
  );
  const equivalentConflict = emptySnapshot();
  equivalentConflict.collection.indexes.push({
    name: 'existing_request_trace',
    key: PLATFORM_REQUEST_TRACE_INDEXES[0].key,
    unique: false,
  });
  assert.ok(
    planPlatformRequestTraceIndexes(equivalentConflict).issues.includes(
      'INDEX_CONFLICT:platform_audit_request_id_trace',
    ),
  );
});

test('rollback drops only exact named indexes and never drops collections or records', () => {
  const plan = planPlatformRequestTraceIndexes(installedSnapshot(), {
    rollback: true,
  });
  assert.equal(plan.clean, true);
  assert.equal(
    plan.desiredIndexes.every((index) => index.action === 'DROP'),
    true,
  );
  assert.deepEqual(plan.dropCollections, []);
  assert.equal(plan.dropDocuments, false);
});

test('report hash binds target and current index evidence', () => {
  const snapshot = emptySnapshot();
  const first = planPlatformRequestTraceIndexes(snapshot);
  assert.notEqual(
    first.reportSha256,
    planPlatformRequestTraceIndexes({
      ...snapshot,
      targetFingerprint: 'a'.repeat(64),
    }).reportSha256,
  );
  snapshot.collection.indexes.push({
    name: 'another_index',
    key: { occurredAt: 1 },
    unique: false,
  });
  assert.notEqual(
    first.reportSha256,
    planPlatformRequestTraceIndexes(snapshot).reportSha256,
  );
});
