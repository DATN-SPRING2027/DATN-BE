const desiredIndexes = [
  {
    name: 'uniq_pending_org_email',
    key: { organizationId: 1, email: 1 },
    unique: true,
    partialFilterExpression: { status: 'PENDING' },
  },
  {
    name: 'email_status_expiry',
    key: { email: 1, status: 1, expiresAt: 1 },
  },
  {
    name: 'org_status_expiry',
    key: { organizationId: 1, status: 1, expiresAt: 1 },
  },
];

const sameKey = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const samePartial = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export function planOrganizationInvitationIndexes({
  databaseName,
  targetFingerprint,
  collectionExists,
  objectType,
  documentCount,
  pendingInvitationCount,
  pendingDuplicatePairs,
  invalidRecords,
  indexes,
}) {
  const conflicts = [];
  if (objectType && objectType !== 'collection')
    conflicts.push({ reason: 'organization_invitations is not a collection' });
  if (pendingDuplicatePairs.length > 0)
    conflicts.push({ reason: 'duplicate pending Organization/email pairs', pendingDuplicatePairs });
  if (invalidRecords.length > 0)
    conflicts.push({ reason: 'invalid invitation records need manual review', invalidRecords });

  const plannedIndexes = desiredIndexes.map((desired) => {
    const sameKeyIndexes = indexes.filter((index) => sameKey(index.key, desired.key));
    const matching = sameKeyIndexes.find((index) =>
      index.name === desired.name &&
      Boolean(index.unique) === Boolean(desired.unique) &&
      samePartial(index.partialFilterExpression, desired.partialFilterExpression),
    );
    if (sameKeyIndexes.length > 0 && !matching) {
      conflicts.push({
        reason: 'index with desired key has incompatible options',
        index: desired.name,
        existing: sameKeyIndexes.map(({ name, unique, partialFilterExpression }) => ({
          name,
          unique: Boolean(unique),
          partialFilterExpression: partialFilterExpression ?? null,
        })),
      });
    }
    return {
      ...desired,
      action: matching ? 'NOOP' : 'CREATE',
    };
  });

  return {
    migration: 'organization-invitation-indexes',
    databaseName,
    targetFingerprint,
    collection: 'organization_invitations',
    collectionExists,
    documentCount,
    pendingInvitationCount,
    pendingDuplicatePairs,
    invalidRecords,
    desiredIndexes: plannedIndexes,
    conflicts,
    clean: conflicts.length === 0,
  };
}

export function getDesiredOrganizationInvitationIndexes() {
  return desiredIndexes.map((index) => ({ ...index }));
}
