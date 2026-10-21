import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const DATABASE_NAME = 'continuum_iam';
export const REQUIRED_COLLECTIONS = Object.freeze([
  'role_assignments',
  'roles',
  'users',
  'organizations',
  'organization_memberships',
  'projects',
  'project_memberships',
]);

const MAX_EXECUTION_MINUTES = 30;
const MAX_ASSIGNMENTS = 250_000;
const MAX_RELATED_ROWS = 5_000;
const BATCH_SIZE = 500;
const QUERY_MAX_TIME_MS = 30_000;
const READ_ONLY_ACTIONS = new Set(['find', 'listCollections']);

const CLASSIFICATIONS = Object.freeze([
  'VALID',
  'ORPHAN_SCOPE',
  'ORPHAN_SUBJECT',
  'UNMAPPED_ROLE',
  'POLICY_VIOLATION',
  'DUPLICATE_SCOPE_LINK',
  'LEGACY',
  'UNVERIFIED',
]);

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value, label, maxLength = 512) {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    /[\r\n]/.test(value) ||
    /mongodb(?:\+srv)?:\/\//i.test(value) ||
    /\bBearer\s+\S+/i.test(value)
  ) {
    throw new Error('MANIFEST_INVALID: ' + label);
  }
  return value.trim();
}

function requiredStatus(evidence, label) {
  if (!record(evidence) || evidence.status !== 'VERIFIED') {
    throw new Error('EVIDENCE_NOT_VERIFIED: ' + label);
  }
  requiredString(evidence.reference, label + '.reference');
  requiredString(evidence.verifiedBy, label + '.verifiedBy');
  timestamp(evidence.verifiedAt, label + '.verifiedAt');
}

function timestamp(value, label) {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error('MANIFEST_INVALID: ' + label);
  }
  return Date.parse(value);
}

function normalizeHost(value) {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  const bracketed = host.match(/^\[([0-9a-f:.%]+)\](?::(\d{1,5}))?$/i);
  const plain = bracketed
    ? null
    : host.match(/^([a-z0-9.-]+)(?::(\d{1,5}))?$/i);
  const match = bracketed ?? plain;
  if (!match) return null;
  const hostname = match[1].replace(/\.$/, '');
  const port = match[2] === undefined ? 27017 : Number(match[2]);
  if (!hostname || port < 1 || port > 65535) return null;
  return (
    (hostname.includes(':') ? '[' + hostname + ']' : hostname) + ':' + port
  );
}

export function parseMongoUriHosts(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('mongodb://')) {
    throw new Error('MONGODB_URI_INVALID');
  }
  const match = uri.match(/^mongodb:\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/i);
  if (!match) throw new Error('MONGODB_URI_INVALID');
  const authority = match[1];
  const hostList = authority.slice(authority.lastIndexOf('@') + 1);
  const hosts = hostList.split(',').map(normalizeHost);
  if (hosts.length === 0 || hosts.some((host) => host === null)) {
    throw new Error('MONGODB_URI_INVALID');
  }
  const dbPath = match[2] ?? '';
  if (dbPath !== '' && dbPath !== '/' && dbPath !== '/' + DATABASE_NAME) {
    throw new Error('MONGODB_URI_DATABASE_MISMATCH');
  }
  const query = new URLSearchParams((match[3] ?? '').replace(/^\?/, ''));
  if (
    query.get('directConnection') === 'true' ||
    query.get('loadBalanced') === 'true' ||
    query.get('tlsInsecure') === 'true' ||
    query.get('tlsAllowInvalidCertificates') === 'true' ||
    query.get('tlsAllowInvalidHostnames') === 'true'
  ) {
    throw new Error('MONGODB_URI_UNSAFE_OPTION');
  }
  if (
    hosts.some(
      (host) =>
        !host.startsWith('127.') &&
        !host.startsWith('[::1]:') &&
        !host.startsWith('localhost:'),
    ) &&
    query.get('tls') !== 'true' &&
    query.get('ssl') !== 'true'
  ) {
    throw new Error('MONGODB_URI_TLS_REQUIRED');
  }
  return [...new Set(hosts)].sort();
}

