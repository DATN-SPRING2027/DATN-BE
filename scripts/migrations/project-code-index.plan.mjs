const indexKey = { organizationId: 1, code: 1 };
const indexName = 'organizationId_1_code_1';
const sameKey = (left) => JSON.stringify(left) === JSON.stringify(indexKey);
const simpleCollation = (value) => value === undefined ||
  (value?.locale === 'simple' && Object.keys(value).length === 1);
const unrestrictedUnique = (item) =>
  sameKey(item.key) &&
  item.unique === true &&
  item.sparse !== true &&
  item.partialFilterExpression === undefined &&
  simpleCollation(item.collation) &&
  item.expireAfterSeconds === undefined;
const describeIndex = ({ name, key, unique, sparse, partialFilterExpression, collation, expireAfterSeconds }) => ({
  name, key, unique: unique === true,
  ...(sparse === undefined ? {} : { sparse }),
  ...(partialFilterExpression === undefined ? {} : { partialFilterExpression }),
  ...(collation === undefined ? {} : { collation }),
  ...(expireAfterSeconds === undefined ? {} : { expireAfterSeconds }),
});

export function buildProjectCodeIndexPlan({
  databaseName,
  targetFingerprint,
  collectionExists,
  objectType,
  projectCount,
  indexes,
  duplicatePairs,
  nonCanonicalProjectCodes,
}) {
  const conflicting = indexes.filter((item) =>
    (sameKey(item.key) && !unrestrictedUnique(item)) ||
    (item.name === indexName && !sameKey(item.key)),
  );
  const alreadyUnique = indexes.some(unrestrictedUnique);
  const clean = collectionExists && objectType === 'collection' &&
    duplicatePairs.length === 0 && nonCanonicalProjectCodes.length === 0 &&
    conflicting.length === 0;
  return {
    databaseName,
    targetFingerprint,
    collectionExists,
    objectType,
    conflictingObjectType: objectType === 'view' ? 'view' : null,
    projectCount,
    desiredIndex: { name: indexName, key: indexKey, unique: true },
    existingIndexes: indexes.map(describeIndex),
    duplicatePairs,
    nonCanonicalProjectCodes,
    conflictingIndexes: conflicting.map(describeIndex),
    action: clean ? alreadyUnique ? 'NOOP' : 'CREATE_UNIQUE_INDEX' : 'BLOCKED',
    clean,
  };
}
