export function planIamProjectAuditCollection({
  databaseName,
  targetFingerprint,
  collectionExists,
  objectType,
  documentCount,
}) {
  if (!databaseName || !targetFingerprint || typeof collectionExists !== 'boolean' ||
      ![null, 'collection', 'view'].includes(objectType) ||
      (collectionExists !== (objectType !== null)) ||
      !Number.isSafeInteger(documentCount) || documentCount < 0)
    throw new Error('Invalid IAM audit collection inspection');
  return {
    databaseName,
    targetFingerprint,
    collectionName: 'audit_logs_iam',
    collectionExists,
    objectType,
    documentCount,
    action: objectType === 'view' ? 'BLOCKED_VIEW' :
      collectionExists ? 'NOOP' : 'CREATE_COLLECTION',
    clean: objectType !== 'view',
  };
}
