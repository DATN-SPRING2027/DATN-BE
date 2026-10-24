import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFICATION_DATABASE_NAME,
  NOTIFICATION_REQUEST_FLOW_INDEXES,
  planNotificationRequestFlowIndexes,
} from './20261024-notification-request-flow-indexes.mjs';

function plan(overrides = {}) {
  return planNotificationRequestFlowIndexes({
    databaseName: NOTIFICATION_DATABASE_NAME,
    target: 'credential-free-target-fingerprint',
    objectType: 'collection',
    documentCount: 19,
    expiredDocumentCount: 0,
    duplicateEventKeyGroups: 0,
    indexes: [
      { name: '_id_', key: { _id: 1 } },
      {
        name: 'recipientUserId_1_isRead_1_createdAt_1',
        key: { recipientUserId: 1, isRead: 1, createdAt: 1 },
      },
    ],
    ...overrides,
  });
}

test('plans only the missing persistence indexes', () => {
  const result = plan();
  assert.equal(result.clean, true);
  assert.equal(result.documentCount, 19);
  assert.deepEqual(
    result.desiredIndexes.map(({ name, action }) => ({ name, action })),
    NOTIFICATION_REQUEST_FLOW_INDEXES.map(({ name }) => ({
      name,
      action:
        name === 'recipientUserId_1_isRead_1_createdAt_1' ? 'NOOP' : 'CREATE',
    })),
  );
});

test('blocks an index with matching key but unexpected options', () => {
  const result = plan({
    indexes: [
      {
        name: 'recipientUserId_1_isRead_1_createdAt_1',
        key: { recipientUserId: 1, isRead: 1, createdAt: 1 },
        unique: true,
      },
    ],
  });
  assert.equal(result.clean, false);
  assert.equal(result.desiredIndexes[0].action, 'BLOCK');
});

test('blocks unsafe TTL, duplicate-key, database, and collection states', () => {
  assert.equal(plan({ expiredDocumentCount: 1 }).clean, false);
  assert.equal(plan({ duplicateEventKeyGroups: 1 }).clean, false);
  assert.equal(plan({ databaseName: 'continuum_iam' }).clean, false);
  assert.equal(plan({ objectType: null }).clean, false);
});

test('accepts the exact declared indexes as a no-op', () => {
  const result = plan({
    indexes: NOTIFICATION_REQUEST_FLOW_INDEXES.map((index) => ({ ...index })),
  });
  assert.equal(result.clean, true);
  assert.ok(result.desiredIndexes.every((index) => index.action === 'NOOP'));
});
