import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

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

export function assertLeaderPermissionsReceiptKey(key) {
  if (typeof key !== 'string' || Buffer.byteLength(key, 'utf8') < 32) {
    throw new Error(
      'PROJECT_SETTINGS_RECEIPT_KEY must contain at least 32 bytes for apply or rollback',
    );
  }
  return key;
}

function leaderPermissionsReceiptHmac(payload, key) {
  return createHmac('sha256', assertLeaderPermissionsReceiptKey(key))
    .update(JSON.stringify(payload))
    .digest('hex');
}

function matchesLeaderPermissionsReceiptHmac(actual, expected, payload, key) {
  if (
    typeof actual !== 'string' ||
    !/^[\da-f]{64}$/i.test(actual) ||
    typeof expected !== 'string' ||
    !/^[\da-f]{64}$/i.test(expected)
  ) {
    return false;
  }
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const computedBuffer = Buffer.from(
    leaderPermissionsReceiptHmac(payload, key),
    'hex',
  );
  return (
    timingSafeEqual(actualBuffer, expectedBuffer) &&
    timingSafeEqual(actualBuffer, computedBuffer)
  );
}

function sameStringArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
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
    name: leaderRole?.name ?? null,
    id: leaderId,
    isSystem: leaderRole?.isSystem ?? null,
    permissionsFieldMissing,
    existingPermissions: stringPermissions,
    missingPermissions: permissionsToAdd,
    permissionsToAdd,
    permissionsUnchanged,
    expectedPermissions: [...stringPermissions, ...permissionsToAdd],
  };

  const clean = issues.length === 0;
  const hasChanges = permissionsToAdd.length > 0;

  return {
    migration: PROJECT_SETTINGS_LEADER_PERMISSIONS_PROVISIONING.migration,
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

export function createLeaderPermissionsApplyReceipt(
  plan,
  afterPlan,
  addedPermissions,
  receiptKey,
) {
  assertLeaderPermissionsReceiptKey(receiptKey);
  if (
    !plan ||
    plan.clean !== true ||
    plan.action === 'NOOP' ||
    !afterPlan ||
    afterPlan.clean !== true ||
    plan.databaseName !== afterPlan.databaseName ||
    plan.targetFingerprint !== afterPlan.targetFingerprint ||
    plan.role?.id !== afterPlan.role?.id ||
    plan.role?.name !== afterPlan.role?.name ||
    plan.role?.isSystem !== afterPlan.role?.isSystem ||
    !Array.isArray(plan.role?.missingPermissions) ||
    !sameStringArray(addedPermissions, plan.role.missingPermissions) ||
    !Array.isArray(afterPlan.role?.existingPermissions) ||
    afterPlan.role.missingPermissions.length > 0 ||
    addedPermissions.some(
      (permission) => !afterPlan.role.existingPermissions.includes(permission),
    )
  ) {
    throw new Error('Cannot create an apply receipt from an unverified result');
  }

  const receipt = {
    migration: plan.migration,
    databaseName: plan.databaseName,
    targetFingerprint: plan.targetFingerprint,
    sourceReportSha256: hashLeaderPermissionsReport(plan),
    role: {
      code: plan.role.code,
      name: plan.role.name,
      id: plan.role.id,
      isSystem: plan.role.isSystem,
      addedPermissions: [...addedPermissions],
      permissionsAfter: [...afterPlan.role.existingPermissions],
    },
  };

  return {
    ...receipt,
    receiptHmac: leaderPermissionsReceiptHmac(receipt, receiptKey),
  };
}

export function getLeaderPermissionsRollbackAdditions(
  applyReport,
  currentPlan,
  expectedApplyReceiptHmac,
  receiptKey,
) {
  if (!applyReport || typeof applyReport !== 'object') {
    throw new Error('A verified apply report is required for rollback');
  }
  const { reportSha256, result, ...originalPlan } = applyReport;
  if (
    originalPlan.migration !==
      PROJECT_SETTINGS_LEADER_PERMISSIONS_PROVISIONING.migration ||
    originalPlan.clean !== true ||
    typeof reportSha256 !== 'string' ||
    hashLeaderPermissionsReport(originalPlan) !== reportSha256
  ) {
    throw new Error('The saved apply report is invalid or was modified');
  }

  const role = originalPlan.role;
  if (
    !role ||
    role.code !== 'TEAM_LEADER' ||
    !role.id ||
    !Array.isArray(role.missingPermissions) ||
    role.missingPermissions.some(
      (permission) => !approvedSet.has(permission),
    ) ||
    new Set(role.missingPermissions).size !== role.missingPermissions.length
  ) {
    throw new Error('The saved apply report has an invalid role entry');
  }
  if (
    result?.action !== 'APPLIED' ||
    result.verified !== true ||
    !Number.isInteger(result.addedPermissions) ||
    result.addedPermissions <= 0 ||
    !result.applyReceipt
  ) {
    throw new Error(
      'A verified apply report and its receipt are required for rollback',
    );
  }

  const receipt = result.applyReceipt;
  const { receiptHmac, ...receiptPayload } = receipt;
  if (
    !matchesLeaderPermissionsReceiptHmac(
      receiptHmac,
      expectedApplyReceiptHmac,
      receiptPayload,
      receiptKey,
    )
  ) {
    throw new Error('The apply receipt authentication failed');
  }

  const receiptRole = receiptPayload.role;
  if (
    receiptPayload.migration !== originalPlan.migration ||
    receiptPayload.databaseName !== originalPlan.databaseName ||
    receiptPayload.targetFingerprint !== originalPlan.targetFingerprint ||
    receiptPayload.sourceReportSha256 !== reportSha256 ||
    receiptRole?.code !== role.code ||
    receiptRole?.name !== role.name ||
    receiptRole.id !== role.id ||
    receiptRole.isSystem !== role.isSystem ||
    !sameStringArray(receiptRole.addedPermissions, role.missingPermissions) ||
    result.addedPermissions !== receiptRole.addedPermissions.length ||
    !Array.isArray(receiptRole.permissionsAfter) ||
    receiptRole.permissionsAfter.some(
      (permission) => typeof permission !== 'string',
    ) ||
    new Set(receiptRole.permissionsAfter).size !==
      receiptRole.permissionsAfter.length ||
    !role.missingPermissions.every((permission) =>
      receiptRole.permissionsAfter.includes(permission),
    )
  ) {
    throw new Error('The apply receipt does not match the saved apply report');
  }

  if (
    !currentPlan ||
    currentPlan.databaseName !== originalPlan.databaseName ||
    currentPlan.targetFingerprint !== originalPlan.targetFingerprint
  ) {
    throw new Error('Rollback report targets a different MongoDB database');
  }
  if (currentPlan.role?.id !== role.id) {
    throw new Error(
      'Rollback stopped because TEAM_LEADER Role identity changed since the verified apply',
    );
  }
  if (
    currentPlan.role?.name !== role.name ||
    currentPlan.role?.isSystem !== role.isSystem
  ) {
    throw new Error(
      'Rollback stopped because TEAM_LEADER Role identity changed since the verified apply',
    );
  }
  if (
    !sameStringArray(
      currentPlan.role.existingPermissions,
      receiptRole.permissionsAfter,
    )
  ) {
    throw new Error(
      'Rollback stopped because Role permissions changed since the verified apply',
    );
  }

  return {
    id: role.id,
    permissions: [...receiptRole.addedPermissions],
  };
}
