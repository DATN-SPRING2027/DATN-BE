const desiredIndex = {
  name: 'invitation_token_hash_unique_v3',
  key: { tokenHash: 1 },
  unique: true,
  partialFilterExpression: { tokenHash: { $type: 'string' } },
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function same(left, right) {
  return JSON.stringify(canonical(left ?? null)) ===
    JSON.stringify(canonical(right ?? null));
}

export function getDesiredOrganizationInvitationTokenIndex() {
  return structuredClone(desiredIndex);
}

export function planOrganizationInvitationTokenIndex(input) {
  const conflicts = [];
  if (input.objectType !== 'collection')
    conflicts.push({ reason: 'organization_invitations must be an existing collection' });
  if (input.duplicateTokenHashGroups > 0)
    conflicts.push({ reason: 'duplicate invitation token hashes require manual review' });
  if (input.malformedTokenHashCount > 0)
    conflicts.push({ reason: 'malformed invitation token hashes require manual review' });
  if (input.v3InvitationsWithoutTokenHashCount > 0)
    conflicts.push({ reason: 'V3 invitations without token hashes require manual review' });

  const sameKey = input.indexes.filter((index) => same(index.key, desiredIndex.key));
  const exact = sameKey.find(
    (index) =>
      index.name === desiredIndex.name &&
      Boolean(index.unique) === desiredIndex.unique &&
      same(index.partialFilterExpression, desiredIndex.partialFilterExpression) &&
      index.sparse !== true &&
      index.expireAfterSeconds === undefined,
  );
  if (sameKey.length > 0 && !exact)
    conflicts.push({ reason: 'tokenHash index exists with incompatible options' });

  return {
    migration: 'organization-invitation-token-index',
    databaseName: input.databaseName,
    targetFingerprint: input.targetFingerprint,
    collection: 'organization_invitations',
    documentCount: input.documentCount,
    v3InvitationCount: input.v3InvitationCount,
    v3InvitationsWithoutTokenHashCount:
      input.v3InvitationsWithoutTokenHashCount,
    rollbackAllowed: input.v3InvitationCount === 0,
    pendingV3InvitationCount: input.pendingV3InvitationCount,
    duplicateTokenHashGroups: input.duplicateTokenHashGroups,
    malformedTokenHashCount: input.malformedTokenHashCount,
    desiredIndex: { ...desiredIndex, action: exact ? 'NOOP' : 'CREATE' },
    conflicts,
    clean: conflicts.length === 0,
  };
}
