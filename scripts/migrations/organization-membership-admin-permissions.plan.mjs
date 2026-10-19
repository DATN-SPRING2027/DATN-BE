import { createHash } from 'node:crypto';

export const ORGANIZATION_MEMBERSHIP_ADMIN_PERMISSIONS_PROVISIONING = Object.freeze({
  migration: 'organization-membership-admin-permissions-v1',
  collectionName: 'roles',
  targetRoleCode: 'ADMIN',
  approvedPermissions: Object.freeze([
    'organization.memberships.read',
    'organization.memberships.manage',
  ]),
});

const approvedSet = new Set(
  ORGANIZATION_MEMBERSHIP_ADMIN_PERMISSIONS_PROVISIONING.approvedPermissions,
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

export function hashAdminPermissionsReport(report) {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

export function planOrganizationMembershipAdminPermissions({
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

  // Safety: Verify non-admin roles do NOT have organization membership permissions
  for (const role of roles) {
    if (role.code === ORGANIZATION_MEMBERSHIP_ADMIN_PERMISSIONS_PROVISIONING.targetRoleCode) {
      continue;
    }
    const rolePermissions = Array.isArray(role.permissions)
      ? role.permissions
      : [];
    const misplaced = rolePermissions.filter((p) => approvedSet.has(p));
    if (misplaced.length > 0) {
      issues.push(`MISPLACED_MEMBERSHIP_PERMISSION:${role.code}`);
    }
  }

  const adminMatches = roles.filter(
    (role) => role.code === ORGANIZATION_MEMBERSHIP_ADMIN_PERMISSIONS_PROVISIONING.targetRoleCode,
  );
  if (adminMatches.length === 0) issues.push('ROLE_MISSING:ADMIN');
  if (adminMatches.length > 1) issues.push('ROLE_DUPLICATE:ADMIN');

  const adminRole = adminMatches.length === 1 ? adminMatches[0] : null;
  const adminId = adminRole ? serializedId(adminRole._id) : null;
  if (adminRole && !adminId) issues.push('ROLE_ID_INVALID:ADMIN');
  if (adminRole && adminRole.isSystem !== true) issues.push('ROLE_NOT_SYSTEM:ADMIN');

  const permissionsFieldMissing = adminRole !== null && adminRole.permissions === undefined;
  const existingPermissions = permissionsFieldMissing ? [] : adminRole?.permissions;
  const permissionsAreArray =
    adminRole === null || permissionsFieldMissing || Array.isArray(existingPermissions);
  if (!permissionsAreArray) issues.push('PERMISSIONS_NOT_ARRAY:ADMIN');

  const permissionValues = Array.isArray(existingPermissions) ? existingPermissions : [];
  if (permissionValues.some((p) => typeof p !== 'string')) {
    issues.push('PERMISSIONS_INVALID:ADMIN');
  }
  if (new Set(permissionValues).size !== permissionValues.length) {
    issues.push('PERMISSIONS_DUPLICATED:ADMIN');
  }

  const stringPermissions = permissionValues.filter((p) => typeof p === 'string');
  const missingPermissions =
    adminRole && permissionsAreArray
      ? ORGANIZATION_MEMBERSHIP_ADMIN_PERMISSIONS_PROVISIONING.approvedPermissions.filter(
          (p) => !stringPermissions.includes(p),
        )
      : [];

  const plannedAdminRole = {
    code: 'ADMIN',
    id: adminId,
    isSystem: adminRole?.isSystem ?? null,
    permissionsFieldMissing,
    existingPermissions: stringPermissions,
    missingPermissions,
  };

  const clean = issues.length === 0;
  const hasChanges = missingPermissions.length > 0;

  return {
    migration: ORGANIZATION_MEMBERSHIP_ADMIN_PERMISSIONS_PROVISIONING.migration,
    databaseName,
    targetFingerprint,
    collectionName: ORGANIZATION_MEMBERSHIP_ADMIN_PERMISSIONS_PROVISIONING.collectionName,
    collectionExists,
    objectType,
    role: plannedAdminRole,
    issues,
    clean,
    action: !clean ? 'BLOCKED' : hasChanges ? 'ADD_MISSING_PERMISSIONS' : 'NOOP',
  };
}

export function getAdminPermissionsRollbackAdditions(originalReport) {
  if (!originalReport || typeof originalReport !== 'object') {
    throw new Error('A saved pre-apply dry-run report is required for rollback');
  }
  const { reportSha256, ...originalPlan } = originalReport;
  if (
    originalPlan.migration !==
      ORGANIZATION_MEMBERSHIP_ADMIN_PERMISSIONS_PROVISIONING.migration ||
    originalPlan.clean !== true ||
    typeof reportSha256 !== 'string' ||
    hashAdminPermissionsReport(originalPlan) !== reportSha256
  ) {
    throw new Error('The saved pre-apply report is invalid or was modified');
  }

  const role = originalPlan.role;
  if (!role || role.code !== 'ADMIN' || !role.id || !Array.isArray(role.missingPermissions)) {
    throw new Error('The saved pre-apply report has an invalid role entry');
  }
  if (role.missingPermissions.some((p) => !approvedSet.has(p))) {
    throw new Error('The saved pre-apply report contains an unapproved permission');
  }

  return {
    id: role.id,
    permissions: [...role.missingPermissions],
  };
}