export function validateManifest(manifest, options = {}) {
  const now = options.now ?? Date.now();
  if (!record(manifest) || manifest.schemaVersion !== 1) {
    throw new Error('MANIFEST_INVALID: schemaVersion');
  }

  const snapshot = manifest.snapshot;
  const restore = manifest.restore;
  const database = manifest.database;
  const authorization = manifest.authorization;
  const window = manifest.executionWindow;
  if (
    !record(snapshot) ||
    !record(restore) ||
    !record(restore.target) ||
    !record(database) ||
    !record(authorization) ||
    !record(window)
  ) {
    throw new Error('MANIFEST_INVALID: required sections');
  }

  requiredString(snapshot.id, 'snapshot.id');
  if (snapshot.sourceEnvironment !== 'STAGING') {
    throw new Error('SNAPSHOT_SOURCE_MUST_BE_STAGING');
  }
  requiredString(snapshot.classification, 'snapshot.classification');
  requiredString(snapshot.approver, 'snapshot.approver');
  requiredString(snapshot.approvalReference, 'snapshot.approvalReference');
  const snapshotCreatedAt = timestamp(snapshot.createdAt, 'snapshot.createdAt');
  const retentionExpiry = timestamp(
    snapshot.retentionExpiresAt,
    'snapshot.retentionExpiresAt',
  );
  if (retentionExpiry <= now) throw new Error('SNAPSHOT_RETENTION_EXPIRED');
  if (
    !Array.isArray(snapshot.collectionScope) ||
    REQUIRED_COLLECTIONS.some(
      (name) => !snapshot.collectionScope.includes(name),
    )
  ) {
    throw new Error('SNAPSHOT_SCOPE_INCOMPLETE');
  }
  if (
    !record(snapshot.integrity) ||
    snapshot.integrity.status !== 'VERIFIED' ||
    snapshot.integrity.algorithm !== 'SHA-256' ||
    typeof snapshot.integrity.checksum !== 'string' ||
    !/^[a-f\d]{64}$/i.test(snapshot.integrity.checksum)
  ) {
    throw new Error('SNAPSHOT_INTEGRITY_NOT_VERIFIED');
  }
  requiredStatus(snapshot.integrity, 'snapshot.integrity');
  if (
    timestamp(snapshot.integrity.verifiedAt, 'snapshot.integrity.verifiedAt') <
    snapshotCreatedAt
  ) {
    throw new Error('SNAPSHOT_INTEGRITY_TIME_INVALID');
  }

  requiredString(restore.runId, 'restore.runId');
  if (restore.sourceSnapshotId !== snapshot.id) {
    throw new Error('RESTORE_SNAPSHOT_MISMATCH');
  }
  requiredString(restore.toolVersion, 'restore.toolVersion');
  const restoredAt = timestamp(restore.restoredAt, 'restore.restoredAt');
  if (restoredAt < snapshotCreatedAt) {
    throw new Error('RESTORE_BEFORE_SNAPSHOT');
  }
  requiredStatus(restore.integrity, 'restore.integrity');
  const target = restore.target;
  requiredString(target.identity, 'restore.target.identity');
  if (target.databaseName !== DATABASE_NAME) {
    throw new Error('TARGET_DATABASE_MISMATCH');
  }
  requiredString(target.replicaSetName, 'restore.target.replicaSetName');
  if (restore.integrity.targetIdentity !== target.identity) {
    throw new Error('RESTORE_INTEGRITY_TARGET_MISMATCH');
  }
  if (
    timestamp(restore.integrity.verifiedAt, 'restore.integrity.verifiedAt') <
    restoredAt
  ) {
    throw new Error('RESTORE_INTEGRITY_TIME_INVALID');
  }
  if (!Array.isArray(target.hosts) || target.hosts.length === 0) {
    throw new Error('MANIFEST_INVALID: restore.target.hosts');
  }
  const expectedHosts = target.hosts.map(normalizeHost);
  if (expectedHosts.some((host) => host === null)) {
    throw new Error('MANIFEST_INVALID: restore.target.hosts');
  }
  requiredStatus(restore.networkIsolation, 'restore.networkIsolation');
  if (restore.networkIsolation.targetIdentity !== target.identity) {
    throw new Error('NETWORK_EVIDENCE_TARGET_MISMATCH');
  }
  if (
    timestamp(
      restore.networkIsolation.verifiedAt,
      'restore.networkIsolation.verifiedAt',
    ) < restoredAt
  ) {
    throw new Error('NETWORK_EVIDENCE_TIME_INVALID');
  }

  if (database.targetIdentity !== target.identity) {
    throw new Error('DATABASE_EVIDENCE_TARGET_MISMATCH');
  }
  requiredString(database.accountName, 'database.accountName');
  requiredString(
    database.authenticationDatabase,
    'database.authenticationDatabase',
  );
  requiredStatus(database.effectivePrivileges, 'database.effectivePrivileges');
  requiredStatus(database.writeDenial, 'database.writeDenial');
  assertMinimumPrivileges(database.effectivePrivileges.privileges);
  if (
    timestamp(
      database.effectivePrivileges.verifiedAt,
      'database.effectivePrivileges.verifiedAt',
    ) < restoredAt ||
    timestamp(
      database.writeDenial.verifiedAt,
      'database.writeDenial.verifiedAt',
    ) < restoredAt
  ) {
    throw new Error('DATABASE_EVIDENCE_TIME_INVALID');
  }
  if (
    database.effectivePrivileges.targetIdentity !== target.identity ||
    database.effectivePrivileges.accountName !== database.accountName
  ) {
    throw new Error('PRIVILEGE_EVIDENCE_TARGET_MISMATCH');
  }
  if (database.writeDenial.targetIdentity !== target.identity) {
    throw new Error('WRITE_DENIAL_TARGET_MISMATCH');
  }
  if (database.writeDenial.accountName !== database.accountName) {
    throw new Error('WRITE_DENIAL_ACCOUNT_MISMATCH');
  }

  requiredStatus(authorization.projectLead, 'authorization.projectLead');
  requiredString(
    authorization.projectLead.scope,
    'authorization.projectLead.scope',
  );
  requiredString(
    authorization.projectLead.approvedBy,
    'authorization.projectLead.approvedBy',
  );
  timestamp(
    authorization.projectLead.authorizedAt,
    'authorization.projectLead.authorizedAt',
  );
  requiredStatus(window.confirmation, 'executionWindow.confirmation');
  requiredString(window.operator, 'executionWindow.operator');
  requiredString(
    window.targetConfirmationReference,
    'executionWindow.targetConfirmationReference',
  );
  timestamp(window.confirmedAt, 'executionWindow.confirmedAt');
  if (window.targetIdentity !== target.identity) {
    throw new Error('EXECUTION_TARGET_MISMATCH');
  }
  const start = timestamp(window.startAt, 'executionWindow.startAt');
  const end = timestamp(window.endAt, 'executionWindow.endAt');
  if (retentionExpiry <= end) {
    throw new Error('SNAPSHOT_RETENTION_EXPIRES_BEFORE_WINDOW_END');
  }
  if (
    timestamp(
      database.effectivePrivileges.verifiedAt,
      'database.effectivePrivileges.verifiedAt',
    ) > start ||
    timestamp(
      database.writeDenial.verifiedAt,
      'database.writeDenial.verifiedAt',
    ) > start ||
    timestamp(
      restore.networkIsolation.verifiedAt,
      'restore.networkIsolation.verifiedAt',
    ) > start
  ) {
    throw new Error('PRECONDITION_EVIDENCE_AFTER_WINDOW_START');
  }
  const approvedDuration = authorization.projectLead.maxExecutionMinutes;
  if (
    !Number.isInteger(approvedDuration) ||
    approvedDuration < 1 ||
    approvedDuration > MAX_EXECUTION_MINUTES
  ) {
    throw new Error('EXECUTION_BOUND_INVALID');
  }
  if (end <= start || end - start > approvedDuration * 60_000) {
    throw new Error('EXECUTION_WINDOW_INVALID');
  }
  if (
    window.confirmedAt > start ||
    timestamp(
      authorization.projectLead.authorizedAt,
      'authorization.projectLead.authorizedAt',
    ) > start
  ) {
    throw new Error('EXECUTION_AUTHORIZATION_AFTER_WINDOW');
  }
  if (
    timestamp(
      window.confirmation.verifiedAt,
      'executionWindow.confirmation.verifiedAt',
    ) > start
  ) {
    throw new Error('EXECUTION_CONFIRMATION_AFTER_WINDOW');
  }
  if (options.requireActiveWindow) {
    if (now < start) throw new Error('EXECUTION_WINDOW_NOT_STARTED');
    if (now >= end) throw new Error('EXECUTION_WINDOW_EXPIRED');
    if (now - start >= approvedDuration * 60_000) {
      throw new Error('EXECUTION_BOUND_EXCEEDED');
    }
  }

  return {
    expectedHosts: [...new Set(expectedHosts)].sort(),
    executionWindowEnd: end,
    maxExecutionMs: approvedDuration * 60_000,
  };
}

