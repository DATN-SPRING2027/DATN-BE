export const PLATFORM_AUTHORITY_CHANGE_OPERATIONS_INDEXES = [
  {
    key: { operationId: 1 },
    name: 'platform_authority_operation_id',
    unique: true,
  },
  {
    key: { targetUserId: 1, permission: 1, committedAt: -1 },
    name: 'platform_authority_operation_target',
    unique: false,
  },
  {
    key: { actorUserId: 1, committedAt: -1 },
    name: 'platform_authority_operation_actor',
    unique: false,
  },
];

const sameKey = (left, right) =>
  JSON.stringify(Object.entries(left ?? {})) ===
  JSON.stringify(Object.entries(right));

export function planPlatformAuthorityChangeOperations({
  databaseName,
  targetFingerprint,
  collectionExists,
  objectType,
  documentCount,
  duplicateOperations = [],
  invalidRecords = [],
  indexes = [],
}) {
  const desiredIndexes = PLATFORM_AUTHORITY_CHANGE_OPERATIONS_INDEXES.map(
    (desired) => {
      const sameKeyIndex = indexes.find((index) =>
        sameKey(index.key, desired.key),
      );
      const valid = sameKeyIndex
        ? sameKeyIndex.name === desired.name &&
          (sameKeyIndex.unique === true) === desired.unique &&
          sameKeyIndex.sparse !== true &&
          sameKeyIndex.partialFilterExpression === undefined &&
          sameKeyIndex.expireAfterSeconds === undefined &&
          (sameKeyIndex.collation === undefined ||
            (sameKeyIndex.collation.locale === 'simple' &&
              Object.keys(sameKeyIndex.collation).length === 1))
        : true;
      return {
        key: desired.key,
        name: desired.name,
        unique: desired.unique,
        action: !sameKeyIndex ? 'CREATE' : valid ? 'NOOP' : 'CONFLICT',
      };
    },
  );

  const supportedObject = objectType === null || objectType === 'collection';
  const clean =
    supportedObject &&
    duplicateOperations.length === 0 &&
    invalidRecords.length === 0 &&
    desiredIndexes.every((index) => index.action !== 'CONFLICT');

  return {
    migration: 'platform-authority-change-operations-v1',
    databaseName,
    targetFingerprint,
    collectionName: 'platform_authority_change_operations',
    collectionExists,
    objectType,
    documentCount,
    duplicateOperationCount: duplicateOperations.length,
    duplicateOperations: duplicateOperations.map(({ count }) => ({ count })),
    invalidRecordCount: invalidRecords.length,
    invalidRecords: invalidRecords.map(({ reason }) => ({
      reason: reason ?? 'invalid-operation-record',
    })),
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
