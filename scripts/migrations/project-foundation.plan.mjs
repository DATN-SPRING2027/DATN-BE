import { Types } from 'mongoose';

export const PROJECT_MEMBERSHIP_INDEX_NAME = 'projectId_1_userId_1';

const objectId = (value) =>
  value instanceof Types.ObjectId ? value.toHexString() : null;
const sorted = (values) => [...values].sort();
const membershipKey = (projectId, userId) => `${projectId}:${userId}`;
const indexKey = (index) => JSON.stringify(Object.entries(index.key ?? {}));
const isUnrestrictedUniqueIndex = (index) =>
  index.unique === true &&
  index.sparse !== true &&
  index.partialFilterExpression == null;
const expectedIndexKey = JSON.stringify([
  ['projectId', 1],
  ['userId', 1],
]);

export function buildProjectFoundationReport({
  projects,
  projectMemberships,
  indexes,
}) {
  const projectsToSetPrivate = [];
  const invalidProjectVisibility = [];
  const invalidProjectIds = [];
  const invalidProjectOrganizationIds = [];
  const projectOrganizations = new Map();
  for (const project of projects) {
    const projectId = objectId(project._id);
    const organizationId = objectId(project.organizationId);
    if (!projectId) {
      invalidProjectIds.push(String(project._id));
      continue;
    }
    if (!organizationId) invalidProjectOrganizationIds.push(projectId);
    else projectOrganizations.set(projectId, organizationId);
    if (!Object.hasOwn(project, 'visibility')) {
      projectsToSetPrivate.push(projectId);
    } else if (!['PRIVATE', 'PUBLIC'].includes(project.visibility)) {
      invalidProjectVisibility.push({
        projectId,
        value: project.visibility ?? null,
      });
    }
  }

  const groups = new Map();
  const invalidProjectMembershipKeys = [];
  const danglingProjectMemberships = [];
  const invalidProjectMembershipStatuses = [];
  for (const membership of projectMemberships) {
    const projectId = objectId(membership.projectId);
    const userId = objectId(membership.userId);
    const organizationId = objectId(membership.organizationId);
    const membershipId = objectId(membership._id) ?? String(membership._id);
    if (!projectId || !userId || !organizationId) {
      invalidProjectMembershipKeys.push(membershipId);
      continue;
    }
    const projectOrganizationId = projectOrganizations.get(projectId);
    if (projectOrganizationId !== organizationId) {
      danglingProjectMemberships.push({
        membershipId,
        projectId,
        organizationId,
        projectOrganizationId: projectOrganizationId ?? null,
      });
    }
    if (!['ACTIVE', 'INACTIVE'].includes(membership.status)) {
      invalidProjectMembershipStatuses.push({
        membershipId,
        status: membership.status ?? null,
      });
    }
    const key = membershipKey(projectId, userId);
    const group = groups.get(key) ?? {
      projectId,
      userId,
      organizationIds: new Set(),
      membershipIds: [],
    };
    group.organizationIds.add(organizationId);
    group.membershipIds.push(
      objectId(membership._id) ?? String(membership._id),
    );
    groups.set(key, group);
  }

  const duplicateProjectMemberships = [...groups.values()]
    .filter((group) => group.membershipIds.length > 1)
    .map((group) => ({
      projectId: group.projectId,
      userId: group.userId,
      organizationIds: sorted(group.organizationIds),
      membershipIds: sorted(group.membershipIds),
    }))
    .sort((left, right) =>
      membershipKey(left.projectId, left.userId).localeCompare(
        membershipKey(right.projectId, right.userId),
      ),
    );

  const namedIndex = indexes.find(
    (index) => index.name === PROJECT_MEMBERSHIP_INDEX_NAME,
  );
  const equivalentIndexes = indexes.filter(
    (index) => indexKey(index) === expectedIndexKey,
  );
  const matchingUniqueIndex = equivalentIndexes.some(isUnrestrictedUniqueIndex);
  const conflictingIndex =
    (namedIndex &&
      (indexKey(namedIndex) !== expectedIndexKey ||
        !isUnrestrictedUniqueIndex(namedIndex))) ||
    equivalentIndexes.some((index) => !isUnrestrictedUniqueIndex(index));

  let indexAction;
  if (conflictingIndex) indexAction = 'BLOCKED_CONFLICT';
  else if (duplicateProjectMemberships.length > 0) {
    indexAction = 'BLOCKED_DUPLICATES';
  } else if (invalidProjectMembershipKeys.length > 0) {
    indexAction = 'BLOCKED_INVALID_KEYS';
  } else if (matchingUniqueIndex) indexAction = 'PRESENT';
  else indexAction = 'CREATE';

  const clean =
    invalidProjectVisibility.length === 0 &&
    invalidProjectIds.length === 0 &&
    invalidProjectOrganizationIds.length === 0 &&
    invalidProjectMembershipKeys.length === 0 &&
    danglingProjectMemberships.length === 0 &&
    invalidProjectMembershipStatuses.length === 0 &&
    duplicateProjectMemberships.length === 0 &&
    !conflictingIndex;

  return {
    clean,
    counts: {
      projects: projects.length,
      projectsToSetPrivate: projectsToSetPrivate.length,
      projectMemberships: projectMemberships.length,
      duplicateProjectMembershipPairs: duplicateProjectMemberships.length,
      invalidProjectMembershipKeys: invalidProjectMembershipKeys.length,
      danglingProjectMemberships: danglingProjectMemberships.length,
      invalidProjectMembershipStatuses: invalidProjectMembershipStatuses.length,
      invalidProjectVisibility: invalidProjectVisibility.length,
      invalidProjectIds: invalidProjectIds.length,
      invalidProjectOrganizationIds: invalidProjectOrganizationIds.length,
    },
    projectsToSetPrivate: sorted(projectsToSetPrivate),
    invalidProjectVisibility: invalidProjectVisibility.sort((a, b) =>
      a.projectId.localeCompare(b.projectId),
    ),
    invalidProjectIds: sorted(invalidProjectIds),
    invalidProjectOrganizationIds: sorted(invalidProjectOrganizationIds),
    duplicateProjectMemberships,
    invalidProjectMembershipKeys: sorted(invalidProjectMembershipKeys),
    danglingProjectMemberships: danglingProjectMemberships.sort((a, b) =>
      a.membershipId.localeCompare(b.membershipId),
    ),
    invalidProjectMembershipStatuses: invalidProjectMembershipStatuses.sort(
      (a, b) => a.membershipId.localeCompare(b.membershipId),
    ),
    projectMembershipIndex: {
      name: PROJECT_MEMBERSHIP_INDEX_NAME,
      key: { projectId: 1, userId: 1 },
      unique: true,
      action: indexAction,
    },
  };
}