function idKey(value) {
  if (typeof value === 'string' && /^[a-f\d]{24}$/i.test(value))
    return value.toLowerCase();
  if (value && typeof value.toHexString === 'function') {
    const encoded = value.toHexString();
    return /^[a-f\d]{24}$/i.test(encoded) ? encoded.toLowerCase() : null;
  }
  return null;
}

function pairKey(first, second) {
  return (idKey(first) ?? '<invalid>') + '|' + (idKey(second) ?? '<invalid>');
}

function tripleKey(first, second, third) {
  return pairKey(first, second) + '|' + (idKey(third) ?? '<invalid>');
}

function indexBy(rows, keyFunction) {
  const result = new Map();
  for (const row of rows) {
    const key = keyFunction(row);
    const values = result.get(key) ?? [];
    values.push(row);
    result.set(key, values);
  }
  return result;
}

function mapById(rows) {
  const result = new Map();
  for (const row of rows) {
    const key = idKey(row?._id);
    if (key !== null) result.set(key, row);
  }
  return result;
}

function isDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function classifyAssignment(assignment, evidence) {
  const projectScoped =
    assignment.projectId !== undefined && assignment.projectId !== null;
  const scope = projectScoped ? 'PROJECT' : 'ORGANIZATION';
  const roleCode =
    assignment.roleCode === 'ADMIN' ||
    assignment.roleCode === 'TEAM_LEADER' ||
    assignment.roleCode === 'MEMBER'
      ? assignment.roleCode
      : 'UNKNOWN';
  const inactiveReasons = [];
  const assignmentUserId = idKey(assignment.userId);
  const assignmentOrgId = idKey(assignment.organizationId);
  const assignmentProjectId = projectScoped
    ? idKey(assignment.projectId)
    : null;
  const user =
    assignmentUserId === null
      ? undefined
      : evidence.users.get(assignmentUserId);
  const organization =
    assignmentOrgId === null
      ? undefined
      : evidence.organizations.get(assignmentOrgId);
  const project =
    assignmentProjectId === null
      ? undefined
      : evidence.projects.get(assignmentProjectId);
  const organizationMemberships =
    assignmentOrgId === null || assignmentUserId === null
      ? []
      : (evidence.organizationMemberships.get(
          pairKey(assignment.organizationId, assignment.userId),
        ) ?? []);
  const organizationMembership =
    organizationMemberships.length === 1
      ? organizationMemberships[0]
      : undefined;
  const projectMemberships =
    projectScoped &&
    assignmentOrgId !== null &&
    assignmentProjectId !== null &&
    assignmentUserId !== null
      ? (evidence.projectMemberships.get(
          tripleKey(
            assignment.organizationId,
            assignment.projectId,
            assignment.userId,
          ),
        ) ?? [])
      : [];
  const projectMembership =
    projectMemberships.length === 1 ? projectMemberships[0] : undefined;
  const roleId = idKey(assignment.roleId);
  const role = roleId === null ? undefined : evidence.roles.get(roleId);

  if (user && user.status !== 'ACTIVE') inactiveReasons.push('USER_NOT_ACTIVE');
  if (organizationMembership && organizationMembership.status !== 'ACTIVE') {
    inactiveReasons.push('ORGANIZATION_MEMBERSHIP_NOT_ACTIVE');
  }
  if (project && project.status !== 'ACTIVE')
    inactiveReasons.push('PROJECT_NOT_ACTIVE');
  if (projectMembership && projectMembership.status !== 'ACTIVE') {
    inactiveReasons.push('PROJECT_MEMBERSHIP_NOT_ACTIVE');
  }

  if (!assignmentOrgId || !organization) {
    return {
      scope,
      classification: 'ORPHAN_SCOPE',
      reasonCode: 'ORGANIZATION_NOT_FOUND',
      inactive: inactiveReasons.length > 0,
      inactiveReasons,
      roleCode,
    };
  }
  if (
    projectScoped &&
    (!assignmentProjectId ||
      !project ||
      idKey(project.organizationId) !== assignmentOrgId)
  ) {
    return {
      scope,
      classification: 'ORPHAN_SCOPE',
      reasonCode: 'PROJECT_SCOPE_INVALID',
      inactive: inactiveReasons.length > 0,
      inactiveReasons,
      roleCode,
    };
  }
  if (!assignmentUserId || !user || organizationMemberships.length === 0) {
    return {
      scope,
      classification: 'ORPHAN_SUBJECT',
      reasonCode: 'USER_OR_ORGANIZATION_MEMBERSHIP_NOT_FOUND',
      inactive: inactiveReasons.length > 0,
      inactiveReasons,
      roleCode,
    };
  }
  if (organizationMemberships.length > 1) {
    return {
      scope,
      classification: 'DUPLICATE_SCOPE_LINK',
      reasonCode: 'MULTIPLE_ORGANIZATION_MEMBERSHIPS',
      inactive: inactiveReasons.length > 0,
      inactiveReasons,
      roleCode,
    };
  }
  if (projectScoped && projectMemberships.length === 0) {
    return {
      scope,
      classification: 'ORPHAN_SUBJECT',
      reasonCode: 'PROJECT_MEMBERSHIP_NOT_FOUND',
      inactive: inactiveReasons.length > 0,
      inactiveReasons,
      roleCode,
    };
  }
  if (projectScoped && projectMemberships.length > 1) {
    return {
      scope,
      classification: 'DUPLICATE_SCOPE_LINK',
      reasonCode: 'MULTIPLE_PROJECT_MEMBERSHIPS',
      inactive: inactiveReasons.length > 0,
      inactiveReasons,
      roleCode,
    };
  }
  if (!role || role.code !== assignment.roleCode) {
    return {
      scope,
      classification: 'UNMAPPED_ROLE',
      reasonCode: 'ROLE_CATALOG_MISSING_OR_MISMATCHED',
      inactive: inactiveReasons.length > 0,
      inactiveReasons,
      roleCode,
    };
  }
  if (role.isSystem !== true) {
    return {
      scope,
      classification: 'POLICY_VIOLATION',
      reasonCode: 'ROLE_NOT_SYSTEM_CATALOG_ENTRY',
      inactive: inactiveReasons.length > 0,
      inactiveReasons,
      roleCode,
    };
  }
  const validScopedRole =
    scope === 'ORGANIZATION'
      ? role.code === 'ADMIN' || role.code === 'MEMBER'
      : role.code === 'TEAM_LEADER' || role.code === 'MEMBER';
  if (!validScopedRole) {
    return {
      scope,
      classification: 'POLICY_VIOLATION',
      reasonCode: 'ROLE_INVALID_FOR_SCOPE',
      inactive: inactiveReasons.length > 0,
      inactiveReasons,
      roleCode,
    };
  }
  if (
    scope === 'ORGANIZATION' &&
    role.code === 'ADMIN' &&
    (!Array.isArray(role.permissions) ||
      !role.permissions.includes('organization.memberships.manage'))
  ) {
    return {
      scope,
      classification: 'POLICY_VIOLATION',
      reasonCode: 'ORGANIZATION_ADMIN_PERMISSION_MISSING',
      inactive: inactiveReasons.length > 0,
      inactiveReasons,
      roleCode,
    };
  }
  if (
    organizationMemberships.length !== 1 ||
    user.status === 'PENDING_INVITE' ||
    (organizationMembership.status !== 'ACTIVE' &&
      organizationMembership.status !== 'SUSPENDED')
  ) {
    return {
      scope,
      classification: 'POLICY_VIOLATION',
      reasonCode: 'ORGANIZATION_MEMBERSHIP_STATE_INVALID',
      inactive: inactiveReasons.length > 0,
      inactiveReasons,
      roleCode,
    };
  }
  if (
    projectScoped &&
    projectMembership.status !== 'ACTIVE' &&
    projectMembership.status !== 'INACTIVE'
  ) {
    return {
      scope,
      classification: 'POLICY_VIOLATION',
      reasonCode: 'PROJECT_MEMBERSHIP_STATE_INVALID',
      inactive: inactiveReasons.length > 0,
      inactiveReasons,
      roleCode,
    };
  }
  if (
    !Number.isSafeInteger(assignment.mutationFence) ||
    assignment.mutationFence < 0 ||
    !isDate(assignment.createdAt) ||
    !isDate(assignment.updatedAt)
  ) {
    return {
      scope,
      classification: 'LEGACY',
      reasonCode: 'ASSIGNMENT_FENCE_OR_TIMESTAMP_INVALID',
      inactive: inactiveReasons.length > 0,
      inactiveReasons,
      roleCode,
    };
  }
  const assignerId = idKey(assignment.assignedBy);
  if (!assignerId || !evidence.users.has(assignerId)) {
    return {
      scope,
      classification: 'UNVERIFIED',
      reasonCode: 'ASSIGNER_NOT_RESOLVED',
      inactive: inactiveReasons.length > 0,
      inactiveReasons,
      roleCode,
    };
  }
  return {
    scope,
    classification: 'VALID',
    reasonCode: 'STRUCTURALLY_CONSISTENT',
    inactive: inactiveReasons.length > 0,
    inactiveReasons,
    roleCode,
  };
}

