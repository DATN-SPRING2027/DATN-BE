import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  REQUIRED_COLLECTIONS,
  assertMinimumPrivileges,
  classifyAssignment,
  normalizePrivileges,
  parseMongoUriHosts,
  reconcileDatabase,
  summarizeAssignments,
  validateManifest,
} from './organization-role-reconciliation.mjs';

const now = Date.parse('2026-10-21T10:00:00.000Z');
const ids = {
  org: '000000000000000000000001',
  user: '000000000000000000000002',
  assigner: '000000000000000000000003',
  adminRole: '000000000000000000000004',
  memberRole: '000000000000000000000005',
  leaderRole: '000000000000000000000006',
  project: '000000000000000000000007',
};
const reference = 'ORG-08-evidence/test-reference';

function evidence(extra = {}) {
  return {
    status: 'VERIFIED',
    reference,
    verifiedBy: 'DB-Operator-1',
    verifiedAt: '2026-10-21T09:00:00.000Z',
    ...extra,
  };
}

function manifest() {
  const privileges = [
    {
      resource: { db: 'continuum_iam', collection: '' },
      actions: ['listCollections'],
    },
    ...REQUIRED_COLLECTIONS.map((collection) => ({
      resource: { db: 'continuum_iam', collection },
      actions: ['find'],
    })),
  ];
  return {
    schemaVersion: 1,
    snapshot: {
      id: 'approved-staging-snapshot-1',
      sourceEnvironment: 'STAGING',
      classification: 'INTERNAL',
      createdAt: '2026-10-21T08:00:00.000Z',
      collectionScope: [...REQUIRED_COLLECTIONS],
      checksum: 'not-used',
      approver: 'Backup-Approver-1',
      approvalReference: reference,
      retentionExpiresAt: '2026-11-21T00:00:00.000Z',
      integrity: evidence({
        algorithm: 'SHA-256',
        checksum: 'a'.repeat(64),
      }),
    },
    restore: {
      runId: 'restore-run-1',
      sourceSnapshotId: 'approved-staging-snapshot-1',
      toolVersion: 'restore-tool-1.0',
      restoredAt: '2026-10-21T08:30:00.000Z',
      integrity: evidence({ targetIdentity: 'isolated-target-1' }),
      target: {
        identity: 'isolated-target-1',
        databaseName: 'continuum_iam',
        replicaSetName: 'org08-rs',
        hosts: ['mongo-a.staging-isolated.example:27017'],
      },
      networkIsolation: evidence({
        targetIdentity: 'isolated-target-1',
      }),
    },
    database: {
      targetIdentity: 'isolated-target-1',
      accountName: 'org08-reconcile',
      authenticationDatabase: 'admin',
      effectivePrivileges: evidence({
        targetIdentity: 'isolated-target-1',
        accountName: 'org08-reconcile',
        privileges,
      }),
      writeDenial: evidence({
        targetIdentity: 'isolated-target-1',
        accountName: 'org08-reconcile',
      }),
    },
    authorization: {
      projectLead: evidence({
        approvedBy: 'Project-Lead',
        authorizedAt: '2026-10-21T08:45:00.000Z',
        scope: 'Read-only ORG-08 role assignment reconciliation',
        maxExecutionMinutes: 30,
      }),
    },
    executionWindow: {
      operator: 'DB-Operator-1',
      targetIdentity: 'isolated-target-1',
      confirmedAt: '2026-10-21T09:00:00.000Z',
      startAt: '2026-10-21T09:45:00.000Z',
      endAt: '2026-10-21T10:15:00.000Z',
      confirmation: evidence(),
      targetConfirmationReference: reference,
    },
  };
}

