import { createHash } from 'node:crypto';

export const PROJECT_ACCESS_PERMISSION_PROVISIONING = Object.freeze({
  migration: 'project-access-permission-provisioning-v1',
  collectionName: 'roles',
  roles: Object.freeze([
    Object.freeze({
      code: 'ADMIN',
      permissions: Object.freeze([
        'project.visibility.manage',
        'project.leader.manage',
      ]),
    }),
    Object.freeze({
      code: 'TEAM_LEADER',
      permissions: Object.freeze([
        'project.members.list',
        'project.members.add',
        'project.members.remove',
      ]),
    }),
  ]),
  disabledPermission: 'project.members.role.change',
});

const projectAccessPermissions = new Set([
  ...PROJECT_ACCESS_PERMISSION_PROVISIONING.roles.flatMap(
    ({ permissions }) => permissions,
  ),
  PROJECT_ACCESS_PERMISSION_PROVISIONING.disabledPermission,
]);
const targetRoleCodes = new Set(
  PROJECT_ACCESS_PERMISSION_PROVISIONING.roles.map(({ code }) => code),
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

function misplacedProjectPermissions(code, permissions) {
  const allowed = new Set(
    PROJECT_ACCESS_PERMISSION_PROVISIONING.roles.find(
      (role) => role.code === code,
    )?.permissions ?? [],
  );
  if (code === 'TEAM_LEADER') allowed.add('project.read');
  return permissions.filter(
    (permission) =>
      projectAccessPermissions.has(permission) && !allowed.has(permission),
  );
}

export function hashProjectAccessPermissionReport(report) {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

export function planProjectAccessPermissionProvisioning({
  databaseName,
  targetFingerprint,
  collectionExists,
  objectType,
  roles,
}) {
  const issues = [];
  if (!collectionExists || objectType !== 'collection')
    issues.push('ROLE_COLLECTION_UNAVAILABLE');

  for (const role of roles) {
    if (targetRoleCodes.has(role.code)) continue;
    const rolePermissions = Array.isArray(role.permissions)
      ? role.permissions
      : [role.permissions];
    const stringPermissions = rolePermissions.filter(
      (permission) => typeof permission === 'string',
    );
    if (misplacedProjectPermissions(role.code, stringPermissions).length > 0)
      issues.push(`PROJECT_PERMISSION_MAPPING_INVALID:${role.code}`);
  }

  const plannedRoles = PROJECT_ACCESS_PERMISSION_PROVISIONING.roles.map(
    ({ code, permissions }) => {
      const matches = roles.filter((role) => role.code === code);
      if (matches.length === 0) issues.push(`ROLE_MISSING:${code}`);
      if (matches.length > 1) issues.push(`ROLE_DUPLICATE:${code}`);
      const role = matches.length === 1 ? matches[0] : null;
      const id = role ? serializedId(role._id) : null;
      if (role && !id) issues.push(`ROLE_ID_INVALID:${code}`);
      if (role && role.isSystem !== true)
        issues.push(`ROLE_NOT_SYSTEM:${code}`);

      const permissionsFieldMissing =
        role !== null && role.permissions === undefined;
      const existingPermissions = permissionsFieldMissing
        ? []
        : role?.permissions;
      const permissionsAreArray =
        role === null ||
        permissionsFieldMissing ||
        Array.isArray(existingPermissions);
      if (!permissionsAreArray) issues.push(`PERMISSIONS_NOT_ARRAY:${code}`);

      const permissionValues = Array.isArray(existingPermissions)
        ? existingPermissions
        : [];
      if (permissionValues.some((permission) => typeof permission !== 'string'))
        issues.push(`PERMISSIONS_INVALID:${code}`);
      if (new Set(permissionValues).size !== permissionValues.length)
        issues.push(`PERMISSIONS_DUPLICATED:${code}`);

      const stringPermissions = permissionValues.filter(
        (permission) => typeof permission === 'string',
      );
      const misplacedPermissions = misplacedProjectPermissions(
        code,
        stringPermissions,
      );
      if (misplacedPermissions.length > 0)
        issues.push(`PROJECT_PERMISSION_MAPPING_INVALID:${code}`);

      const missingPermissions =
        role && permissionsAreArray
          ? permissions.filter(
              (permission) => !stringPermissions.includes(permission),
            )
          : [];

      return {
        code,
        id,
        isSystem: role?.isSystem ?? null,
        permissionsFieldMissing,
        existingPermissions: stringPermissions,
        missingPermissions,
        misplacedPermissions,
      };
    },
  );

  const clean = issues.length === 0;
  const hasChanges = plannedRoles.some(
    ({ missingPermissions }) => missingPermissions.length > 0,
  );

  return {
    migration: PROJECT_ACCESS_PERMISSION_PROVISIONING.migration,
    databaseName,
    targetFingerprint,
    collectionName: PROJECT_ACCESS_PERMISSION_PROVISIONING.collectionName,
    collectionExists,
    objectType,
    roles: plannedRoles,
    issues,
    clean,
    action: !clean
      ? 'BLOCKED'
      : hasChanges
        ? 'ADD_MISSING_PERMISSIONS'
        : 'NOOP',
  };
}

export function getProjectAccessPermissionRollbackAdditions(originalReport) {
  if (!originalReport || typeof originalReport !== 'object')
    throw new Error(
      'A saved pre-apply dry-run report is required for rollback',
    );
  const { reportSha256, ...originalPlan } = originalReport;
  if (
    originalPlan.migration !==
      PROJECT_ACCESS_PERMISSION_PROVISIONING.migration ||
    originalPlan.clean !== true ||
    typeof reportSha256 !== 'string' ||
    hashProjectAccessPermissionReport(originalPlan) !== reportSha256
  ) {
    throw new Error('The saved pre-apply report is invalid or was modified');
  }

  const expectedRoles = new Map(
    PROJECT_ACCESS_PERMISSION_PROVISIONING.roles.map(
      ({ code, permissions }) => [code, new Set(permissions)],
    ),
  );
  const additions = new Map();
  for (const role of originalPlan.roles ?? []) {
    const allowed = expectedRoles.get(role.code);
    if (!allowed || !role.id || !Array.isArray(role.missingPermissions))
      throw new Error('The saved pre-apply report has an invalid role entry');
    if (
      role.missingPermissions.some((permission) => !allowed.has(permission))
    ) {
      throw new Error(
        'The saved pre-apply report contains an unapproved permission',
      );
    }
    additions.set(role.code, {
      id: role.id,
      permissions: [...role.missingPermissions],
    });
  }
  if (additions.size !== expectedRoles.size)
    throw new Error(
      'The saved pre-apply report does not cover both target Roles',
    );
  return additions;
}
