import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  DATABASE_NAME,
  REQUIRED_COLLECTIONS,
  reconcileDatabase,
} from './organization-role-reconciliation.mjs';

const id = (hex) => new mongoose.Types.ObjectId(hex);
const ids = {
  organization: id('000000000000000000000001'),
  user: id('000000000000000000000002'),
  assigner: id('000000000000000000000003'),
  adminRole: id('000000000000000000000004'),
  leaderRole: id('000000000000000000000005'),
  project: id('000000000000000000000006'),
  membership: id('000000000000000000000007'),
  projectMembership: id('000000000000000000000008'),
  orgAssignment: id('000000000000000000000009'),
  projectAssignment: id('00000000000000000000000a'),
};
const fixedNow = Date.parse('2026-10-21T10:00:00.000Z');
let replicaSet;
let connection;

function verified(reference, extra = {}) {
  return {
    status: 'VERIFIED',
    reference,
    verifiedBy: 'fixture-only',
    verifiedAt: '2026-10-21T09:00:00.000Z',
    ...extra,
  };
}

function fixtureManifest() {
  const privileges = [
    {
      resource: { db: DATABASE_NAME, collection: '' },
      actions: ['listCollections'],
    },
    ...REQUIRED_COLLECTIONS.map((collection) => ({
      resource: { db: DATABASE_NAME, collection },
      actions: ['find'],
    })),
  ];
  return {
    schemaVersion: 1,
    snapshot: {
      id: 'synthetic-fixture-only',
      sourceEnvironment: 'STAGING',
      classification: 'TEST_FIXTURE',
      createdAt: '2026-10-21T08:00:00.000Z',
      collectionScope: [...REQUIRED_COLLECTIONS],
      approver: 'fixture-only',
      approvalReference: 'synthetic-test-reference',
      retentionExpiresAt: '2026-11-21T00:00:00.000Z',
      integrity: verified('synthetic-test-reference', {
        algorithm: 'SHA-256',
        checksum: 'b'.repeat(64),
      }),
    },
    restore: {
      runId: 'synthetic-fixture-only',
      sourceSnapshotId: 'synthetic-fixture-only',
      toolVersion: 'fixture-only',
      restoredAt: '2026-10-21T08:30:00.000Z',
      integrity: verified('synthetic-test-reference', {
        targetIdentity: 'memory-server-fixture-only',
      }),
      target: {
        identity: 'memory-server-fixture-only',
        databaseName: DATABASE_NAME,
        replicaSetName: 'org08-local-fixture',
        hosts: ['fixture.invalid:27017'],
      },
      networkIsolation: verified('synthetic-test-reference', {
        targetIdentity: 'memory-server-fixture-only',
      }),
    },
    database: {
      targetIdentity: 'memory-server-fixture-only',
      accountName: 'fixture-only',
      authenticationDatabase: 'admin',
      effectivePrivileges: verified('synthetic-test-reference', {
        targetIdentity: 'memory-server-fixture-only',
        accountName: 'fixture-only',
        privileges,
      }),
      writeDenial: verified('synthetic-test-reference', {
        targetIdentity: 'memory-server-fixture-only',
        accountName: 'fixture-only',
      }),
    },
    authorization: {
      projectLead: verified('synthetic-test-reference', {
        approvedBy: 'fixture-only',
        authorizedAt: '2026-10-21T08:45:00.000Z',
        scope: 'Test fixture only; no Staging authorization',
        maxExecutionMinutes: 30,
      }),
    },
    executionWindow: {
      operator: 'fixture-only',
      targetIdentity: 'memory-server-fixture-only',
      confirmedAt: '2026-10-21T09:00:00.000Z',
      startAt: '2026-10-21T09:45:00.000Z',
      endAt: '2026-10-21T10:15:00.000Z',
      confirmation: verified('synthetic-test-reference'),
      targetConfirmationReference: 'synthetic-test-reference',
    },
  };
}

