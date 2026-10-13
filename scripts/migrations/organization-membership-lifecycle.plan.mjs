import { createHash } from 'node:crypto';
export const TRACKING_FIELDS = Object.freeze({
  users: { mutationFence: 0 },
  organizations: { membershipAdminRevision: 0 },
  organization_memberships: { version: 1, mutationFence: 0 },
  organization_invitations: { contractVersion: 1, version: 1 },
  roles: { mutationFence: 0 },
  role_assignments: { mutationFence: 0 },
});
export const MEMBERSHIP_PERMISSIONS = [
  'organization.memberships.read',
  'organization.memberships.manage',
];
export const MEMBERSHIP_INDEXES = [
  {
    collection: 'organization_memberships',
    spec: {
      name: 'organizationId_1_userId_1',
      key: { organizationId: 1, userId: 1 },
      unique: true,
    },
  },
  {
    collection: 'organization_memberships',
    spec: {
      name: 'membership_list',
      key: { organizationId: 1, createdAt: -1, _id: -1 },
    },
  },
  {
    collection: 'organization_memberships',
    spec: {
      name: 'membership_status_list',
      key: { organizationId: 1, status: 1, createdAt: -1, _id: -1 },
    },
  },
  {
    collection: 'organization_invitations',
    spec: {
      name: 'uniq_pending_org_email',
      key: { organizationId: 1, email: 1 },
      unique: true,
      partialFilterExpression: { status: 'PENDING' },
    },
  },
  {
    collection: 'organization_invitations',
    spec: {
      name: 'uniq_pending_membership_v2',
      key: { membershipId: 1 },
      unique: true,
      partialFilterExpression: { contractVersion: 2, status: 'PENDING' },
    },
  },
  {
    collection: 'organization_invitations',
    spec: {
      name: 'membership_invitation_history',
      key: { membershipId: 1, createdAt: -1, _id: -1 },
    },
  },
  {
    collection: 'membership_operations',
    spec: {
      name: 'membership_operation_key',
      key: { actorUserId: 1, organizationId: 1, keyHash: 1 },
      unique: true,
    },
  },
  {
    collection: 'membership_operations',
    spec: {
      name: 'membership_operation_expiry',
      key: { expiresAt: 1 },
      expireAfterSeconds: 0,
    },
  },
  {
    collection: 'membership_operations',
    spec: {
      name: 'membership_invitation_quota',
      key: { organizationId: 1, actorUserId: 1, committedAt: 1 },
    },
  },
];
const memberStates = new Set([
  'PENDING_INVITE',
  'ACTIVE',
  'SUSPENDED',
  'REMOVED',
]);
const legacyStates = new Set(['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED']);
const inviteStates = new Set([
  'PENDING',
  'ACCEPTED',
  'CANCELLED',
  'EXPIRED',
  'SUPERSEDED',
]);
const roleCodes = new Set(['ADMIN', 'TEAM_LEADER', 'MEMBER']);
const id = (value) => typeof value === 'string' && /^[a-f\d]{24}$/.test(value);
const date = (value) =>
  typeof value === 'string' && Number.isFinite(new Date(value).getTime());
