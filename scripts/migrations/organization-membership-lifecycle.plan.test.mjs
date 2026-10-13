import assert from 'node:assert/strict';
import test from 'node:test';
import { planMembershipLifecycle } from './organization-membership-lifecycle.plan.mjs';
const id = (n) => n.toString(16).padStart(24, '0');
export const fixture = () => ({
  databaseName: 'continuum_iam_fixture',
  targetFingerprint: 'f'.repeat(64),
  objects: Object.fromEntries(
    [
      'users',
      'organizations',
      'organization_memberships',
      'organization_invitations',
      'roles',
      'role_assignments',
    ].map((name) => [name, { type: 'collection', indexes: [] }]),
  ),
  operationsCount: 0,
  rows: {
    users: [{ _id: id(1), status: 'ACTIVE' }],
    organizations: [{ _id: id(2) }],
    organization_memberships: [
      {
        _id: id(3),
        organizationId: id(2),
        userId: id(1),
        status: 'ACTIVE',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    roles: [
      {
        _id: id(4),
        code: 'ADMIN',
        isSystem: true,
        permissions: ['project.visibility.manage', 'existing.permission'],
      },
    ],
    role_assignments: [
      {
        _id: id(5),
        organizationId: id(2),
        userId: id(1),
        roleId: id(4),
        roleCode: 'ADMIN',
      },
    ],
    organization_invitations: [
      {
        _id: id(6),
        organizationId: id(2),
        emailHash: 'e'.repeat(64),
        emailNormalized: true,
        roleCode: 'MEMBER',
        status: 'REVOKED',
        expiresAt: '2026-01-08T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  },
});
test('adds only missing tracking fields/approved ADMIN permissions, retaining legacy state and grants', () => {
  const snapshot = fixture();
  const before = structuredClone(snapshot);
  const plan = planMembershipLifecycle(snapshot);
  assert.equal(plan.clean, true);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(plan.permissionAdditions[0].missingPermissions, [
    'organization.memberships.read',
    'organization.memberships.manage',
  ]);
  assert.ok(
    plan.permissionAdditions[0].existingPermissions.includes(
      'project.visibility.manage',
    ),
  );
  const invite = plan.updates.find(
    (row) => row.collection === 'organization_invitations',
  );
  assert.deepEqual(invite.set, { contractVersion: 1, version: 1 });
  assert.equal(JSON.stringify(plan).includes('email@example.test'), false);
  assert.ok(
    plan.indexes.some(
      (row) =>
        row.spec.name === 'membership_operation_expiry' &&
        row.spec.expireAfterSeconds === 0,
    ),
  );
  assert.equal(
    plan.indexes.some(
      (row) =>
        row.collection === 'organization_invitations' &&
        'expireAfterSeconds' in row.spec,
    ),
    false,
  );
});
test('report hash binds target and data; projection order does not affect it', () => {
  const snapshot = fixture();
  const plan = planMembershipLifecycle(snapshot);
  const reordered = structuredClone(snapshot);
  reordered.rows.users.reverse();
  assert.equal(
    plan.reportSha256,
    planMembershipLifecycle(reordered).reportSha256,
  );
  assert.notEqual(
    plan.reportSha256,
    planMembershipLifecycle({ ...snapshot, targetFingerprint: 'a'.repeat(64) })
      .reportSha256,
  );
  snapshot.rows.organization_memberships[0].status = 'SUSPENDED';
  assert.notEqual(
    plan.reportSha256,
    planMembershipLifecycle(snapshot).reportSha256,
  );
});
for (const value of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
  test(`rejects invalid existing Membership version ${value}`, () => {
    const snapshot = fixture();
    snapshot.rows.organization_memberships[0].version = value;
    assert.equal(planMembershipLifecycle(snapshot).clean, false);
  });
test('blocks duplicate membership pairs and conflicting index semantics', () => {
  const snapshot = fixture();
  snapshot.rows.organization_memberships.push({
    ...snapshot.rows.organization_memberships[0],
    _id: id(7),
  });
  assert.ok(
    planMembershipLifecycle(snapshot).issues.some((code) =>
      code.startsWith('DUPLICATE_MEMBERSHIP_PAIR'),
    ),
  );
  snapshot.rows.organization_memberships.pop();
  snapshot.objects.membership_operations = {
    type: 'collection',
    indexes: [
      { name: 'membership_operation_key', key: { keyHash: 1 }, unique: true },
    ],
  };
  assert.ok(
    planMembershipLifecycle(snapshot).issues.some((code) =>
      code.startsWith('INDEX_CONFLICT'),
    ),
  );
});
test('refuses misplaced permissions/denormalized ADMIN and missing eligible-admin readiness', () => {
  const snapshot = fixture();
  snapshot.rows.role_assignments[0].roleCode = 'MEMBER';
  assert.ok(
    planMembershipLifecycle(snapshot).issues.some((code) =>
      code.startsWith('ROLE_ASSIGNMENT_MISMATCH'),
    ),
  );
  assert.ok(
    planMembershipLifecycle(snapshot).issues.some((code) =>
      code.startsWith('NO_ELIGIBLE_ADMIN'),
    ),
  );
  snapshot.rows.roles.push({
    _id: id(9),
    code: 'MEMBER',
    isSystem: true,
    permissions: ['organization.memberships.manage'],
  });
  assert.ok(
    planMembershipLifecycle(snapshot).issues.some((code) =>
      code.startsWith('MISPLACED_MEMBERSHIP_PERMISSION'),
    ),
  );
});
test('validates V2 recipient/pair binding without inferring legacy Invitation recipients', () => {
  const snapshot = fixture();
  snapshot.rows.organization_invitations[0] = {
    ...snapshot.rows.organization_invitations[0],
    contractVersion: 2,
    status: 'ACCEPTED',
    membershipId: id(3),
    targetUserId: id(1),
  };
  delete snapshot.rows.organization_invitations[0].roleCode;
  assert.equal(planMembershipLifecycle(snapshot).clean, true);
  snapshot.rows.organization_invitations[0].targetUserId = id(10);
  assert.ok(
    planMembershipLifecycle(snapshot).issues.some((code) =>
      code.startsWith('INVITATION_BINDING_INVALID'),
    ),
  );
});
test('refuses a live operation cache while a tracking/permission/index migration is needed', () => {
  const snapshot = fixture();
  snapshot.operationsCount = 1;
  assert.ok(
    planMembershipLifecycle(snapshot).issues.includes(
      'LIVE_OPERATION_CACHE_REQUIRES_CUTOVER',
    ),
  );
});
for (const collection of [
  'organization_invitations',
  'organization_memberships',
])
  test(`blocks an unexpected-name TTL on retained ${collection} records`, () => {
    const snapshot = fixture();
    snapshot.objects[collection].indexes.push({
      name: 'legacy_retention_cleanup',
      key: { expiresAt: 1 },
      expireAfterSeconds: 0,
    });
    const before = structuredClone(snapshot);
    const report = planMembershipLifecycle(snapshot);
    assert.equal(report.clean, false);
    assert.ok(
      report.issues.includes(
        `RETENTION_TTL_CONFLICT:${collection}:legacy_retention_cleanup`,
      ),
    );
    assert.deepEqual(snapshot, before);
  });
