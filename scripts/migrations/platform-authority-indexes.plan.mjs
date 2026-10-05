export const PLATFORM_AUTHORITY_INDEXES = [
  {
    key: { subjectUserId: 1, permission: 1, scope: 1 },
    name: 'subjectUserId_1_permission_1_scope_1',
    unique: true,
  },
  {
    key: { subjectUserId: 1, status: 1, permission: 1 },
    name: 'subjectUserId_1_status_1_permission_1',
    unique: false,
  },
];

const sameKey = (left, right) =>
  JSON.stringify(Object.entries(left ?? {})) ===
  JSON.stringify(Object.entries(right));

export function planPlatformAuthorityIndexes({
  databaseName,
  targetFingerprint,
  collectionExists,
  objectType,
  documentCount,
  duplicateAssignments,
  invalidRecords,
  indexes,
}) {
  const desiredIndexes = PLATFORM_AUTHORITY_INDEXES.map((desired) => {
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
  });
  const supportedObject = objectType === null || objectType === 'collection';
  const clean =
    supportedObject &&
    duplicateAssignments.length === 0 &&
    invalidRecords.length === 0 &&
    desiredIndexes.every((index) => index.action !== 'CONFLICT');

  return {
    migration: 'platform-authority-assignments-v1',
    databaseName,
    targetFingerprint,
    collectionName: 'platform_authority_assignments',
    collectionExists,
    objectType,
    documentCount,
    duplicateAssignments,
    invalidRecords,
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
