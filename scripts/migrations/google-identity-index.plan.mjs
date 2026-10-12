import { createHash } from 'node:crypto';

export const GOOGLE_SUBJECT_INDEX = {
  key: { googleSubject: 1 },
  name: 'googleSubject_1',
  unique: true,
  sparse: true,
};

export function hashGoogleIdentityIndexReport(report) {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

function hasSameKey(left, right) {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const rightEntries = Object.entries(right).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

export function planGoogleIdentityIndex({
  databaseName,
  targetFingerprint,
  collectionExists,
  objectType,
  userCount,
  duplicateSubjectGroups,
  indexes,
}) {
  const sameKeyIndex = indexes.find((index) =>
    hasSameKey(index.key, GOOGLE_SUBJECT_INDEX.key),
  );
  const sameNameIndex = indexes.find(
    (index) => index.name === GOOGLE_SUBJECT_INDEX.name,
  );
  const indexIsExact = sameKeyIndex
    ? sameKeyIndex.name === GOOGLE_SUBJECT_INDEX.name &&
      sameKeyIndex.unique === true &&
      sameKeyIndex.sparse === true &&
      sameKeyIndex.partialFilterExpression === undefined &&
      sameKeyIndex.expireAfterSeconds === undefined
    : false;
  const indexAction =
    sameNameIndex && !hasSameKey(sameNameIndex.key, GOOGLE_SUBJECT_INDEX.key)
      ? 'CONFLICT'
      : !sameKeyIndex
        ? 'CREATE'
        : indexIsExact
          ? 'NOOP'
          : 'CONFLICT';
  const supportedObject = objectType === null || objectType === 'collection';
  const clean =
    supportedObject &&
    duplicateSubjectGroups === 0 &&
    indexAction !== 'CONFLICT';

  return {
    migration: 'google-identity-index-v1',
    databaseName,
    targetFingerprint,
    collectionName: 'users',
    collectionExists,
    objectType,
    userCount,
    duplicateSubjectGroups,
    desiredIndex: { ...GOOGLE_SUBJECT_INDEX, action: indexAction },
    clean,
    action: !clean
      ? 'BLOCKED'
      : !collectionExists
        ? 'CREATE_COLLECTION_AND_INDEX'
        : indexAction === 'CREATE'
          ? 'CREATE_INDEX'
          : 'NOOP',
  };
}