const own = (row, key) => Object.hasOwn(row, key);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const lifecycleHash = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
export function sameLifecycleIndex(actual, desired) {
  return (
    JSON.stringify(actual.key) === JSON.stringify(desired.key) &&
    Boolean(actual.unique) === Boolean(desired.unique) &&
    !actual.sparse &&
    actual.expireAfterSeconds === desired.expireAfterSeconds &&
    lifecycleHash(actual.partialFilterExpression ?? null) ===
      lifecycleHash(desired.partialFilterExpression ?? null) &&
    (!actual.collation || actual.collation.locale === 'simple')
  );
}
export function planMembershipLifecycle(snapshot) {
  const issues = [],
    updates = [],
    rowFingerprints = [];
  const rows = Object.fromEntries(
    Object.keys(TRACKING_FIELDS).map((name) => [
      name,
      [...(snapshot.rows[name] ?? [])].sort((a, b) =>
        String(a._id).localeCompare(String(b._id)),
      ),
    ]),
  );
  for (const [collection, defaults] of Object.entries(TRACKING_FIELDS)) {
    if (
      snapshot.objects[collection]?.type !== 'collection' &&
      collection !== 'organization_invitations'
    )
      issues.push(`COLLECTION_UNAVAILABLE:${collection}`);
    if (
      snapshot.objects[collection] &&
      snapshot.objects[collection].type !== 'collection'
    )
      issues.push(`COLLECTION_UNAVAILABLE:${collection}`);
    for (const row of rows[collection]) {
      if (!id(row._id)) issues.push(`INVALID_DOCUMENT_ID:${collection}`);
      rowFingerprints.push({
        collection,
        id: row._id,
        fingerprint: lifecycleHash(row),
      });
      const set = {};
      for (const [field, initial] of Object.entries(defaults)) {
        if (!own(row, field)) set[field] = initial;
        else if (
          !Number.isSafeInteger(row[field]) ||
          row[field] < initial ||
          (field === 'contractVersion' && ![1, 2].includes(row[field]))
        )
          issues.push(
            `INVALID_TRACKING_FIELD:${collection}:${row._id}:${field}`,
          );
      }
      if (Object.keys(set).length)
        updates.push({ collection, id: row._id, set });
    }
  }
  const users = new Map(rows.users.map((row) => [row._id, row]));
  const organizations = new Set(rows.organizations.map((row) => row._id));
  const memberships = new Map(
    rows.organization_memberships.map((row) => [row._id, row]),
  );
  const roles = new Map(rows.roles.map((row) => [row._id, row]));
  for (const user of users.values())
    if (!['ACTIVE', 'SUSPENDED', 'PENDING_INVITE'].includes(user.status))
      issues.push(`USER_STATUS_INVALID:${user._id}`);
  const pairs = new Map();
  for (const member of memberships.values()) {
    const pair = `${member.organizationId}:${member.userId}`;
    if (pairs.has(pair)) issues.push(`DUPLICATE_MEMBERSHIP_PAIR:${pair}`);
    pairs.set(pair, member);
    if (
      !organizations.has(member.organizationId) ||
      !users.has(member.userId) ||
      !memberStates.has(member.status)
    )
      issues.push(`MEMBERSHIP_REFERENCE_OR_STATE_INVALID:${member._id}`);
    if (!date(member.createdAt) || !date(member.updatedAt))
      issues.push(`MEMBERSHIP_TIMESTAMPS_INVALID:${member._id}`);
  }
  const systemAdmins = rows.roles.filter(
    (row) => row.code === 'ADMIN' && row.isSystem === true,
  );
  if (systemAdmins.length !== 1)
    issues.push('SYSTEM_ADMIN_ROLE_UNAVAILABLE_OR_AMBIGUOUS');
  const permissionAdditions = [];
  const seenRoleCodes = new Set();
  for (const role of roles.values()) {
    if (!roleCodes.has(role.code) || seenRoleCodes.has(role.code))
      issues.push(`ROLE_CODE_INVALID_OR_DUPLICATE:${role._id}`);
    seenRoleCodes.add(role.code);
    const permissions = role.permissions ?? [];
    if (
      (own(role, 'permissions') && !Array.isArray(role.permissions)) ||
      !permissions.every((value) => typeof value === 'string')
    ) {
      issues.push(`ROLE_PERMISSIONS_INVALID:${role._id}`);
      continue;
    }
    if (
      role.code !== 'ADMIN' &&
      permissions.some((value) => MEMBERSHIP_PERMISSIONS.includes(value))
    )
      issues.push(`MISPLACED_MEMBERSHIP_PERMISSION:${role._id}`);
    if (role.code === 'ADMIN' && role.isSystem === true)
      permissionAdditions.push({
        id: role._id,
        code: role.code,
        existingPermissions: permissions,
        permissionsFieldMissing: !own(role, 'permissions'),
        missingPermissions: MEMBERSHIP_PERMISSIONS.filter(
          (value) => !permissions.includes(value),
        ),
      });
  }
  const eligible = new Set();
  for (const assignment of rows.role_assignments) {
    const role = roles.get(assignment.roleId);
    if (
      !organizations.has(assignment.organizationId) ||
      !users.has(assignment.userId) ||
      !role ||
      role.code !== assignment.roleCode ||
      (own(assignment, 'projectId') &&
        assignment.projectId !== null &&
        !id(assignment.projectId))
    )
      issues.push(`ROLE_ASSIGNMENT_MISMATCH:${assignment._id}`);
    const member = pairs.get(
      `${assignment.organizationId}:${assignment.userId}`,
    );
    if (
      role?.isSystem === true &&
      role.code === 'ADMIN' &&
      assignment.roleCode === 'ADMIN' &&
      assignment.projectId == null &&
      member?.status === 'ACTIVE' &&
      users.get(assignment.userId)?.status === 'ACTIVE'
    )
      eligible.add(assignment.organizationId);
  }
  for (const organization of organizations)
    if (!eligible.has(organization))
      issues.push(`NO_ELIGIBLE_ADMIN:${organization}`);
  const pendingEmails = new Set(),
    pendingPairs = new Set(),
    legacyPendingInvitations = [];
  for (const invite of rows.organization_invitations) {
    const profile = invite.contractVersion ?? 1;
    for (const field of ['acceptedBy', 'revokedBy'])
      if (own(invite, field) && invite[field] !== null && !id(invite[field]))
        issues.push(
          `INVITATION_ACTOR_REFERENCE_INVALID:${invite._id}:${field}`,
        );
    if (
      !organizations.has(invite.organizationId) ||
      !invite.emailNormalized ||
      !date(invite.expiresAt) ||
      !date(invite.createdAt)
    )
      issues.push(`INVITATION_SHAPE_INVALID:${invite._id}`);
    if (profile === 1) {
      if (
        !legacyStates.has(invite.status) ||
        !roleCodes.has(invite.roleCode) ||
        own(invite, 'membershipId') ||
        own(invite, 'targetUserId')
      )
        issues.push(`LEGACY_INVITATION_INVALID:${invite._id}`);
      if (invite.status === 'PENDING')
        legacyPendingInvitations.push(invite._id);
    } else {
      const member = memberships.get(invite.membershipId);
      if (
        !inviteStates.has(invite.status) ||
        own(invite, 'roleCode') ||
        !member ||
        member.organizationId !== invite.organizationId ||
        member.userId !== invite.targetUserId ||
        (invite.status === 'PENDING' && member.status !== 'PENDING_INVITE')
      )
        issues.push(`INVITATION_BINDING_INVALID:${invite._id}`);
      if (invite.status === 'PENDING') {
        if (pendingPairs.has(invite.membershipId))
          issues.push(`DUPLICATE_PENDING_INVITATION:${invite.membershipId}`);
        pendingPairs.add(invite.membershipId);
      }
    }
    if (invite.status === 'PENDING') {
      const key = `${invite.organizationId}:${invite.emailHash}`;
      if (pendingEmails.has(key))
        issues.push(`DUPLICATE_PENDING_EMAIL:${invite._id}`);
      pendingEmails.add(key);
    }
  }
  for (const collection of [
    'organization_invitations',
    'organization_memberships',
  ])
    for (const actual of snapshot.objects[collection]?.indexes ?? [])
      if (own(actual, 'expireAfterSeconds'))
        issues.push(`RETENTION_TTL_CONFLICT:${collection}:${actual.name}`);
  const indexes = MEMBERSHIP_INDEXES.map(({ collection, spec }) => {
    const object = snapshot.objects[collection];
    if (object && object.type !== 'collection')
      issues.push(`COLLECTION_UNAVAILABLE:${collection}`);
    const byName = object?.indexes.find((actual) => actual.name === spec.name);
    const equivalent = object?.indexes.find((actual) =>
      sameLifecycleIndex(actual, spec),
    );
    if (byName && !sameLifecycleIndex(byName, spec))
      issues.push(`INDEX_CONFLICT:${collection}:${spec.name}`);
    return { collection, spec, action: equivalent ? 'EXISTS' : 'CREATE' };
  });
  if (
    snapshot.operationsCount > 0 &&
    (updates.length ||
      permissionAdditions.some((row) => row.missingPermissions.length) ||
      indexes.some((row) => row.action === 'CREATE'))
  )
    issues.push('LIVE_OPERATION_CACHE_REQUIRES_CUTOVER');
  if (updates.length > 1000)
    issues.push('TRACKING_BACKFILL_EXCEEDS_SINGLE_TRANSACTION_LIMIT');
  const report = {
    migration: '20261012-organization-membership-lifecycle-v1',
    schemaVersion: 1,
    databaseName: snapshot.databaseName,
    targetFingerprint: snapshot.targetFingerprint,
    clean: issues.length === 0,
    issues: [...new Set(issues)].sort(),
    updates,
    permissionAdditions,
    indexes,
    rowFingerprints,
    legacyPendingInvitations,
    operationsCount: snapshot.operationsCount,
  };
  return { ...report, reportSha256: lifecycleHash(report) };
}
