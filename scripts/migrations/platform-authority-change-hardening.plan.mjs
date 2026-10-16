export const PLATFORM_AUTHORITY_CHANGE_LOCKS = [
  'organization.create',
  'platform.health.read',
  'platform.audit.read',
].map((permission) => ({ permission, scope: 'PLATFORM' }));

const desiredIndexes = {
  operations: [
    {
      key: { expiresAt: 1 },
      name: 'platform_authority_operation_expiry',
      unique: false,
      expireAfterSeconds: 0,
    },
  ],
  locks: [
    {
      key: { permission: 1, scope: 1 },
      name: 'platform_authority_change_lock_key',
      unique: true,
    },
  ],
};

const sameKey = (left, right) =>
  JSON.stringify(Object.entries(left ?? {})) ===
  JSON.stringify(Object.entries(right));

function inspectIndexes(indexes, desired) {
  return desired.map((wanted) => {
    const existing = indexes.find((index) => sameKey(index.key, wanted.key));
    const valid = existing
      ? existing.name === wanted.name &&
        (existing.unique === true) === wanted.unique &&
        existing.sparse !== true &&
        existing.partialFilterExpression === undefined &&
        (existing.expireAfterSeconds ?? null) ===
          (wanted.expireAfterSeconds ?? null) &&
        (existing.collation === undefined ||
          (existing.collation.locale === 'simple' &&
            Object.keys(existing.collation).length === 1))
      : true;

    return {
      key: wanted.key,
      name: wanted.name,
      unique: wanted.unique,
      ...(wanted.expireAfterSeconds === undefined
        ? {}
        : { expireAfterSeconds: wanted.expireAfterSeconds }),
      action: !existing ? 'CREATE' : valid ? 'NOOP' : 'CONFLICT',
    };
  });
}

export function planPlatformAuthorityChangeHardening({
  databaseName,
  targetFingerprint,
  operations = {},
  locks = {},
}) {
  const operationIndexes = inspectIndexes(
    operations.indexes ?? [],
    desiredIndexes.operations,
  );
  const lockIndexes = inspectIndexes(locks.indexes ?? [], desiredIndexes.locks);
  const expectedLockKeys = PLATFORM_AUTHORITY_CHANGE_LOCKS.map(
    ({ permission, scope }) => `${scope}:${permission}`,
  );
  const presentLockKeys = new Set(locks.validLockKeys ?? []);
  const missingLockKeys = expectedLockKeys.filter(
    (key) => !presentLockKeys.has(key),
  );
  const operationObjectSupported = operations.objectType === 'collection';
  const lockObjectSupported =
    locks.objectType === null || locks.objectType === 'collection';
  const clean =
    operationObjectSupported &&
    lockObjectSupported &&
    (locks.duplicateLockPairs ?? []).length === 0 &&
    (locks.invalidLockRows ?? []).length === 0 &&
    [...operationIndexes, ...lockIndexes].every(
      (index) => index.action !== 'CONFLICT',
    );
  const needsChanges =
    !locks.collectionExists ||
    operationIndexes.some((index) => index.action === 'CREATE') ||
    lockIndexes.some((index) => index.action === 'CREATE') ||
    missingLockKeys.length > 0;

  return {
    migration: 'platform-authority-change-hardening-v1',
    databaseName,
    targetFingerprint,
    operations: {
      collectionName: 'platform_authority_change_operations',
      collectionExists: Boolean(operations.collectionExists),
      objectType: operations.objectType ?? null,
      documentCount: operations.documentCount ?? 0,
      desiredIndexes: operationIndexes,
    },
    locks: {
      collectionName: 'platform_authority_change_locks',
      collectionExists: Boolean(locks.collectionExists),
      objectType: locks.objectType ?? null,
      documentCount: locks.documentCount ?? 0,
      desiredIndexes: lockIndexes,
      expectedLockKeys,
      missingLockKeys,
      duplicateLockPairs: locks.duplicateLockPairs ?? [],
      invalidLockRows: (locks.invalidLockRows ?? []).map(({ reason }) => ({
        reason,
      })),
    },
    clean,
    action: !clean ? 'BLOCKED' : needsChanges ? 'APPLY_HARDENING' : 'NOOP',
  };
}
