export const PLATFORM_OPERATOR_V1_EXPANSION_INDEX = {
  key: {
    subjectUserId: 1,
    scope: 1,
    provenanceOperationId: 1,
    permission: 1,
  },
  name: 'platform_authority_snapshot_provenance',
  unique: false,
};

const sameKey = (left, right) =>
  JSON.stringify(Object.entries(left ?? {})) ===
  JSON.stringify(Object.entries(right));

export function planPlatformOperatorV1ExpansionIndex({
  databaseName,
  targetFingerprint,
  collectionExists,
  objectType,
  documentCount,
  indexes,
}) {
  const sameKeyIndex = indexes.find((index) =>
    sameKey(index.key, PLATFORM_OPERATOR_V1_EXPANSION_INDEX.key),
  );
  const valid = sameKeyIndex
    ? sameKeyIndex.name === PLATFORM_OPERATOR_V1_EXPANSION_INDEX.name &&
      sameKeyIndex.unique !== true &&
      sameKeyIndex.sparse !== true &&
      sameKeyIndex.partialFilterExpression === undefined &&
      sameKeyIndex.expireAfterSeconds === undefined &&
      (sameKeyIndex.collation === undefined ||
        (sameKeyIndex.collation.locale === 'simple' &&
          Object.keys(sameKeyIndex.collation).length === 1))
    : true;
  const desiredIndex = {
    ...PLATFORM_OPERATOR_V1_EXPANSION_INDEX,
    action: !sameKeyIndex ? 'CREATE' : valid ? 'NOOP' : 'CONFLICT',
  };
  const supportedObject = objectType === null || objectType === 'collection';
  const clean = supportedObject && desiredIndex.action !== 'CONFLICT';

  return {
    migration: 'platform-operator-v1-expansion-index',
    databaseName,
    targetFingerprint,
    collectionName: 'platform_authority_assignments',
    collectionExists,
    objectType,
    documentCount,
    desiredIndex,
    clean,
    action: !clean
      ? 'BLOCKED'
      : !collectionExists
        ? 'CREATE_COLLECTION_AND_INDEX'
        : desiredIndex.action === 'CREATE'
          ? 'CREATE_INDEX'
          : 'NOOP',
  };
}
