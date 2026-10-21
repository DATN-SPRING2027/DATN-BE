import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  buildFenceRecoveryPlan,
  snapshotHash,
  RECOVERY_DATABASE,
  RECOVERY_MARKER,
} from './organization-role-fence-recovery.plan.mjs';
import {
  applyRecovery,
  inspectRecoveryTarget,
  missingFenceCasFilter,
  planRecovery,
  readRecoveryRows,
} from './20261021-organization-role-fence-recovery.mjs';
const { MongoClient, ObjectId } = mongoose.mongo;
const id = (n) => new ObjectId(n.toString(16).padStart(24, '0'));
const fixtureRows = () =>
  Array.from({ length: 22 }, (_, index) => ({
    _id: id(index + 1),
    organizationId: id(100),
    userId: id(index + 200),
    roleId: id(300),
    roleCode: index < 4 ? 'ADMIN' : index < 8 ? 'TEAM_LEADER' : 'MEMBER',
    ...(index >= 4 ? { projectId: id(400) } : {}),
    assignedBy: id(500),
    createdAt: new Date('2026-10-21T00:00:00Z'),
    updatedAt: new Date('2026-10-21T00:00:00Z'),
    opaqueMetadata: { preserve: index },
    ...(index >= 12 ? { mutationFence: index } : {}),
  }));
