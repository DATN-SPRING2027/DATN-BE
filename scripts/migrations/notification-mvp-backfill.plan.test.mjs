import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NOTIFICATION_MVP_INDEXES,
  NOTIFICATION_TTL_SECONDS,
  planNotificationMvpMigration,
} from './notification-mvp-backfill.plan.mjs';

const baseSnapshot = () => ({
  databaseName: 'continuum_notification',
  targetFingerprint: 'a'.repeat(64),
  collection: {
    objectType: 'collection',
    documentCount: 12,
    missingRecipientIdCount: 4,
    missingEventKeyCount: 4,
    duplicateEventKeysCount: 0,
    indexes: [
      {
        name: 'recipientUserId_1_isRead_1_createdAt_1',
        key: { recipientUserId: 1, isRead: 1, createdAt: 1 },
      },
    ],
  },
});

test('plans backfill of legacy recipientUserId/eventKey documents and 90-day TTL + MVP indexes', () => {
  const plan = planNotificationMvpMigration(baseSnapshot());
  assert.equal(plan.clean, true);
  assert.equal(plan.collection.backfill.missingRecipientIdCount, 4);
  assert.equal(plan.collection.backfill.missingEventKeyCount, 4);
  const ttlIndex = plan.desiredIndexes.find((i) => i.name === 'createdAt_1');
  assert.ok(ttlIndex);
  assert.equal(ttlIndex.expireAfterSeconds, NOTIFICATION_TTL_SECONDS);
  assert.equal(ttlIndex.action, 'CREATE');
  const legacyIndex = plan.desiredIndexes.find(
    (i) => i.name === 'recipientUserId_1_isRead_1_createdAt_1',
  );
  assert.equal(legacyIndex?.action, 'KEEP');
});

test('emits KEEP for all indexes once installed', () => {
  const snapshot = baseSnapshot();
  snapshot.collection.indexes = NOTIFICATION_MVP_INDEXES.map((idx) => ({
    ...idx,
  }));
  const plan = planNotificationMvpMigration(snapshot);
  assert.equal(plan.clean, true);
  assert.equal(
    plan.desiredIndexes.every((idx) => idx.action === 'KEEP'),
    true,
  );
});

test('blocks migration when duplicate (recipientId, eventKey) pairs exist', () => {
  const snapshot = baseSnapshot();
  snapshot.collection.duplicateEventKeysCount = 2;
  const plan = planNotificationMvpMigration(snapshot);
  assert.equal(plan.clean, false);
  assert.ok(plan.issues.includes('DUPLICATE_RECIPIENT_EVENT_KEYS'));
});

test('supports safe rollback of newly added MVP indexes while keeping legacy index and documents', () => {
  const snapshot = baseSnapshot();
  snapshot.collection.indexes = NOTIFICATION_MVP_INDEXES.map((idx) => ({
    ...idx,
  }));
  const plan = planNotificationMvpMigration(snapshot, { rollback: true });
  assert.equal(plan.clean, true);
  assert.equal(plan.dropDocuments, false);
  const legacyIndex = plan.desiredIndexes.find(
    (i) => i.name === 'recipientUserId_1_isRead_1_createdAt_1',
  );
  assert.equal(legacyIndex?.action, 'KEEP');
  const uniqueIdx = plan.desiredIndexes.find(
    (i) => i.name === 'recipientId_1_eventKey_1',
  );
  assert.equal(uniqueIdx?.action, 'DROP');
});