function validEvidence() {
  return {
    roles: new Map([
      [
        ids.adminRole,
        {
          _id: ids.adminRole,
          code: 'ADMIN',
          permissions: ['organization.memberships.manage'],
          isSystem: true,
        },
      ],
      [ids.memberRole, { _id: ids.memberRole, code: 'MEMBER', isSystem: true }],
      [
        ids.leaderRole,
        { _id: ids.leaderRole, code: 'TEAM_LEADER', isSystem: true },
      ],
    ]),
    users: new Map([
      [ids.user, { _id: ids.user, status: 'ACTIVE' }],
      [ids.assigner, { _id: ids.assigner, status: 'ACTIVE' }],
    ]),
    organizations: new Map([[ids.org, { _id: ids.org }]]),
    organizationMemberships: new Map([
      [
        ids.org + '|' + ids.user,
        [{ organizationId: ids.org, userId: ids.user, status: 'ACTIVE' }],
      ],
    ]),
    projects: new Map([
      [
        ids.project,
        { _id: ids.project, organizationId: ids.org, status: 'ACTIVE' },
      ],
    ]),
    projectMemberships: new Map([
      [
        ids.org + '|' + ids.project + '|' + ids.user,
        [
          {
            organizationId: ids.org,
            projectId: ids.project,
            userId: ids.user,
            status: 'ACTIVE',
          },
        ],
      ],
    ]),
  };
}

function assignment(overrides = {}) {
  return {
    _id: '000000000000000000000010',
    organizationId: ids.org,
    projectId: null,
    userId: ids.user,
    roleId: ids.adminRole,
    roleCode: 'ADMIN',
    assignedBy: ids.assigner,
    mutationFence: 0,
    createdAt: new Date('2026-10-20T00:00:00.000Z'),
    updatedAt: new Date('2026-10-20T00:00:00.000Z'),
    ...overrides,
  };
}

test('accepts a complete, current, bounded evidence manifest without exposing a URI', () => {
  const result = validateManifest(manifest(), {
    now,
    requireActiveWindow: true,
  });
  assert.deepEqual(result.expectedHosts, [
    'mongo-a.staging-isolated.example:27017',
  ]);
  assert.equal(result.maxExecutionMs, 30 * 60_000);
});

test('rejects missing verification, stale retention, wrong source, and overlong windows', () => {
  const missingVerification = manifest();
  missingVerification.database.writeDenial.status = 'NOT_FOUND';
  assert.throws(
    () => validateManifest(missingVerification, { now }),
    /EVIDENCE_NOT_VERIFIED/,
  );

  const expired = manifest();
  expired.snapshot.retentionExpiresAt = '2026-10-20T00:00:00.000Z';
  assert.throws(
    () => validateManifest(expired, { now }),
    /SNAPSHOT_RETENTION_EXPIRED/,
  );

  const wrongSource = manifest();
  wrongSource.snapshot.sourceEnvironment = 'PRODUCTION';
  assert.throws(
    () => validateManifest(wrongSource, { now }),
    /SNAPSHOT_SOURCE_MUST_BE_STAGING/,
  );

  const tooLong = manifest();
  tooLong.executionWindow.endAt = '2026-10-21T10:30:01.000Z';
  assert.throws(
    () => validateManifest(tooLong, { now }),
    /EXECUTION_WINDOW_INVALID/,
  );
});

test('rejects a mismatched restore, incomplete collection scope, and non-Staging target database', () => {
  const mismatchedRestore = manifest();
  mismatchedRestore.restore.sourceSnapshotId = 'different-snapshot';
  assert.throws(
    () => validateManifest(mismatchedRestore, { now }),
    /RESTORE_SNAPSHOT_MISMATCH/,
  );

  const incomplete = manifest();
  incomplete.snapshot.collectionScope = ['role_assignments'];
  assert.throws(
    () => validateManifest(incomplete, { now }),
    /SNAPSHOT_SCOPE_INCOMPLETE/,
  );

  const wrongDatabase = manifest();
  wrongDatabase.restore.target.databaseName = 'production';
  assert.throws(
    () => validateManifest(wrongDatabase, { now }),
    /TARGET_DATABASE_MISMATCH/,
  );
});

