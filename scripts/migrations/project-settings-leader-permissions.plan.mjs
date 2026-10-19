import { createHash } from 'node:crypto';

export const PROJECT_SETTINGS_LEADER_PERMISSIONS_PROVISIONING = Object.freeze({
  migration: 'project-settings-leader-permissions-v1',
  collectionName: 'roles',
  targetRoleCode: 'TEAM_LEADER',
  approvedPermissions: Object.freeze([
    'project.visibility.manage',
    'project.update',
  ]),
});

const approvedSet = new Set(
  PROJECT_SETTINGS_LEADER_PERMISSIONS_PROVISIONING.approvedPermissions,
);

function serializedId(value) {
  const id =
    typeof value === 'string'
      ? value
      : typeof value?.toHexString === 'function'
        ? value.toHexString()
        : null;
  return typeof id === 'string' && /^[\da-f]{24}$/i.test(id)
    ? id.toLowerCase()
    : null;
}

export function hashLeaderPermissionsReport(report) {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

export function planProjectSettingsLeaderPermissions({
  databaseName,
  targetFingerprint,
  collectionExists,
  objectType,
  roles,
}) {
  const issues = [];
  if (!collectionExists || objectType !== 'collection') {
    issues.push('ROLE_COLLECTION_UNAVAILABLE');
  }

  const leaderMatches = roles.filter(
    (role) =>
      role.code ===
      PROJECT_SETTINGS_LEADER_PERMISSIONS_PROVISIONING.targetRoleCode,
  );
  if (leaderMatches.length === 0) issues.push('ROLE_MISSING:TEAM_LEADER');
  if (leaderMatches.length > 1) issues.push('ROLE_DUPLICATE:TEAM_LEADER');

  const leaderRole = leaderMatches.length === 1 ? leaderMatches[0] : null;
  const leaderId = leaderRole ? serializedId(leaderRole._id) : null;
  if (leaderRole && !leaderId) issues.push('ROLE_ID_INVALID:TEAM_LEADER');
  if (leaderRole && leaderRole.isSystem !== true)
    issues.push('ROLE_NOT_SYSTEM:TEAM_LEADER');

  const permissionsFieldMissing =
    leaderRole !== null && leaderRole.permissions === undefined;
  const existingPermissions = permissionsFieldMissing
    ? []
    : leaderRole?.permissions;
  const permissionsAreArray =
    leaderRole === null ||
    permissionsFieldMissing ||
    Array.isArray(existingPermissions);
  if (!permissionsAreArray) issues.push('PERMISSIONS_NOT_ARRAY:TEAM_LEADER');

  const permissionValues = Array.isArray(existingPermissions)
    ? existingPermissions
    : [];
  if (permissionValues.some((p) => typeof p !== 'string')) {
    issues.push('PERMISSIONS_INVALID:TEAM_LEADER');
  }
  if (new Set(permissionValues).size !== permissionValues.length) {
    issues.push('PERMISSIONS_DUPLICATED:TEAM_LEADER');
  }

  const stringPermissions = permissionValues.filter(
    (p) => typeof p === 'string',
  );
  const permissionsToAdd =
    leaderRole && permissionsAreArray
      ? PROJECT_SETTINGS_LEADER_PERMISSIONS_PROVISIONING.approvedPermissions.filter(
          (p) => !stringPermissions.includes(p),
        )
      : [];
  const permissionsUnchanged = stringPermissions;

  const plannedLeaderRole = {
    code: 'TEAM_LEADER',
    id: leaderId,
    isSystem: leaderRole?.isSystem ?? null,
    permissionsFieldMissing,
    existingPermissions: stringPermissions,
    missingPermissions: permissionsToAdd,
    permissionsToAdd,
    permissionsUnchanged,
    expectedPermissions: [
      ...stringPermissions,
      ...permissionsToAdd,
    ],
  };

  const clean = issues.length === 0;
  const hasChanges = permissionsToAdd.length > 0;

  return {
    migration:
      PROJECT_SETTINGS_LEADER_PERMISSIONS_PROVISIONING.migration,
    databaseName,
    targetFingerprint,
    collectionName:
      PROJECT_SETTINGS_LEADER_PERMISSIONS_PROVISIONING.collectionName,
    collectionExists,
    objectType,
    role: plannedLeaderRole,
    issues,
    clean,
    action: !clean
      ? 'BLOCKED'
      : hasChanges
        ? 'ADD_MISSING_PERMISSIONS'
        : 'NOOP',
  };
}

export function getLeaderPermissionsRollbackAdditions(originalReport) {
  if (!originalReport || typeof originalReport !== 'object') {
    throw new Error('A saved pre-apply dry-run report is required for rollback');
  }
  const { reportSha256, result: _result, ...originalPlan } = originalReport;
  if (
    originalPlan.migration !==
      PROJECT_SETTINGS_LEADER_PERMISSIONS_PROVISIONING.migration ||
    originalPlan.clean !== true ||
    typeof reportSha256 !== 'string' ||
    hashLeaderPermissionsReport(originalPlan) !== reportSha256
  ) {
    throw new Error('The saved pre-apply report is invalid or was modified');
  }

  const role = originalPlan.role;
  if (
    !role ||
    role.code !== 'TEAM_LEADER' ||
    !role.id ||
    !Array.isArray(role.missingPermissions)
  ) {
    throw new Error('The saved pre-apply report has an invalid role entry');
  }
  if (role.missingPermissions.some((p) => !approvedSet.has(p))) {
    throw new Error(
      'The saved pre-apply report contains an unapproved permission',
    );
  }

  return {
    id: role.id,
    permissions: [...role.missingPermissions],
  };
}
