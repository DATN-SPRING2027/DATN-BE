export const CAPTURE_DRAFTS_COLLECTION = 'capture_drafts';
export const CAPTURE_DRAFTS_LEGACY_DATABASE = 'continuum_db';
export const CAPTURE_DRAFTS_SERVICE_DATABASE = 'continuum_capture';
export const CAPTURE_DRAFTS_ALLOWED_DATABASES = Object.freeze([
  CAPTURE_DRAFTS_LEGACY_DATABASE,
  CAPTURE_DRAFTS_SERVICE_DATABASE,
]);
export const CAPTURE_DRAFTS_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const CAPTURE_DRAFTS_UNIQUE_INDEX_KEY = Object.freeze({
  userId: 1,
  contextKey: 1,
});
export const CAPTURE_DRAFTS_TTL_INDEX_KEY = Object.freeze({ lastSavedAt: 1 });
export const CAPTURE_DRAFTS_EXAMPLE_LIMIT = 20;

const sameKey = (left = {}, right = {}) => {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value], index) =>
        rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value,
    )
  );
};

const hasSimpleCollation = (index) =>
  index.collation === undefined ||
  (index.collation.locale === 'simple' &&
    Object.keys(index.collation).length === 1);

const isPlainPairIndex = (index) =>
  index.unique !== true &&
  index.sparse !== true &&
  index.partialFilterExpression === undefined &&
  (index.expireAfterSeconds === undefined || index.expireAfterSeconds === 0) &&
  hasSimpleCollation(index);

const isDesiredUniquePairIndex = (index) =>
  index.unique === true &&
  index.expireAfterSeconds === undefined &&
  index.sparse !== true &&
  index.partialFilterExpression === undefined &&
  hasSimpleCollation(index) &&
  index.hidden !== true;

const isDesiredTtlIndex = (index) =>
  index.expireAfterSeconds === CAPTURE_DRAFTS_RETENTION_SECONDS &&
  index.unique !== true &&
  index.sparse !== true &&
  index.partialFilterExpression === undefined &&
  hasSimpleCollation(index) &&
  index.hidden !== true;

function serializeIndex(index) {
  return {
    name: index.name,
    key: index.key,
    ...(index.unique === undefined ? {} : { unique: index.unique }),
    ...(index.sparse === undefined ? {} : { sparse: index.sparse }),
    ...(index.expireAfterSeconds === undefined
      ? {}
      : { expireAfterSeconds: index.expireAfterSeconds }),
    ...(index.partialFilterExpression === undefined
      ? {}
      : { partialFilterExpression: index.partialFilterExpression }),
    ...(index.collation === undefined ? {} : { collation: index.collation }),
    ...(index.hidden === undefined ? {} : { hidden: index.hidden }),
  };
}

export function isCaptureDraftTtlEligible(lastSavedAt, asOf = new Date()) {
  return (
    lastSavedAt instanceof Date &&
    Number.isFinite(lastSavedAt.getTime()) &&
    lastSavedAt.getTime() + CAPTURE_DRAFTS_RETENTION_SECONDS * 1000 <=
      asOf.getTime()
  );
}