function emptyCounts() {
  return {
    assignments: 0,
    byScope: { ORGANIZATION: 0, PROJECT: 0 },
    byClassification: Object.fromEntries(
      CLASSIFICATIONS.map((name) => [name, 0]),
    ),
    byReasonCode: {},
    byRoleCode: { ADMIN: 0, TEAM_LEADER: 0, MEMBER: 0, UNKNOWN: 0 },
    inactiveAssignments: 0,
    inactiveReasons: {},
    duplicateAssignmentGroups: 0,
    duplicateAssignmentRows: 0,
    duplicateOrganizationMembershipLinks: 0,
    duplicateProjectMembershipLinks: 0,
  };
}

function increment(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function addAssignment(counts, duplicateKeys, assignment, evidence) {
  const result = classifyAssignment(assignment, evidence);
  counts.assignments += 1;
  counts.byScope[result.scope] += 1;
  counts.byClassification[result.classification] += 1;
  increment(counts.byReasonCode, result.reasonCode);
  counts.byRoleCode[result.roleCode] += 1;
  if (result.inactive) {
    counts.inactiveAssignments += 1;
    for (const reason of result.inactiveReasons)
      increment(counts.inactiveReasons, reason);
  }
  if (
    idKey(assignment.organizationId) !== null &&
    idKey(assignment.userId) !== null &&
    (assignment.projectId === undefined ||
      assignment.projectId === null ||
      idKey(assignment.projectId) !== null)
  ) {
    const duplicateKey = tripleKey(
      assignment.organizationId,
      assignment.projectId ?? null,
      assignment.userId,
    );
    duplicateKeys.set(duplicateKey, (duplicateKeys.get(duplicateKey) ?? 0) + 1);
  }
  const orgLinks =
    evidence.organizationMemberships.get(
      pairKey(assignment.organizationId, assignment.userId),
    ) ?? [];
  if (orgLinks.length > 1) counts.duplicateOrganizationMembershipLinks += 1;
  if (assignment.projectId !== undefined && assignment.projectId !== null) {
    const projectLinks =
      evidence.projectMemberships.get(
        tripleKey(
          assignment.organizationId,
          assignment.projectId,
          assignment.userId,
        ),
      ) ?? [];
    if (projectLinks.length > 1) counts.duplicateProjectMembershipLinks += 1;
  }
}

export function summarizeAssignments(assignments, evidence) {
  const counts = emptyCounts();
  const duplicateKeys = new Map();
  for (const assignment of assignments) {
    addAssignment(counts, duplicateKeys, assignment, evidence);
  }
  for (const count of duplicateKeys.values()) {
    if (count > 1) {
      counts.duplicateAssignmentGroups += 1;
      counts.duplicateAssignmentRows += count;
    }
  }
  return counts;
}

function uniqueIds(rows, field) {
  const references = new Map();
  for (const row of rows) {
    const value = row[field];
    const key = idKey(value);
    if (key !== null && !references.has(key)) references.set(key, value);
  }
  return [...references.values()];
}

function buildPairs(rows) {
  const pairs = new Map();
  for (const row of rows) {
    const org = idKey(row.organizationId);
    const user = idKey(row.userId);
    if (org && user)
      pairs.set(org + '|' + user, {
        organizationId: row.organizationId,
        userId: row.userId,
      });
  }
  return [...pairs.values()];
}

function buildTriples(rows) {
  const triples = new Map();
  for (const row of rows) {
    const org = idKey(row.organizationId);
    const project = idKey(row.projectId);
    const user = idKey(row.userId);
    if (org && project && user) {
      triples.set(org + '|' + project + '|' + user, {
        organizationId: row.organizationId,
        projectId: row.projectId,
        userId: row.userId,
      });
    }
  }
  return [...triples.values()];
}

function orFilter(items, fields) {
  return {
    $or: items.map((item) =>
      Object.fromEntries(fields.map((field) => [field, item[field]])),
    ),
  };
}

async function findRows(db, collectionName, filter, projection) {
  try {
    const rows = await db
      .collection(collectionName)
      .find(filter, { projection })
      .maxTimeMS(QUERY_MAX_TIME_MS)
      .limit(MAX_RELATED_ROWS + 1)
      .toArray();
    if (rows.length > MAX_RELATED_ROWS) {
      throw new Error('RELATED_RECORD_LIMIT_EXCEEDED');
    }
    return rows;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'RELATED_RECORD_LIMIT_EXCEEDED'
    ) {
      throw error;
    }
    throw new Error('MONGO_READ_FAILED: ' + collectionName);
  }
}

