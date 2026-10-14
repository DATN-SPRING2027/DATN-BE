import { createHash } from 'node:crypto';

export const PASSWORD_RESET_OUTBOX_DATABASE = 'continuum_iam';
export const PASSWORD_RESET_OUTBOX_COLLECTION = 'password_reset_outbox';
export const PASSWORD_RESET_OUTBOX_INDEXES = [
  {
    key: { userScopeHash: 1 },
    name: 'password_reset_current_scope',
    unique: true,
  },
  {
    key: { tokenHash: 1 },
    name: 'password_reset_token_hash',
    unique: true,
  },
  {
    key: { expiresAt: 1 },
    name: 'password_reset_expiry',
    expireAfterSeconds: 0,
  },
  {
    key: { deliveryStatus: 1, nextAttemptAt: 1, expiresAt: 1, createdAt: 1 },
    name: 'password_reset_pending_jobs',
  },
  {
    key: { deliveryStatus: 1, leaseUntil: 1, expiresAt: 1, createdAt: 1 },
    name: 'password_reset_expired_leases',
  },
];

export function hashPasswordResetOutboxReport(report) {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

export function planPasswordResetOutboxIndexes({
  targetFingerprint,
  collectionExists,
  objectType,
  documentCount,
  malformedDocumentCount,
  duplicateUserScopeGroups,
  duplicateTokenHashGroups,
  indexes,
}) {
  const desiredIndexes = PASSWORD_RESET_OUTBOX_INDEXES.map((desired) => {
    const byName = indexes.find((current) => current.name === desired.name);
    const sameKey = indexes.find((current) =>
      hasSameKey(current.key, desired.key),
    );
    const exact = sameKey && isExactIndex(sameKey, desired);
    const conflictingName = byName && !hasSameKey(byName.key, desired.key);
    return {
      ...desired,
      action:
        conflictingName || (sameKey && !exact)
          ? 'CONFLICT'
          : exact
            ? 'NOOP'
            : 'CREATE',
    };
  });
  const supportedObject = objectType === null || objectType === 'collection';
  const clean =
    supportedObject &&
    malformedDocumentCount === 0 &&
    duplicateUserScopeGroups === 0 &&
    duplicateTokenHashGroups === 0 &&
    desiredIndexes.every((index) => index.action !== 'CONFLICT');
  const action = !clean
    ? 'BLOCKED'
    : !collectionExists
      ? 'CREATE_COLLECTION_AND_INDEXES'
      : desiredIndexes.some((index) => index.action === 'CREATE')
        ? 'CREATE_INDEXES'
        : 'NOOP';
  return {
    migration: 'password-reset-outbox-v1',
    databaseName: PASSWORD_RESET_OUTBOX_DATABASE,
    targetFingerprint,
    collectionName: PASSWORD_RESET_OUTBOX_COLLECTION,
    collectionExists,
    objectType,
    documentCount,
    malformedDocumentCount,
    duplicateUserScopeGroups,
    duplicateTokenHashGroups,
    desiredIndexes,
    clean,
    action,
  };
}

export function isExactPasswordResetOutboxIndex(current, desired) {
  return isExactIndex(current, desired);
}

function isExactIndex(current, desired) {
  return (
    current?.name === desired.name &&
    hasSameKey(current.key, desired.key) &&
    (current.unique === true) === (desired.unique === true) &&
    current.hidden !== true &&
    (current.expireAfterSeconds ?? undefined) ===
      (desired.expireAfterSeconds ?? undefined) &&
    current.sparse !== true &&
    current.partialFilterExpression === undefined
  );
}

function hasSameKey(left, right) {
  const entries = (value) => Object.entries(value ?? {});
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}