test('parses only approved MongoDB hosts and rejects unsafe URI options', () => {
  const hosts = parseMongoUriHosts(
    'mongodb://mongo-a.staging-isolated.example:27017/continuum_iam?tls=true&replicaSet=org08-rs',
  );
  assert.deepEqual(hosts, ['mongo-a.staging-isolated.example:27017']);
  assert.equal(JSON.stringify(hosts).includes('secret'), false);
  assert.throws(
    () => parseMongoUriHosts('mongodb+srv://host.example/continuum_iam'),
    /MONGODB_URI_INVALID/,
  );
  assert.throws(
    () =>
      parseMongoUriHosts('mongodb://localhost:27017/?directConnection=true'),
    /MONGODB_URI_UNSAFE_OPTION/,
  );
  assert.throws(
    () => parseMongoUriHosts('mongodb://remote.example/continuum_iam'),
    /MONGODB_URI_TLS_REQUIRED/,
  );
});

test('accepts only the minimum collection-level read and database listCollections privileges', () => {
  const expected = [
    {
      resource: { db: 'continuum_iam', collection: '' },
      actions: ['listCollections'],
    },
    ...REQUIRED_COLLECTIONS.map((collection) => ({
      resource: { db: 'continuum_iam', collection },
      actions: ['find'],
    })),
  ];
  assert.equal(
    normalizePrivileges(expected).length,
    REQUIRED_COLLECTIONS.length + 1,
  );
  assert.equal(
    assertMinimumPrivileges(expected).length,
    REQUIRED_COLLECTIONS.length + 1,
  );
  assert.throws(
    () =>
      normalizePrivileges([
        ...expected,
        {
          resource: { db: 'continuum_iam', collection: '' },
          actions: ['insert'],
        },
      ]),
    /DATABASE_PRIVILEGES_NOT_READ_ONLY/,
  );
  assert.throws(
    () => assertMinimumPrivileges(expected.slice(1)),
    /DATABASE_PRIVILEGES_NOT_MINIMAL/,
  );
  assert.throws(
    () =>
      normalizePrivileges([
        {
          resource: { db: 'continuum_iam', collection: '' },
          actions: ['find', 'listCollections'],
        },
      ]),
    /DATABASE_PRIVILEGES_NOT_READ_ONLY/,
  );
  assert.throws(
    () =>
      normalizePrivileges([
        {
          resource: { db: 'continuum_audit', collection: 'audit_logs' },
          actions: ['find'],
        },
      ]),
    /DATABASE_PRIVILEGES_NOT_READ_ONLY/,
  );
});

test('classifies valid Organization and Project assignments in separate scopes', () => {
  const evidenceMap = validEvidence();
  const organizationResult = classifyAssignment(assignment(), evidenceMap);
  assert.equal(organizationResult.classification, 'VALID');
  assert.equal(organizationResult.scope, 'ORGANIZATION');

  const projectResult = classifyAssignment(
    assignment({
      projectId: ids.project,
      roleId: ids.leaderRole,
      roleCode: 'TEAM_LEADER',
    }),
    evidenceMap,
  );
  assert.equal(projectResult.classification, 'VALID');
  assert.equal(projectResult.scope, 'PROJECT');
});

test('reports orphan scope, orphan subject, and unmapped catalog assignments', () => {
  const evidenceMap = validEvidence();
  const missingOrganization = classifyAssignment(
    assignment({ organizationId: '000000000000000000000099' }),
    evidenceMap,
  );
  assert.equal(missingOrganization.classification, 'ORPHAN_SCOPE');

  const missingUser = classifyAssignment(
    assignment({ userId: '000000000000000000000098' }),
    evidenceMap,
  );
  assert.equal(missingUser.classification, 'ORPHAN_SUBJECT');

  const mismatchedRole = classifyAssignment(
    assignment({ roleCode: 'MEMBER' }),
    evidenceMap,
  );
  assert.equal(mismatchedRole.classification, 'UNMAPPED_ROLE');
});