function assertNotPastDeadline(window, startedAt) {
  const now = Date.now();
  if (
    now >= window.executionWindowEnd ||
    now - startedAt >= window.maxExecutionMs
  ) {
    throw new Error('EXECUTION_BOUND_EXCEEDED');
  }
}

export async function reconcileDatabase(db, manifest, options = {}) {
  const now = options.now ?? Date.now();
  const validated = validateManifest(manifest, {
    now,
    requireActiveWindow: true,
  });
  const startedAt = options.startedAt ?? now;
  const deadlineCheck = () => assertNotPastDeadline(validated, startedAt);
  let names;
  try {
    names = await db
      .listCollections(
        { name: { $in: REQUIRED_COLLECTIONS } },
        { nameOnly: true },
      )
      .toArray();
  } catch {
    throw new Error('MONGO_READ_FAILED: COLLECTION_INVENTORY');
  }
  const available = new Set(names.map((item) => item.name));
  const missing = REQUIRED_COLLECTIONS.filter((name) => !available.has(name));
  if (missing.length > 0) throw new Error('TARGET_COLLECTIONS_INCOMPLETE');

  const assignmentProjection = {
    _id: 1,
    organizationId: 1,
    projectId: 1,
    userId: 1,
    roleId: 1,
    roleCode: 1,
    assignedBy: 1,
    mutationFence: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  let assignments;
  try {
    assignments = await db
      .collection('role_assignments')
      .find({}, { projection: assignmentProjection })
      .sort({ _id: 1 })
      .maxTimeMS(QUERY_MAX_TIME_MS)
      .limit(MAX_ASSIGNMENTS + 1)
      .toArray();
  } catch {
    throw new Error('MONGO_READ_FAILED: role_assignments');
  }
  if (assignments.length > MAX_ASSIGNMENTS) {
    throw new Error('ASSIGNMENT_LIMIT_EXCEEDED');
  }
  deadlineCheck();

  const counts = emptyCounts();
  const duplicateKeys = new Map();
  for (let offset = 0; offset < assignments.length; offset += BATCH_SIZE) {
    deadlineCheck();
    const batch = assignments.slice(offset, offset + BATCH_SIZE);
    const organizationIds = uniqueIds(batch, 'organizationId');
    const projectIds = uniqueIds(batch, 'projectId');
    const userIds = [
      ...new Map(
        [...uniqueIds(batch, 'userId'), ...uniqueIds(batch, 'assignedBy')].map(
          (id) => [idKey(id), id],
        ),
      ).values(),
    ];
    const roleIds = uniqueIds(batch, 'roleId');
    const pairs = buildPairs(batch);
    const triples = buildTriples(
      batch.filter(
        (row) => row.projectId !== undefined && row.projectId !== null,
      ),
    );

    const roles = roleIds.length
      ? await findRows(
          db,
          'roles',
          { _id: { $in: roleIds } },
          {
            _id: 1,
            code: 1,
            permissions: 1,
            isSystem: 1,
          },
        )
      : [];
    const users = userIds.length
      ? await findRows(
          db,
          'users',
          { _id: { $in: userIds } },
          {
            _id: 1,
            status: 1,
          },
        )
      : [];
    const organizations = organizationIds.length
      ? await findRows(
          db,
          'organizations',
          { _id: { $in: organizationIds } },
          {
            _id: 1,
          },
        )
      : [];
    const organizationMemberships = pairs.length
      ? await findRows(
          db,
          'organization_memberships',
          orFilter(pairs, ['organizationId', 'userId']),
          {
            _id: 1,
            organizationId: 1,
            userId: 1,
            status: 1,
          },
        )
      : [];
    const projects = projectIds.length
      ? await findRows(
          db,
          'projects',
          { _id: { $in: projectIds } },
          {
            _id: 1,
            organizationId: 1,
            status: 1,
          },
        )
      : [];
    const projectMemberships = triples.length
      ? await findRows(
          db,
          'project_memberships',
          orFilter(triples, ['organizationId', 'projectId', 'userId']),
          {
            _id: 1,
            organizationId: 1,
            projectId: 1,
            userId: 1,
            status: 1,
          },
        )
      : [];

    const evidence = {
      roles: mapById(roles),
      users: mapById(users),
      organizations: mapById(organizations),
      organizationMemberships: indexBy(organizationMemberships, (row) =>
        pairKey(row.organizationId, row.userId),
      ),
      projects: mapById(projects),
      projectMemberships: indexBy(projectMemberships, (row) =>
        tripleKey(row.organizationId, row.projectId, row.userId),
      ),
    };
    for (const assignment of batch) {
      addAssignment(counts, duplicateKeys, assignment, evidence);
    }
    deadlineCheck();
  }
  for (const count of duplicateKeys.values()) {
    if (count > 1) {
      counts.duplicateAssignmentGroups += 1;
      counts.duplicateAssignmentRows += count;
    }
  }
  deadlineCheck();
  return counts;
}

function compareHostLists(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every((host, index) => host === expected[index])
  );
}