before(async () => {
  replicaSet = await MongoMemoryReplSet.create({
    binary: { version: '7.0.14' },
    replSet: {
      name: 'org08-local-fixture',
      count: 1,
      storageEngine: 'wiredTiger',
    },
    instanceOpts: [{ ip: '127.0.0.1' }],
  });
  connection = await mongoose
    .createConnection(replicaSet.getUri(DATABASE_NAME), {
      serverSelectionTimeoutMS: 5000,
    })
    .asPromise();
  const db = connection.db;
  const hello = await db.admin().command({ hello: 1 });
  const buildInfo = await db.admin().command({ buildInfo: 1 });
  assert.equal(hello.setName, 'org08-local-fixture');
  assert.ok(String(hello.me).startsWith('127.0.0.1:'));
  assert.equal(buildInfo.versionArray[0], 7);

  for (const collection of REQUIRED_COLLECTIONS) {
    await db.createCollection(collection);
  }
  await db.collection('roles').insertMany([
    {
      _id: ids.adminRole,
      code: 'ADMIN',
      permissions: ['organization.memberships.manage'],
      isSystem: true,
      mutationFence: 0,
    },
    {
      _id: ids.leaderRole,
      code: 'TEAM_LEADER',
      permissions: ['project.members.list'],
      isSystem: true,
      mutationFence: 0,
    },
  ]);
  await db.collection('users').insertMany([
    {
      _id: ids.user,
      status: 'ACTIVE',
      email: 'private-fixture@example.test',
      fullName: 'Private fixture name',
      passwordHash: 'must-not-be-selected',
    },
    {
      _id: ids.assigner,
      status: 'ACTIVE',
      email: 'assigner-fixture@example.test',
      fullName: 'Private assigner fixture name',
    },
  ]);
  await db.collection('organizations').insertOne({
    _id: ids.organization,
    name: 'Private organization name',
  });
  await db.collection('organization_memberships').insertOne({
    _id: ids.membership,
    organizationId: ids.organization,
    userId: ids.user,
    status: 'ACTIVE',
    version: 1,
    mutationFence: 0,
  });
  await db.collection('projects').insertOne({
    _id: ids.project,
    organizationId: ids.organization,
    status: 'ACTIVE',
    visibility: 'PRIVATE',
    name: 'Private project title',
    description: 'Private project content must not be read',
  });
  await db.collection('project_memberships').insertOne({
    _id: ids.projectMembership,
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.user,
    status: 'ACTIVE',
    joinedAt: new Date('2026-10-20T00:00:00.000Z'),
  });
  await db.collection('role_assignments').insertMany([
    {
      _id: ids.orgAssignment,
      organizationId: ids.organization,
      userId: ids.user,
      roleId: ids.adminRole,
      roleCode: 'ADMIN',
      assignedBy: ids.assigner,
      mutationFence: 0,
      createdAt: new Date('2026-10-20T00:00:00.000Z'),
      updatedAt: new Date('2026-10-20T00:00:00.000Z'),
    },
    {
      _id: ids.projectAssignment,
      organizationId: ids.organization,
      projectId: ids.project,
      userId: ids.user,
      roleId: ids.leaderRole,
      roleCode: 'TEAM_LEADER',
      assignedBy: ids.assigner,
      mutationFence: 0,
      createdAt: new Date('2026-10-20T00:00:00.000Z'),
      updatedAt: new Date('2026-10-20T00:00:00.000Z'),
    },
  ]);
});

after(async () => {
  await connection?.close();
  await replicaSet?.stop();
});

test('reads only the synthetic MongoDB 7 replica-set fixture and leaves its records unchanged', async () => {
  const db = connection.db;
  const beforeAssignments = await db
    .collection('role_assignments')
    .find({})
    .sort({ _id: 1 })
    .toArray();
  const beforeMemberships = await db
    .collection('organization_memberships')
    .find({})
    .sort({ _id: 1 })
    .toArray();

  const result = await reconcileDatabase(db, fixtureManifest(), {
    now: fixedNow,
  });

  const afterAssignments = await db
    .collection('role_assignments')
    .find({})
    .sort({ _id: 1 })
    .toArray();
  const afterMemberships = await db
    .collection('organization_memberships')
    .find({})
    .sort({ _id: 1 })
    .toArray();
  assert.deepEqual(afterAssignments, beforeAssignments);
  assert.deepEqual(afterMemberships, beforeMemberships);
  assert.equal(result.assignments, 2);
  assert.equal(result.byScope.ORGANIZATION, 1);
  assert.equal(result.byScope.PROJECT, 1);
  assert.equal(result.byClassification.VALID, 2);
  assert.equal(result.inactiveAssignments, 0);

  const output = JSON.stringify(result);
  for (const privateValue of [
    '000000000000000000000001',
    'private-fixture@example.test',
    'Private fixture name',
    'Private organization name',
    'Private project title',
    'Private project content',
  ]) {
    assert.equal(output.includes(privateValue), false);
  }
});