test('reports invalid scope, missing ADMIN permission, legacy fence and unresolved assigner', () => {
  const evidenceMap = validEvidence();
  const invalidOrganizationRole = classifyAssignment(
    assignment({
      roleId: ids.leaderRole,
      roleCode: 'TEAM_LEADER',
    }),
    evidenceMap,
  );
  assert.equal(invalidOrganizationRole.classification, 'POLICY_VIOLATION');

  evidenceMap.roles.set(ids.adminRole, {
    _id: ids.adminRole,
    code: 'ADMIN',
    permissions: [],
    isSystem: true,
  });
  const missingPermission = classifyAssignment(assignment(), evidenceMap);
  assert.equal(
    missingPermission.reasonCode,
    'ORGANIZATION_ADMIN_PERMISSION_MISSING',
  );

  evidenceMap.roles.set(ids.adminRole, {
    _id: ids.adminRole,
    code: 'ADMIN',
    permissions: ['organization.memberships.manage'],
    isSystem: true,
  });
  const legacy = classifyAssignment(
    assignment({ mutationFence: undefined }),
    evidenceMap,
  );
  assert.equal(legacy.classification, 'LEGACY');

  const unverified = classifyAssignment(
    assignment({ assignedBy: '000000000000000000000097' }),
    evidenceMap,
  );
  assert.equal(unverified.classification, 'UNVERIFIED');
});

test('keeps suspended assignments visible as valid but counts them as inactive', () => {
  const evidenceMap = validEvidence();
  evidenceMap.organizationMemberships.set(ids.org + '|' + ids.user, [
    { organizationId: ids.org, userId: ids.user, status: 'SUSPENDED' },
  ]);
  const result = classifyAssignment(assignment(), evidenceMap);
  assert.equal(result.classification, 'VALID');
  assert.equal(result.inactive, true);
  assert.deepEqual(result.inactiveReasons, [
    'ORGANIZATION_MEMBERSHIP_NOT_ACTIVE',
  ]);
});

test('reports duplicate assignments and duplicate scope links as aggregate counts', () => {
  const evidenceMap = validEvidence();
  const duplicateLink = {
    organizationId: ids.org,
    userId: ids.user,
    status: 'ACTIVE',
  };
  evidenceMap.organizationMemberships.set(ids.org + '|' + ids.user, [
    duplicateLink,
    duplicateLink,
  ]);
  const counts = summarizeAssignments(
    [assignment(), assignment({ _id: '000000000000000000000011' })],
    evidenceMap,
  );
  assert.equal(counts.duplicateAssignmentGroups, 1);
  assert.equal(counts.duplicateAssignmentRows, 2);
  assert.equal(counts.duplicateOrganizationMembershipLinks, 2);
  assert.equal(counts.byClassification.DUPLICATE_SCOPE_LINK, 2);
});

