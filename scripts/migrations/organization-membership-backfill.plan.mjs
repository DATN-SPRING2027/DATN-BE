import { Types } from 'mongoose';
import { createHash } from 'node:crypto';

export function targetFingerprint(uri, databaseName) {
  const parsedUri = new URL(uri);
  return createHash('sha256')
    .update(`${parsedUri.protocol}//${parsedUri.host.toLowerCase()}/${databaseName}`)
    .digest('hex');
}

const id = (value) => value instanceof Types.ObjectId ? value.toHexString() : null;
const sorted = (values) => [...values].sort();
const pairKey = (organizationId, userId) => `${organizationId}:${userId}`;

export function buildBackfillReport({ users, organizations, assignments, memberships }) {
  const userIds = new Set(users.map((row) => id(row._id)).filter(Boolean));
  const organizationIds = new Set(organizations.map((row) => id(row._id)).filter(Boolean));
  const groups = new Map();
  const ambiguousLegacyAssignments = [];
  let projectScopedExcluded = 0;

  for (const row of assignments) {
    if (row.projectId != null) {
      projectScopedExcluded += 1;
      continue;
    }
    const userId = id(row.userId);
    const organizationId = id(row.organizationId);
    if (!userId || !organizationId) {
      ambiguousLegacyAssignments.push({ assignmentId: String(row._id), reason: 'missing or non-ObjectId userId/organizationId' });
      continue;
    }
    const key = pairKey(organizationId, userId);
    const group = groups.get(key) ?? { organizationId, userId, assignmentIds: [] };
    group.assignmentIds.push(String(row._id));
    groups.set(key, group);
  }

  const groupsSorted = [...groups.values()].sort((a, b) =>
    pairKey(a.organizationId, a.userId).localeCompare(pairKey(b.organizationId, b.userId)),
  );
  const duplicateLegacyRelationships = groupsSorted
    .filter((group) => group.assignmentIds.length > 1)
    .map((group) => ({ ...group, assignmentIds: sorted(group.assignmentIds) }));
  const danglingLegacyRelationships = groupsSorted
    .filter((group) => !userIds.has(group.userId) || !organizationIds.has(group.organizationId))
    .map((group) => ({
      organizationId: group.organizationId,
      userId: group.userId,
      missingUser: !userIds.has(group.userId),
      missingOrganization: !organizationIds.has(group.organizationId),
      assignmentIds: sorted(group.assignmentIds),
    }));
  const existing = new Map();
  const invalidExistingMemberships = [];
  for (const row of memberships) {
    const userId = id(row.userId);
    const organizationId = id(row.organizationId);
    if (!userId || !organizationId) {
      invalidExistingMemberships.push(String(row._id));
      continue;
    }
    const key = pairKey(organizationId, userId);
    existing.set(key, [...(existing.get(key) ?? []), { membershipId: String(row._id), status: row.status }]);
  }
  const duplicateExistingMemberships = [...existing.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({ pair: key, membershipIds: sorted(rows.map((row) => row.membershipId)) }))
    .sort((a, b) => a.pair.localeCompare(b.pair));
  const conflictingExistingMemberships = groupsSorted
    .flatMap((group) => (existing.get(pairKey(group.organizationId, group.userId)) ?? [])
      .filter((row) => row.status !== 'ACTIVE')
      .map((row) => ({ organizationId: group.organizationId, userId: group.userId, ...row })));
  const toCreate = groupsSorted
    .filter((group) => !existing.has(pairKey(group.organizationId, group.userId)))
    .filter((group) => userIds.has(group.userId) && organizationIds.has(group.organizationId))
    .map(({ organizationId, userId, assignmentIds }) => ({
      organizationId, userId, sourceAssignmentIds: sorted(assignmentIds), status: 'ACTIVE',
    }));
  const relatedUsers = new Set(groupsSorted.map((group) => group.userId));
  const relatedOrganizations = new Set(groupsSorted.map((group) => group.organizationId));
  const clean = ambiguousLegacyAssignments.length === 0 &&
    danglingLegacyRelationships.length === 0 &&
    invalidExistingMemberships.length === 0 &&
    duplicateExistingMemberships.length === 0 &&
    conflictingExistingMemberships.length === 0;

  return {
    clean,
    counts: { users: users.length, organizations: organizations.length,
      roleAssignments: assignments.length, projectScopedExcluded,
      eligibleLegacyPairs: groupsSorted.length, existingMemberships: memberships.length,
      toCreate: toCreate.length },
    toCreate,
    usersWithoutOrganizationLevelLegacyRelationship: sorted([...userIds].filter((value) => !relatedUsers.has(value))),
    organizationsWithoutOrganizationLevelLegacyRelationship: sorted([...organizationIds].filter((value) => !relatedOrganizations.has(value))),
    duplicateLegacyRelationships,
    ambiguousLegacyAssignments: ambiguousLegacyAssignments.sort((a, b) => a.assignmentId.localeCompare(b.assignmentId)),
    danglingLegacyRelationships,
    invalidExistingMemberships: sorted(invalidExistingMemberships),
    duplicateExistingMemberships,
    conflictingExistingMemberships,
  };
}