async function verifyTarget(connection, manifest, validated) {
  const db = connection.db;
  if (!db) throw new Error('MONGO_CONNECTION_NOT_READY');
  let hello;
  let buildInfo;
  let connectionStatus;
  try {
    const admin = db.admin();
    hello = await admin.command({ hello: 1 });
    buildInfo = await admin.command({ buildInfo: 1 });
    connectionStatus = await admin.command({
      connectionStatus: 1,
      showPrivileges: true,
    });
  } catch {
    throw new Error('TARGET_IDENTITY_CHECK_FAILED');
  }
  const helloHosts = Array.isArray(hello.hosts)
    ? hello.hosts.map(normalizeHost).filter(Boolean).sort()
    : [];
  const currentMember = normalizeHost(hello.me);
  if (
    hello.setName !== manifest.restore.target.replicaSetName ||
    !compareHostLists(helloHosts, validated.expectedHosts) ||
    !validated.expectedHosts.includes(currentMember) ||
    hello.isWritablePrimary !== true
  ) {
    throw new Error('TARGET_IDENTITY_MISMATCH');
  }
  if (
    !Array.isArray(buildInfo.versionArray) ||
    buildInfo.versionArray[0] !== 7
  ) {
    throw new Error('MONGODB_MAJOR_VERSION_MISMATCH');
  }
  const users = connectionStatus?.authInfo?.authenticatedUsers;
  if (
    !Array.isArray(users) ||
    !users.some(
      (user) =>
        user.user === manifest.database.accountName &&
        user.db === manifest.database.authenticationDatabase,
    )
  ) {
    throw new Error('DATABASE_ACCOUNT_MISMATCH');
  }
  const actualPrivileges =
    connectionStatus?.authInfo?.authenticatedUserPrivileges;
  const recordedPrivileges = manifest.database.effectivePrivileges.privileges;
  const actualNormalized = assertMinimumPrivileges(actualPrivileges);
  const recordedNormalized = assertMinimumPrivileges(recordedPrivileges);
  if (JSON.stringify(actualNormalized) !== JSON.stringify(recordedNormalized)) {
    throw new Error('DATABASE_PRIVILEGES_CHANGED');
  }
  return {
    db,
    replicaSetName: hello.setName,
    serverVersion: buildInfo.version,
    accountName: manifest.database.accountName,
  };
}