test('runs fixture reconciliation through read operations only and projects no PII or private Project content', async () => {
  const calls = [];
  const collections = {
    role_assignments: [
      assignment(),
      assignment({
        _id: '000000000000000000000011',
        projectId: ids.project,
        roleId: ids.leaderRole,
        roleCode: 'TEAM_LEADER',
      }),
    ],
    roles: [
      {
        _id: ids.adminRole,
        code: 'ADMIN',
        permissions: ['organization.memberships.manage'],
        isSystem: true,
      },
      {
        _id: ids.leaderRole,
        code: 'TEAM_LEADER',
        permissions: ['project.members.list'],
        isSystem: true,
      },
    ],
    users: [
      {
        _id: ids.user,
        status: 'ACTIVE',
        email: 'must-not-read@example.test',
        fullName: 'Do not read',
      },
      { _id: ids.assigner, status: 'ACTIVE' },
    ],
    organizations: [{ _id: ids.org, name: 'must-not-read' }],
    organization_memberships: [
      {
        _id: '000000000000000000000020',
        organizationId: ids.org,
        userId: ids.user,
        status: 'ACTIVE',
      },
    ],
    projects: [
      {
        _id: ids.project,
        organizationId: ids.org,
        status: 'ACTIVE',
        name: 'must-not-read',
        description: 'private content must not be selected',
        visibility: 'PRIVATE',
      },
    ],
    project_memberships: [
      {
        _id: '000000000000000000000021',
        organizationId: ids.org,
        projectId: ids.project,
        userId: ids.user,
        status: 'ACTIVE',
      },
    ],
  };
  function matches(row, filter) {
    if (!filter || Object.keys(filter).length === 0) return true;
    if (Array.isArray(filter.$or)) {
      return filter.$or.some((item) =>
        Object.entries(item).every(
          ([field, value]) => idValue(row[field]) === idValue(value),
        ),
      );
    }
    if (filter._id?.$in) {
      return filter._id.$in.some(
        (value) => idValue(value) === idValue(row._id),
      );
    }
    return false;
  }
  function idValue(value) {
    return value && typeof value.toHexString === 'function'
      ? value.toHexString()
      : String(value);
  }
  function cursor(rows) {
    return {
      sort() {
        return this;
      },
      maxTimeMS() {
        return this;
      },
      limit(limit) {
        rows = rows.slice(0, limit);
        return this;
      },
      async toArray() {
        return rows;
      },
    };
  }
  const fakeDb = {
    listCollections(filter) {
      calls.push('listCollections');
      return cursor(
        REQUIRED_COLLECTIONS.filter((name) =>
          filter.name.$in.includes(name),
        ).map((name) => ({ name })),
      );
    },
    collection(name) {
      return new Proxy(
        {
          find(filter, options) {
            calls.push('find:' + name);
            for (const key of Object.keys(options.projection)) {
              assert.notEqual(key, 'email');
              assert.notEqual(key, 'fullName');
              assert.notEqual(key, 'description');
              assert.notEqual(key, 'visibility');
              assert.notEqual(key, 'name');
            }
            const rows = (collections[name] ?? []).filter((row) =>
              matches(row, filter),
            );
            const projected = rows.map((row) => {
              const result = {};
              for (const key of Object.keys(options.projection)) {
                if (options.projection[key] === 1 && row[key] !== undefined)
                  result[key] = row[key];
              }
              return result;
            });
            return cursor(projected);
          },
        },
        {
          get(target, property) {
            if (property in target) return target[property];
            return () => {
              calls.push('forbidden:' + String(property));
              throw new Error('Forbidden database method called');
            };
          },
        },
      );
    },
  };
  const result = await reconcileDatabase(fakeDb, manifest(), { now });
  assert.equal(result.assignments, 2);
  assert.equal(result.byClassification.VALID, 2);
  assert.ok(
    calls.every(
      (call) => call === 'listCollections' || call.startsWith('find:'),
    ),
  );
  assert.equal(
    calls.some((call) => call.startsWith('forbidden:')),
    false,
  );
  assert.deepEqual(
    [
      ...new Set(
        calls
          .filter((call) => call.startsWith('find:'))
          .map((call) => call.slice(5)),
      ),
    ].sort(),
    [
      'organization_memberships',
      'organizations',
      'project_memberships',
      'projects',
      'role_assignments',
      'roles',
      'users',
    ],
  );
});

test('stops with a bounded-result error when a related collection exceeds its cap', async () => {
  function cursor(rows) {
    return {
      sort() {
        return this;
      },
      maxTimeMS() {
        return this;
      },
      limit(limit) {
        rows = rows.slice(0, limit);
        return this;
      },
      async toArray() {
        return rows;
      },
    };
  }
  const db = {
    listCollections() {
      return cursor(REQUIRED_COLLECTIONS.map((name) => ({ name })));
    },
    collection(name) {
      return {
        find() {
          if (name === 'role_assignments') return cursor([assignment()]);
          if (name === 'roles') {
            return cursor(
              Array.from({ length: 5_001 }, (_, index) => ({
                _id: index.toString(16).padStart(24, '0'),
                code: 'MEMBER',
                isSystem: true,
              })),
            );
          }
          return cursor([]);
        },
      };
    },
  };

  await assert.rejects(
    reconcileDatabase(db, manifest(), { now }),
    /RELATED_RECORD_LIMIT_EXCEEDED/,
  );
});

test('runner source contains no database write or migration APIs', async () => {
  const source = await readFile(
    new URL('./organization-role-reconciliation.mjs', import.meta.url),
    'utf8',
  );
  for (const forbidden of [
    '.insertOne(',
    '.insertMany(',
    '.updateOne(',
    '.updateMany(',
    '.deleteOne(',
    '.deleteMany(',
    '.replaceOne(',
    '.bulkWrite(',
    '.createIndex(',
    '.dropCollection(',
    'applyOps',
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      'unexpected write API: ' + forbidden,
    );
  }
});
