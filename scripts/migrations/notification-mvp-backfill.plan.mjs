import { createHash } from 'node:crypto';

export const NOTIFICATION_TTL_SECONDS = 90 * 24 * 60 * 60;

export const NOTIFICATION_MVP_INDEXES = Object.freeze([
  Object.freeze({
    name: 'recipientUserId_1_isRead_1_createdAt_1',
    key: Object.freeze({ recipientUserId: 1, isRead: 1, createdAt: 1 }),
  }),
  Object.freeze({
    name: 'createdAt_1',
    key: Object.freeze({ createdAt: 1 }),
    expireAfterSeconds: NOTIFICATION_TTL_SECONDS,
  }),
  Object.freeze({
    name: 'recipientId_1_createdAt_-1',
    key: Object.freeze({ recipientId: 1, createdAt: -1 }),
  }),
  Object.freeze({
    name: 'recipientId_1_readAt_1',
    key: Object.freeze({ recipientId: 1, readAt: 1 }),
  }),
  Object.freeze({
    name: 'recipientId_1_eventKey_1',
    key: Object.freeze({ recipientId: 1, eventKey: 1 }),
    unique: true,
    sparse: true,
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
    Boolean(actual.sparse) === Boolean(desired.sparse) &&
    (actual.expireAfterSeconds ?? undefined) ===
      (desired.expireAfterSeconds ?? undefined)
  );
}

export function planNotificationMvpMigration(snapshot, options = {}) {
  const rollback = options.rollback === true;
  const issues = [];
  const state = snapshot.collection ?? {
    objectType: null,
    documentCount: 0,
    missingRecipientIdCount: 0,
    missingEventKeyCount: 0,
    duplicateEventKeysCount: 0,
    indexes: [],
  };
  const indexes = Array.isArray(state.indexes) ? state.indexes : [];

  if (snapshot.databaseName !== 'continuum_notification') {
    issues.push('NOTIFICATION_DATABASE_NAME_MISMATCH');
  }
  if (state.objectType !== 'collection') {
    issues.push('NOTIFICATIONS_COLLECTION_MISSING_OR_INVALID');
  }
  if ((state.duplicateEventKeysCount ?? 0) > 0 && !rollback) {
    issues.push('DUPLICATE_RECIPIENT_EVENT_KEYS');
  }

  const desiredIndexes = [];
  const legacyOnlyIndexName = 'recipientUserId_1_isRead_1_createdAt_1';

  for (const desired of NOTIFICATION_MVP_INDEXES) {
    const named = indexes.find((idx) => idx.name === desired.name);
    const equivalent = indexes.find((idx) => sameIndex(idx, desired));
    let action;

    if (rollback) {
      if (desired.name === legacyOnlyIndexName) {
        action = named ? 'KEEP' : 'CREATE';
      } else if (!named) {
        action = 'SKIP';
      } else if (sameIndex(named, desired)) {
        action = 'DROP';
      } else {
        action = 'CONFLICT';
        issues.push(`INDEX_CONFLICT:${desired.name}`);
      }
    } else if (named && sameIndex(named, desired)) {
      action = 'KEEP';
    } else if (named || equivalent) {
      action = 'CONFLICT';
      issues.push(`INDEX_CONFLICT:${desired.name}`);
    } else {
      action = 'CREATE';
    }

    desiredIndexes.push({ ...desired, action });
  }

  const plan = {
    migration: 'notification-mvp-backfill-v1',
    databaseName: snapshot.databaseName,
    targetFingerprint: snapshot.targetFingerprint,
    collection: {
      name: 'notifications',
      objectType: state.objectType ?? null,
      documentCount: state.documentCount ?? 0,
      backfill: {
        missingRecipientIdCount: state.missingRecipientIdCount ?? 0,
        missingEventKeyCount: state.missingEventKeyCount ?? 0,
      },
      indexNames: indexes.map((idx) => idx.name).sort(),
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
