import { createHash } from 'node:crypto';

export const EMAIL_REGISTRATION_OUTBOX_DATABASE = 'continuum_iam';
export const EMAIL_REGISTRATION_OUTBOX_COLLECTION = 'email_registration_outbox';
export const EMAIL_REGISTRATION_OUTBOX_INDEXES = [
  {
    key: { normalizedEmail: 1 },
    name: 'email_registration_current_email',
    unique: true,
  },
  {
    key: { tokenHash: 1 },
    name: 'email_registration_token_hash',
    unique: true,
  },
  {
    key: { expiresAt: 1 },
    name: 'email_registration_expiry',
    expireAfterSeconds: 0,
  },
  {
    key: { deliveryStatus: 1, nextAttemptAt: 1, expiresAt: 1, createdAt: 1 },
    name: 'email_registration_pending_jobs',
  },
  {
    key: { deliveryStatus: 1, leaseUntil: 1, expiresAt: 1, createdAt: 1 },
    name: 'email_registration_expired_leases',
  },
];

export function hashEmailRegistrationOutboxReport(report) {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

export function planEmailRegistrationOutboxIndexes({
  targetFingerprint,
  collectionExists,
  objectType,
  documentCount,
  malformedDocumentCount,
  duplicateEmailGroups,
  duplicateTokenHashGroups,
  indexes,
}) {
  const desiredIndexes = EMAIL_REGISTRATION_OUTBOX_INDEXES.map((desired) => {
    const byName = indexes.find((current) => current.name === desired.name);
    const sameKey = indexes.find((current) => hasSameKey(current.key, desired.key));
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
    duplicateEmailGroups === 0 &&
    duplicateTokenHashGroups === 0 &&
    desiredIndexes.every((index) => index.action !== 'CONFLICT');
  return {
    migration: 'email-registration-outbox-v1',
    databaseName: EMAIL_REGISTRATION_OUTBOX_DATABASE,
    targetFingerprint,
    collectionName: EMAIL_REGISTRATION_OUTBOX_COLLECTION,
    collectionExists,
    objectType,
    documentCount,
    malformedDocumentCount,
    duplicateEmailGroups,
    duplicateTokenHashGroups,
    desiredIndexes,
    clean,
    action: !clean
      ? 'BLOCKED'
      : !collectionExists
        ? 'CREATE_COLLECTION_AND_INDEXES'
        : desiredIndexes.some((index) => index.action === 'CREATE')
          ? 'CREATE_INDEXES'
          : 'NOOP',
  };
}

export function isExactEmailRegistrationOutboxIndex(current, desired) {
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
  return JSON.stringify(Object.entries(left ?? {})) ===
    JSON.stringify(Object.entries(right ?? {}));
}
