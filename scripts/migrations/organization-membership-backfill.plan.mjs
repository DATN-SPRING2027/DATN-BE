import { Types } from 'mongoose';
import { createHash } from 'node:crypto';

export function resolveIamDatabaseName({ mongodbEnabled, infraEnabled, configuredName }) {
  if (mongodbEnabled === 'true') {
    if (!configuredName) throw new Error('MONGODB_DATABASE is required in shared MongoDB mode');
    return configuredName;
  }
  if (infraEnabled === 'true') return 'continuum_iam';
  throw new Error('IAM MongoDB persistence is disabled; set MONGODB_ENABLED or INFRA_ENABLED');
}

export function targetFingerprint(uri, databaseName) {
  const parsed = /^(mongodb(?:\+srv)?:\/\/)([^/?#]+)(?:\/[^?#]*)?(?:\?([^#]*))?$/.exec(uri);
  if (!parsed) throw new Error('MONGODB_URI must be a MongoDB connection URI');
  const endpoint = parsed[2].slice(parsed[2].lastIndexOf('@') + 1).toLowerCase();
  if (!endpoint) throw new Error('MONGODB_URI has no endpoint');
  const parameters = new URLSearchParams(parsed[3] ?? '');
  const routingOptions = [...parameters]
    .filter(([key]) => ['replicaset', 'directconnection', 'loadbalanced', 'srvservicename'].includes(key.toLowerCase()))
    .map(([key, value]) => [key.toLowerCase(), value])
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256')
    .update(`${parsed[1].toLowerCase()}${endpoint}\u0000${databaseName}\u0000${JSON.stringify(routingOptions)}`)
    .digest('hex');
}

const id = (value) => value instanceof Types.ObjectId ? value.toHexString() : null;
const sorted = (values) => [...values].sort();
const pairKey = (organizationId, userId) => `${organizationId}:${userId}`;

export function buildBackfillReport({ users, organizations, assignments, memberships }) {
  const userIds = new Set(users.map((row) => id(row._id)).filter(Boolean));
  const userStatuses = new Map(users.map((row) => [id(row._id), row.status ?? null]));
  const organizationIds = new Set(organizations.map((row) => id(row._id)).filter(Boolean));
  const groups = new Map();
  const ambiguousLegacyAssignments = [];
  const excludedProjects = new Map();
  let projectScopedExcluded = 0;

  for (const row of assignments) {
    if (row.projectId != null) {
      projectScopedExcluded += 1;
      const userId = id(row.userId);
      const organizationId = id(row.organizationId);
      const key = pairKey(organizationId ?? '', userId ?? '');
      const group = excludedProjects.get(key) ?? { organizationId, userId, assignmentIds: [] };
      group.assignmentIds.push(String(row._id));
      excludedProjects.set(key, group);
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
      organizationId, userId, userStatus: userStatuses.get(userId) ?? null,
      sourceAssignmentIds: sorted(assignmentIds), status: 'ACTIVE',
    }));
  const projectScopedExcludedPairs = [...excludedProjects.values()]
    .map((group) => ({
      ...group,
      assignmentIds: sorted(group.assignmentIds),
      hasOrganizationLevelLegacyRelationship: groups.has(pairKey(group.organizationId, group.userId)),
      hasActiveMembership: (existing.get(pairKey(group.organizationId, group.userId)) ?? [])
        .some((row) => row.status === 'ACTIVE'),
    }))
    .sort((a, b) => pairKey(a.organizationId ?? '', a.userId ?? '')
      .localeCompare(pairKey(b.organizationId ?? '', b.userId ?? '')));
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
    legacyPairs: groupsSorted.map((group) => ({
      organizationId: group.organizationId,
      userId: group.userId,
      userStatus: userStatuses.get(group.userId) ?? null,
      sourceAssignmentIds: sorted(group.assignmentIds),
    })),
    projectScopedExcludedPairs,
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