export function buildCaptureDraftsTtlReport({
  databaseName,
  targetFingerprint,
  collectionExists,
  documentCount,
  lastSavedAtTypeCounts,
  malformedExamples,
  alreadyExpiredCount,
  alreadyExpiredExamples,
  duplicatePairs,
  indexes,
  dataFingerprint,
  asOf,
}) {
  const pairIndexes = indexes
    .filter((index) => sameKey(index.key, CAPTURE_DRAFTS_UNIQUE_INDEX_KEY))
    .map(serializeIndex)
    .sort((left, right) => left.name.localeCompare(right.name));
  const desiredPairIndex = pairIndexes.find(isDesiredUniquePairIndex) ?? null;
  const replaceablePairIndexes = pairIndexes.filter(
    (index) => !isDesiredUniquePairIndex(index) && isPlainPairIndex(index),
  );
  const conflictingPairIndexes = pairIndexes.filter(
    (index) => !isDesiredUniquePairIndex(index) && !isPlainPairIndex(index),
  );

  const ttlIndexes = indexes
    .filter((index) => sameKey(index.key, CAPTURE_DRAFTS_TTL_INDEX_KEY))
    .map(serializeIndex)
    .sort((left, right) => left.name.localeCompare(right.name));
  const desiredTtlIndex = ttlIndexes.find(isDesiredTtlIndex) ?? null;
  const convertibleTtlIndexes = ttlIndexes.filter(
    (index) =>
      !isDesiredTtlIndex(index) &&
      index.unique !== true &&
      index.sparse !== true &&
      index.partialFilterExpression === undefined &&
      hasSimpleCollation(index) &&
      index.hidden !== true,
  );
  const conflictingTtlIndexes = ttlIndexes.filter(
    (index) =>
      !isDesiredTtlIndex(index) &&
      (index.unique === true ||
        index.sparse === true ||
        index.partialFilterExpression !== undefined ||
        !hasSimpleCollation(index) ||
        index.hidden === true),
  );

  const missingLastSavedAtCount =
    lastSavedAtTypeCounts.find((item) => item.type === 'missing')?.count ?? 0;
  const nonDateLastSavedAtCount = lastSavedAtTypeCounts
    .filter((item) => item.type !== 'date' && item.type !== 'missing')
    .reduce((sum, item) => sum + item.count, 0);
  const incompatibleIndexes = [];
  if (replaceablePairIndexes.length > 1) {
    incompatibleIndexes.push({
      reason:
        'multiple replaceable indexes share the userId + contextKey key pattern',
      indexes: replaceablePairIndexes.map((index) => index.name),
    });
  }
  if (conflictingPairIndexes.length > 0) {
    incompatibleIndexes.push({
      reason: 'a userId + contextKey index has unsupported options',
      indexes: conflictingPairIndexes.map((index) => index.name),
    });
  }
  if (convertibleTtlIndexes.length > 1) {
    incompatibleIndexes.push({
      reason:
        'multiple lastSavedAt indexes prevent an unambiguous TTL transition',
      indexes: convertibleTtlIndexes.map((index) => index.name),
    });
  }
  if (conflictingTtlIndexes.length > 0) {
    incompatibleIndexes.push({
      reason:
        'a lastSavedAt index has unsupported unique, sparse, partial, collation, or hidden options',
      indexes: conflictingTtlIndexes.map((index) => index.name),
    });
  }

  const problems = [];
  if (!collectionExists) problems.push('CAPTURE_DRAFTS_COLLECTION_MISSING');
  if (missingLastSavedAtCount > 0)
    problems.push('DRAFTS_MISSING_LAST_SAVED_AT');
  if (nonDateLastSavedAtCount > 0)
    problems.push('DRAFTS_NON_DATE_LAST_SAVED_AT');
  if (duplicatePairs.length > 0) problems.push('DUPLICATE_USER_CONTEXT_PAIRS');
  if (incompatibleIndexes.length > 0) problems.push('INCOMPATIBLE_INDEXES');

  const reportAsOf = asOf.toISOString();
  return {
    clean: problems.length === 0,
    problems,
    target: {
      databaseName,
      targetFingerprint,
      collection: CAPTURE_DRAFTS_COLLECTION,
    },
    reportAsOf,
    retentionSeconds: CAPTURE_DRAFTS_RETENTION_SECONDS,
    counts: {
      documents: documentCount,
      lastSavedAtDate:
        lastSavedAtTypeCounts.find((item) => item.type === 'date')?.count ?? 0,
      missingLastSavedAt: missingLastSavedAtCount,
      nonDateLastSavedAt: nonDateLastSavedAtCount,
      alreadyExpired: alreadyExpiredCount,
      duplicateUserContextPairs: duplicatePairs.length,
    },
    lastSavedAtTypeCounts,
    malformedExamples,
    alreadyExpiredExamples,
    duplicatePairs,
    indexes: indexes
      .map(serializeIndex)
      .sort((left, right) => left.name.localeCompare(right.name)),
    dataFingerprint,
    indexActions: {
      uniqueUserContext: desiredPairIndex
        ? 'PRESENT'
        : replaceablePairIndexes.length === 0
          ? 'CREATE'
          : 'REPLACE_LEGACY',
      legacyUserContextIndexesToDrop: replaceablePairIndexes.map(
        (index) => index.name,
      ),
      lastSavedAtTtl: desiredTtlIndex
        ? 'PRESENT'
        : convertibleTtlIndexes.length === 0
          ? 'CREATE'
          : 'CONVERT_EXISTING_SINGLE_FIELD',
      existingLastSavedAtIndexToConvert: convertibleTtlIndexes[0]?.name ?? null,
    },
    incompatibleIndexes,
  };
}

export function validateCaptureDraftsDatabaseName(databaseName) {
  if (!CAPTURE_DRAFTS_ALLOWED_DATABASES.includes(databaseName)) {
    throw new Error(
      `CAPTURE_DRAFTS_TTL_DATABASE must be one of: ${CAPTURE_DRAFTS_ALLOWED_DATABASES.join(', ')}`,
    );
  }
  return databaseName;
}