export function normalizePrivileges(privileges) {
  if (!Array.isArray(privileges) || privileges.length === 0) {
    throw new Error('DATABASE_PRIVILEGES_UNAVAILABLE');
  }
  const byResource = new Map();
  for (const privilege of privileges) {
    const resource = privilege?.resource;
    const actions = privilege?.actions;
    const allowedActions =
      resource?.collection === ''
        ? new Set(['listCollections'])
        : new Set(['find']);
    if (
      !record(resource) ||
      resource.db !== DATABASE_NAME ||
      (resource.collection !== '' &&
        !REQUIRED_COLLECTIONS.includes(resource.collection)) ||
      !Array.isArray(actions) ||
      actions.length === 0 ||
      actions.some(
        (action) =>
          !READ_ONLY_ACTIONS.has(action) || !allowedActions.has(action),
      )
    ) {
      throw new Error('DATABASE_PRIVILEGES_NOT_READ_ONLY');
    }
    const key = resource.db + '/' + resource.collection;
    const current = byResource.get(key) ?? new Set();
    for (const action of actions) current.add(action);
    byResource.set(key, current);
  }
  return [...byResource.entries()]
    .map(([key, actions]) => ({
      resource: {
        db: key.slice(0, key.indexOf('/')),
        collection: key.slice(key.indexOf('/') + 1),
      },
      actions: [...actions].sort(),
    }))
    .sort((left, right) =>
      (left.resource.db + '/' + left.resource.collection).localeCompare(
        right.resource.db + '/' + right.resource.collection,
      ),
    );
}

export function assertMinimumPrivileges(privileges) {
  const normalized = normalizePrivileges(privileges);
  const resources = new Map(
    normalized.map((entry) => [
      entry.resource.db + '/' + entry.resource.collection,
      entry.actions,
    ]),
  );
  if (
    resources.size !== REQUIRED_COLLECTIONS.length + 1 ||
    JSON.stringify(resources.get(DATABASE_NAME + '/')) !==
      JSON.stringify(['listCollections']) ||
    REQUIRED_COLLECTIONS.some(
      (name) =>
        JSON.stringify(resources.get(DATABASE_NAME + '/' + name)) !==
        JSON.stringify(['find']),
    )
  ) {
    throw new Error('DATABASE_PRIVILEGES_NOT_MINIMAL');
  }
  return normalized;
}