let replica, client, collection, fixtureUri;
before(async () => {
  const password = randomBytes(24).toString('hex');
  const name = 'org08-mongo8-recovery-' + randomBytes(5).toString('hex');
  replica = await MongoMemoryReplSet.create({
    binary: { version: '8.0.17' },
    replSet: {
      name,
      count: 1,
      ip: '127.0.0.1',
      auth: {
        enable: true,
        customRootName: 'fixture-root',
        customRootPwd: password,
        keyfileContent: randomBytes(48).toString('base64'),
      },
    },
    instanceOpts: [{ ip: '127.0.0.1' }],
  });
  const uri = new URL(replica.getUri(RECOVERY_DATABASE));
  uri.username = 'fixture-root';
  uri.password = password;
  uri.searchParams.set('authSource', 'admin');
  fixtureUri = uri.toString();
  client = await MongoClient.connect(uri.toString());
  await client.db('admin').collection('datn_migration_test_fixture').insertOne({
    _id: RECOVERY_MARKER,
    replicaSet: name,
    environment: 'DISPOSABLE_LOCAL',
  });
  collection = client.db(RECOVERY_DATABASE).collection('role_assignments');
});
beforeEach(async () => {
  if (
    await client
      .db(RECOVERY_DATABASE)
      .listCollections({ name: 'role_assignments' })
      .hasNext()
  )
    await client
      .db(RECOVERY_DATABASE)
      .command({ collMod: 'role_assignments', validator: {} });
  await collection.deleteMany({});
  await collection.insertMany(fixtureRows());
});
after(async () => {
  await client?.close();
  await replica?.stop();
});
test('actual CLI dry-run, apply and retry use the reviewed plan without emitting URI or credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'org08-fence-recovery-cli-'));
  const planPath = join(directory, 'reviewed-plan.json');
  const script = fileURLToPath(
    new URL('./20261021-organization-role-fence-recovery.mjs', import.meta.url),
  );
  const invoke = (args) =>
    promisify(execFile)(process.execPath, [script, ...args], {
      env: { ORG08_RECOVERY_MONGODB_URI: fixtureUri },
      windowsHide: true,
      timeout: 20000,
    });
  try {
    const dry = await invoke([]);
    assert.equal(dry.stdout.includes(fixtureUri), false);
    assert.equal(JSON.parse(dry.stdout).missingCount, 12);
    await writeFile(planPath, dry.stdout, { mode: 0o600 });
    const args = ['--apply', '--writers-paused', '--reviewed-plan=' + planPath];
    assert.equal(JSON.parse((await invoke(args)).stdout).outcome, 'APPLIED');
    assert.equal(JSON.parse((await invoke(args)).stdout).outcome, 'REPLAYED');
    assert.equal(
      (await readFile(planPath, 'utf8')).includes(fixtureUri),
      false,
    );
  } finally {
    await unlink(planPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rmdir(directory);
  }
});
test('server is authenticated MongoDB 8; planning is read-only and proposes exactly 12', async () => {
  const before = snapshotHash(await readRecoveryRows(client));
  assert.equal(
    (await client.db('admin').command({ buildInfo: 1 })).versionArray[0],
    8,
  );
  const plan = await planRecovery(client);
  assert.equal(plan.clean, true);
  assert.equal(plan.missingCount, 12);
  assert.equal(snapshotHash(await readRecoveryRows(client)), before);
});
test('apply persists exactly 12; preserves roles, scopes, timestamps, extra fields and all existing fences', async () => {
  const before = await readRecoveryRows(client),
    plan = await planRecovery(client);
  const result = await applyRecovery(client, plan, { writersPaused: true });
  assert.equal(result.outcome, 'APPLIED');
  assert.equal(result.changedCount, 12);
  const after = await readRecoveryRows(client);
  assert.deepEqual(
    after,
    before.map((row) =>
      Object.hasOwn(row, 'mutationFence') ? row : { ...row, mutationFence: 0 },
    ),
  );
});
test('retry with the same reviewed plan is idempotent after commit', async () => {
  const plan = await planRecovery(client);
  await applyRecovery(client, plan, { writersPaused: true });
  const before = snapshotHash(await readRecoveryRows(client));
  assert.equal(
    (await applyRecovery(client, plan, { writersPaused: true })).outcome,
    'REPLAYED',
  );
  assert.equal(snapshotHash(await readRecoveryRows(client)), before);
});
test('two concurrent applies have one apply and one replay; no partial or duplicate updates', async () => {
  const plan = await planRecovery(client);
  const outcomes = await Promise.all([
    applyRecovery(client, plan, { writersPaused: true }),
    applyRecovery(client, plan, { writersPaused: true }),
  ]);
  assert.deepEqual(outcomes.map((value) => value.outcome).sort(), [
    'APPLIED',
    'REPLAYED',
  ]);
  assert.equal(snapshotHash(await readRecoveryRows(client)), plan.afterHash);
});
test('CAS refuses a stale original after a concurrent role change', async () => {
  const original = await collection.findOne({ _id: id(1) });
  await collection.updateOne({ _id: id(1) }, { $set: { roleCode: 'MEMBER' } });
  const result = await collection.updateOne(missingFenceCasFilter(original), {
    $set: { mutationFence: 0 },
  });
  assert.equal(result.matchedCount, 0);
  assert.equal(
    await collection.countDocuments({
      _id: id(1),
      mutationFence: { $exists: true },
    }),
    0,
  );
});
test('CAS refuses overwriting a concurrently initialized fence', async () => {
  const original = await collection.findOne({ _id: id(1) });
  await collection.updateOne({ _id: id(1) }, { $set: { mutationFence: 7 } });
  assert.equal(
    (
      await collection.updateOne(missingFenceCasFilter(original), {
        $set: { mutationFence: 0 },
      })
    ).matchedCount,
    0,
  );
  assert.equal((await collection.findOne({ _id: id(1) })).mutationFence, 7);
});
test('stale reviewed plan refuses role/scope/other metadata drift without writing', async () => {
  const plan = await planRecovery(client);
  await collection.updateOne(
    { _id: id(1) },
    { $set: { projectId: id(999), opaqueMetadata: 'concurrent' } },
  );
  const changed = snapshotHash(await readRecoveryRows(client));
  await assert.rejects(
    applyRecovery(client, plan, { writersPaused: true }),
    /SNAPSHOT_CHANGED/,
  );
  assert.equal(snapshotHash(await readRecoveryRows(client)), changed);
});
test('server-side validation failure aborts every preceding write, then retry succeeds', async () => {
  const plan = await planRecovery(client);
  await client.db(RECOVERY_DATABASE).command({
    collMod: 'role_assignments',
    validator: { $nor: [{ _id: id(2), mutationFence: { $exists: true } }] },
    validationLevel: 'strict',
    validationAction: 'error',
  });
  await assert.rejects(
    applyRecovery(client, plan, { writersPaused: true }),
    (error) => error.code === 121,
  );
  assert.equal(snapshotHash(await readRecoveryRows(client)), plan.beforeHash);
  await client
    .db(RECOVERY_DATABASE)
    .command({ collMod: 'role_assignments', validator: {} });
  assert.equal(
    (await applyRecovery(client, plan, { writersPaused: true })).changedCount,
    12,
  );
});
test('offline disposable before-image restore recovers exact snapshot; valid fences are unchanged', async () => {
  const backup = await readRecoveryRows(client),
    plan = await planRecovery(client);
  await applyRecovery(client, plan, { writersPaused: true });
  // Recovery drill only on this owned fixture. Never unset a live version after runtime use.
  await collection.deleteMany({});
  await collection.insertMany(backup);
  assert.equal(snapshotHash(await readRecoveryRows(client)), plan.beforeHash);
});
test('invalid existing fence is blocked; no paused-writers assertion is blocked', async () => {
  await collection.updateOne(
    { _id: id(22) },
    { $set: { mutationFence: null } },
  );
  const plan = await planRecovery(client);
  await assert.rejects(
    applyRecovery(client, plan, { writersPaused: true }),
    /REVIEWED_PLAN_INVALID/,
  );
  await assert.rejects(applyRecovery(client, plan), /WRITERS_PAUSED/);
});
test('tampered reviewed plan is refused before document writes', async () => {
  const plan = await planRecovery(client);
  await assert.rejects(
    applyRecovery(
      client,
      { ...plan, missingCount: 0 },
      { writersPaused: true },
    ),
    /REVIEWED_PLAN_INVALID/,
  );
  assert.equal(snapshotHash(await readRecoveryRows(client)), plan.beforeHash);
});
test('missing disposable marker is refused and restored by the owning fixture', async () => {
  const markers = client.db('admin').collection('datn_migration_test_fixture');
  const marker = await markers.findOne({ _id: RECOVERY_MARKER });
  await markers.deleteOne({ _id: RECOVERY_MARKER });
  try {
    await assert.rejects(inspectRecoveryTarget(client), /AUTHENTICATED_MARKED/);
  } finally {
    await markers.insertOne(marker);
  }
});
