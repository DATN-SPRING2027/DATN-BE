import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
let replicaSet;
let connection;
let readerConnection;
const rootPassword = randomBytes(24).toString('hex');
const readerPassword = randomBytes(24).toString('hex');
const readerName = 'org08-synthetic-reader';
const broadReaderName = 'org08-synthetic-broad-reader';

function authenticatedUri(user, password) {
  const uri = new URL(replicaSet.getUri(DATABASE_NAME));
  uri.username = user;
  uri.password = password;
  uri.searchParams.set('authSource', 'admin');
  return uri.toString();
}

async function runFixtureCli(manifest, uri) {
  const directory = await mkdtemp(join(tmpdir(), 'org08-auth-fixture-'));
  const manifestPath = join(directory, 'synthetic-manifest.json');
  try {
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    return await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL('./organization-role-reconciliation.mjs', import.meta.url),
          ),
          '--manifest',
          manifestPath,
        ],
        {
          env: { ORG08_RECONCILIATION_MONGODB_URI: uri },
          windowsHide: true,
          timeout: 20_000,
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  } finally {
    await unlink(manifestPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rmdir(directory);
  }
}

function liveFixtureManifest() {
  const manifest = fixtureManifest();
  const now = Date.now();
  const iso = (offset) => new Date(now + offset).toISOString();
  manifest.snapshot.createdAt = iso(-60_000);
  manifest.snapshot.retentionExpiresAt = iso(3_600_000);
  manifest.restore.restoredAt = iso(-45_000);
  manifest.restore.target.hosts = [new URL(replicaSet.getUri()).host];
  manifest.database.accountName = readerName;
  for (const evidence of [
    manifest.snapshot.integrity,
    manifest.restore.integrity,
    manifest.restore.networkIsolation,
    manifest.database.effectivePrivileges,
    manifest.database.writeDenial,
    manifest.authorization.projectLead,
    manifest.executionWindow.confirmation,
  ]) {
    evidence.verifiedAt = iso(-30_000);
  }
  manifest.database.effectivePrivileges.accountName = readerName;
  manifest.database.writeDenial.accountName = readerName;
  manifest.authorization.projectLead.authorizedAt = iso(-25_000);
  manifest.executionWindow.confirmedAt = iso(-10_000);
  manifest.executionWindow.startAt = iso(-1_000);
  manifest.executionWindow.endAt = iso(120_000);
  return manifest;
}

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
      auth: {
        enable: true,
        customRootName: 'org08-synthetic-root',
        customRootPwd: rootPassword,
        keyfileContent: randomBytes(48).toString('base64'),
      },
      name: 'org08-local-fixture',
      count: 1,
      storageEngine: 'wiredTiger',
    },
    instanceOpts: [{ ip: '127.0.0.1' }],
  });
  connection = await mongoose
    .createConnection(authenticatedUri('org08-synthetic-root', rootPassword), {
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
  await db.command({
    createRole: 'org08SyntheticReader',
    privileges: fixtureManifest().database.effectivePrivileges.privileges,
    roles: [],
  });
  await db.admin().command({
    createUser: readerName,
    pwd: readerPassword,
    roles: [{ role: 'org08SyntheticReader', db: DATABASE_NAME }],
  });
  await db.admin().command({
    createUser: broadReaderName,
    pwd: readerPassword,
    roles: [{ role: 'read', db: DATABASE_NAME }],
  });
  readerConnection = await mongoose
    .createConnection(authenticatedUri(readerName, readerPassword), {
      serverSelectionTimeoutMS: 5000,
    })
    .asPromise();
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
  await readerConnection?.close();
  await connection?.close();
  await replicaSet?.stop();
});

test('MongoDB enforces the exact read-only role and denies a nonmatching update without changing records', async () => {
  const auth = await readerConnection.db
    .admin()
    .command({ connectionStatus: 1, showPrivileges: true });
  assert.equal(auth.authInfo.authenticatedUsers[0].user, readerName);
  const before = await connection.db
    .collection('role_assignments')
    .find({})
    .sort({ _id: 1 })
    .toArray();
  await assert.rejects(
    readerConnection.db
      .collection('role_assignments')
      .updateOne(
        { _id: id('ffffffffffffffffffffffff') },
        { $set: { syntheticProbe: true } },
        { upsert: false },
      ),
    (error) => error.code === 13 && error.codeName === 'Unauthorized',
  );
  assert.deepEqual(
    await connection.db
      .collection('role_assignments')
      .find({})
      .sort({ _id: 1 })
      .toArray(),
    before,
  );
});

test('CLI verifies live MongoDB identity and privileges before completing with the least-privileged account', async () => {
  const result = await runFixtureCli(
    liveFixtureManifest(),
    authenticatedUri(readerName, readerPassword),
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.result, 'COMPLETED_READ_ONLY');
  assert.equal(output.target.accountName, readerName);
  assert.equal(output.target.replicaSetName, 'org08-local-fixture');
  assert.equal(output.counts.assignments, 2);
  assert.equal(output.counts.byClassification.VALID, 2);
  assert.equal(output.scope.writesPerformed, 0);
  assert.match(output.scriptSha256, /^[a-f0-9]{64}$/);
  for (const privateValue of [
    readerPassword,
    rootPassword,
    'private-fixture@example.test',
    'Private project content',
  ]) {
    assert.equal(result.stdout.includes(privateValue), false);
    assert.equal(result.stderr.includes(privateValue), false);
  }
});

test('CLI rejects a live account with broader read privileges than the approved collection scope', async () => {
  const manifest = liveFixtureManifest();
  manifest.database.accountName = broadReaderName;
  manifest.database.effectivePrivileges.accountName = broadReaderName;
  manifest.database.writeDenial.accountName = broadReaderName;
  const result = await runFixtureCli(
    manifest,
    authenticatedUri(broadReaderName, readerPassword),
  );
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'ORG08 reconciliation stopped: DATABASE_PRIVILEGES_NOT_READ_ONLY\n',
  );
});

test('CLI rejects a manifest whose account differs from the live authenticated account', async () => {
  const manifest = liveFixtureManifest();
  manifest.database.accountName = 'different-synthetic-account';
  manifest.database.effectivePrivileges.accountName =
    'different-synthetic-account';
  manifest.database.writeDenial.accountName = 'different-synthetic-account';
  const result = await runFixtureCli(
    manifest,
    authenticatedUri(readerName, readerPassword),
  );
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'ORG08 reconciliation stopped: DATABASE_ACCOUNT_MISMATCH\n',
  );
});

test('CLI rejects a live administrator account with write privileges', async () => {
  const manifest = liveFixtureManifest();
  manifest.database.accountName = 'org08-synthetic-root';
  manifest.database.effectivePrivileges.accountName = 'org08-synthetic-root';
  manifest.database.writeDenial.accountName = 'org08-synthetic-root';
  const result = await runFixtureCli(
    manifest,
    authenticatedUri('org08-synthetic-root', rootPassword),
  );
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'ORG08 reconciliation stopped: DATABASE_PRIVILEGES_NOT_READ_ONLY\n',
  );
  assert.equal(result.stderr.includes(rootPassword), false);
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

  const result = await reconcileDatabase(db, liveFixtureManifest());

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