function validateMongoUri(uri, manifest, validated) {
  const hosts = parseMongoUriHosts(uri);
  if (!compareHostLists(hosts, validated.expectedHosts)) {
    throw new Error('MONGODB_URI_HOSTS_NOT_APPROVED');
  }
  const queryStart = uri.indexOf('?');
  const query = new URLSearchParams(
    queryStart < 0 ? '' : uri.slice(queryStart + 1),
  );
  const replicaSet = query.get('replicaSet');
  const authSource = query.get('authSource');
  if (
    (replicaSet !== null &&
      replicaSet !== manifest.restore.target.replicaSetName) ||
    (authSource !== null &&
      authSource !== manifest.database.authenticationDatabase)
  ) {
    throw new Error('MONGODB_URI_OPTIONS_MISMATCH');
  }
  return hosts;
}

async function runReconciliation(manifest, uri) {
  const validated = validateManifest(manifest, {
    now: Date.now(),
    requireActiveWindow: true,
  });
  try {
    validateMongoUri(uri, manifest, validated);
  } catch (error) {
    throw new Error(error.message);
  }

  const startedAt = Date.now();
  let mongoose;
  let connection;
  try {
    mongoose = await import('mongoose');
    connection = mongoose.createConnection(uri, {
      dbName: DATABASE_NAME,
      replicaSet: manifest.restore.target.replicaSetName,
      directConnection: false,
      readPreference: 'primary',
      readConcern: { level: 'majority' },
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 35_000,
      maxPoolSize: 2,
    });
    await connection.asPromise();
  } catch {
    throw new Error('MONGO_CONNECT_FAILED');
  }
  try {
    const target = await verifyTarget(connection, manifest, validated);
    const counts = await reconcileDatabase(target.db, manifest, {
      now: Date.now(),
      startedAt,
    });
    const completedAt = Date.now();
    if (
      completedAt - startedAt > validated.maxExecutionMs ||
      completedAt >= validated.executionWindowEnd
    ) {
      throw new Error('EXECUTION_BOUND_EXCEEDED');
    }
    const scriptBytes = await readFile(fileURLToPath(import.meta.url));
    return {
      schemaVersion: 1,
      result: 'COMPLETED_READ_ONLY',
      runId: randomUUID(),
      scriptSha256: createHash('sha256').update(scriptBytes).digest('hex'),
      target: {
        snapshotId: manifest.snapshot.id,
        restoreRunId: manifest.restore.runId,
        identity: manifest.restore.target.identity,
        databaseName: DATABASE_NAME,
        replicaSetName: target.replicaSetName,
        serverVersion: target.serverVersion,
        accountName: target.accountName,
      },
      execution: {
        operator: manifest.executionWindow.operator,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        durationMs: completedAt - startedAt,
        projectLeadAuthorizationReference:
          manifest.authorization.projectLead.reference,
        executionConfirmationReference:
          manifest.executionWindow.confirmation.reference,
        targetConfirmationReference:
          manifest.executionWindow.targetConfirmationReference,
        networkIsolationEvidenceReference:
          manifest.restore.networkIsolation.reference,
        effectivePrivilegeEvidenceReference:
          manifest.database.effectivePrivileges.reference,
        serverWriteDenialEvidenceReference:
          manifest.database.writeDenial.reference,
      },
      scope: {
        database: DATABASE_NAME,
        collections: REQUIRED_COLLECTIONS,
        writesPerformed: 0,
        rawIdentifiersEmitted: false,
        personalDataEmitted: false,
        privateProjectContentRead: false,
      },
      counts,
    };
  } finally {
    await connection.close().catch(() => undefined);
  }
}

async function readManifest(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error('MANIFEST_READ_FAILED');
  }
  if (text.length > 256_000) throw new Error('MANIFEST_SIZE_LIMIT_EXCEEDED');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('MANIFEST_INVALID_JSON');
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const manifestIndex = argv.indexOf('--manifest');
  if (manifestIndex < 0 || !argv[manifestIndex + 1] || argv.length !== 2) {
    throw new Error(
      'USAGE: node scripts/organization-role-reconciliation.mjs --manifest <verified-evidence.json>',
    );
  }
  const manifest = await readManifest(resolve(argv[manifestIndex + 1]));
  const uri = env.ORG08_RECONCILIATION_MONGODB_URI;
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new Error('ORG08_RECONCILIATION_MONGODB_URI_REQUIRED');
  }
  const result = await runReconciliation(manifest, uri);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    const message =
      typeof error?.message === 'string' &&
      /^[A-Z0-9_:-]+(?:: [A-Za-z0-9_.-]+)?$/.test(error.message)
        ? error.message
        : 'RECONCILIATION_STOPPED';
    process.stderr.write('ORG08 reconciliation stopped: ' + message + '\n');
    process.exitCode = 1;
  });
}
