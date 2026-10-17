import assert from 'node:assert/strict';
import test from 'node:test';
import {
  planPlatformIncidentStorage,
  PLATFORM_INCIDENT_INDEXES,
} from './platform-incidents.plan.mjs';

const emptySnapshot = () => ({
  databaseName: 'continuum_iam_fixture',
  targetFingerprint: 'f'.repeat(64),
  collections: Object.fromEntries(
    [
      'platform_incidents',
      'platform_incident_history',
      'platform_incident_operations',
    ].map((name) => [
      name,
      { objectType: null, documentCount: 0, indexes: [], duplicateKeys: 0 },
    ]),
  ),
});

const installedSnapshot = () => {
  const snapshot = emptySnapshot();
  for (const index of PLATFORM_INCIDENT_INDEXES) {
    const collection = snapshot.collections[index.collection];
    collection.objectType = 'collection';
    collection.indexes.push({
      name: index.name,
      key: index.key,
      unique: index.unique ?? false,
      partialFilterExpression: index.partialFilterExpression,
    });
  }
  return snapshot;
};

test('plans additive collections and indexes without changing the snapshot', () => {
  const snapshot = emptySnapshot();
  const before = structuredClone(snapshot);
  const plan = planPlatformIncidentStorage(snapshot);
  assert.equal(plan.clean, true);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(plan.createCollections, [
    'platform_incidents',
    'platform_incident_history',
    'platform_incident_operations',
  ]);
  assert.equal(
    plan.desiredIndexes.filter((index) => index.action === 'CREATE').length,
    5,
  );
});

test('accepts the exact installed schema and emits an idempotent plan', () => {
  const plan = planPlatformIncidentStorage(installedSnapshot());
  assert.equal(plan.clean, true);
  assert.deepEqual(plan.createCollections, []);
  assert.equal(
    plan.desiredIndexes.every((index) => index.action === 'KEEP'),
    true,
  );
});

test('blocks collection name collisions and duplicate idempotency keys', () => {
  const collision = emptySnapshot();
  collision.collections.platform_incidents.objectType = 'view';
  assert.ok(
    planPlatformIncidentStorage(collision).issues.includes(
      'COLLECTION_TYPE_CONFLICT:platform_incidents',
    ),
  );

  const duplicate = emptySnapshot();
  duplicate.collections.platform_incident_operations.duplicateKeys = 2;
  assert.ok(
    planPlatformIncidentStorage(duplicate).issues.includes(
      'DUPLICATE_KEYS:platform_incident_operations:platform_incident_operation_key',
    ),
  );
});

test('blocks incompatible same-name indexes before apply', () => {
  const snapshot = installedSnapshot();
  snapshot.collections.platform_incidents.indexes[0].key = { status: 1 };
  assert.ok(
    planPlatformIncidentStorage(snapshot).issues.includes(
      'INDEX_CONFLICT:platform_incidents:platform_incident_status_list',
    ),
  );
});

test('rollback drops only named incident indexes and preserves collections', () => {
  const plan = planPlatformIncidentStorage(installedSnapshot(), {
    rollback: true,
  });
  assert.equal(plan.clean, true);
  assert.deepEqual(plan.dropCollections, []);
  assert.equal(
    plan.desiredIndexes.every((index) => index.action === 'DROP'),
    true,
  );
});

test('report hash binds target, duplicate evidence and existing index state', () => {
  const snapshot = emptySnapshot();
  const first = planPlatformIncidentStorage(snapshot);
  assert.notEqual(
    first.reportSha256,
    planPlatformIncidentStorage({
      ...snapshot,
      targetFingerprint: 'a'.repeat(64),
    }).reportSha256,
  );
  snapshot.collections.platform_incident_operations.duplicateKeys = 1;
  assert.notEqual(
    first.reportSha256,
    planPlatformIncidentStorage(snapshot).reportSha256,
  );
});
