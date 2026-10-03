import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import mongoose from 'mongoose';
import { DATABASE_PER_SERVICE_INVENTORY } from './database-per-service-split.plan.mjs';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? test : test.skip;
const runnerPath = fileURLToPath(
  new URL('./20261002-database-per-service-split.mjs', import.meta.url),
);
const sourceDatabase = 'continuum_db';
const destinationDatabases = Object.keys(DATABASE_PER_SERVICE_INVENTORY);
const requiredTargetMarker = 'datn-pr13-mongo7-disposable';

function assertDisposableReplicaSetTarget() {
  assert.equal(
    process.env.MONGODB_INTEGRATION_TARGET,
    requiredTargetMarker,
    `Set MONGODB_INTEGRATION_TARGET=${requiredTargetMarker} only for the disposable local MongoDB 7 replica set`,
  );

  const rawUri = process.env.MONGODB_URI;
  assert.ok(
    rawUri,
    'MONGODB_URI must point to the disposable local replica set',
  );
  const uri = new URL(rawUri);
  assert.ok(
    uri.protocol === 'mongodb:' || uri.protocol === 'mongodb+srv:',
    'MONGODB_URI must use the MongoDB protocol',
  );
  assert.ok(
    ['localhost', '127.0.0.1', '::1', '[::1]'].includes(uri.hostname),
    'integration tests may only connect to a loopback MongoDB host',
  );
  assert.equal(
    uri.port,
    '27018',
    'integration tests require the isolated fixture port 27018',
  );
  assert.equal(
    uri.username,
    '',
    'integration URI must not contain credentials',
  );
  assert.equal(
    uri.password,
    '',
    'integration URI must not contain credentials',
  );
  assert.equal(
    uri.searchParams.get('replicaSet'),
    'rs0',
    'integration tests require a replica set named rs0',
  );
}

function runRunner(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, MONGODB_AUTO_INDEX: 'false' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill(), 60_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function parseReport(stdout) {
  const rootEnd = stdout.indexOf('\n}\n');
  assert.notEqual(rootEnd, -1, `runner did not print a JSON report: ${stdout}`);
  return JSON.parse(stdout.slice(0, rootEnd + 2));
}

function applyArgs(reportSha256) {
  return [
    '--apply',
    '--source-writes-paused',
    '--target-writes-paused',
    '--backup-verified',
    '--cutover-authorized',
    `--expected-report-sha256=${reportSha256}`,
  ];
}

async function resetDatabases(client) {
  for (const databaseName of [sourceDatabase, ...destinationDatabases]) {
    await client.db(databaseName).dropDatabase();
  }
}

async function createCollection(
  db,
  name,
  { options, indexes = [], documents = [] } = {},
) {
  const collection = await db.createCollection(name, options ?? {});
  if (documents.length) await collection.insertMany(documents);
  for (const index of indexes) {
    await collection.createIndex(index.key, {
      name: index.name,
      ...Object.fromEntries(
        Object.entries(index).filter(([key]) => !['key', 'name'].includes(key)),
      ),
    });
  }
  return collection;
}

async function allDocuments(collection) {
  return collection.find({}).sort({ _id: 1 }).toArray();
}

integration('MongoDB 7 replica-set migration runner integration', async (t) => {
  assertDisposableReplicaSetTarget();
  const client = new mongoose.mongo.MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5_000,
  });
  await client.connect();

  try {
    const admin = client.db('admin');
    const buildInfo = await admin.command({ buildInfo: 1 });
    assert.equal(
      buildInfo.versionArray[0],
      7,
      'integration server must be MongoDB 7',
    );
    const hello = await admin.command({ hello: 1 });
    assert.equal(
      hello.setName,
      'rs0',
      'integration server must be replica set rs0',
    );
    assert.equal(
      hello.isWritablePrimary,
      true,
      'replica-set node must be primary',
    );
    const testCommands = await admin.command({
      getParameter: 1,
      enableTestCommands: 1,
    });
    assert.ok(
      testCommands.enableTestCommands === true ||
        testCommands.enableTestCommands === 1,
      'test fixture must enable MongoDB test commands',
    );
    const fixtureMarker = await admin
      .collection('datn_migration_test_fixture')
      .findOne({ _id: requiredTargetMarker });
    assert.ok(
      fixtureMarker,
      'disposable fixture marker is missing from the admin database',
    );

    await resetDatabases(client);

    await t.test(
      'successful apply and exact rerun verify the copied state',
      async () => {
        await resetDatabases(client);
        const users = await createCollection(
          client.db(sourceDatabase),
          'users',
          {
            indexes: [{ name: 'email_1', key: { email: 1 }, unique: true }],
            documents: [
              { _id: 'user-1', email: 'one@example.test' },
              { _id: 'user-2', email: 'two@example.test' },
            ],
          },
        );
        const sourceBefore = await allDocuments(users);

        const dryRun = await runRunner();
        assert.equal(dryRun.status, 0, dryRun.stderr);
        const plan = parseReport(dryRun.stdout);
        assert.equal(plan.clean, true);
        assert.ok(plan.scanMetrics.peakHeapUsedBytes > 0);
        assert.equal(plan.scanMetrics.limits.cursorBatchSize, 100);
        assert.ok(
          plan.missingRequiredSchemaIndexes.some(
            (difference) =>
              difference.databaseName === 'continuum_iam' &&
              difference.collection === 'users' &&
              difference.index === 'status_1_createdAt_1',
          ),
        );

        const applied = await runRunner(applyArgs(plan.reportSha256));
        assert.equal(
          applied.status,
          0,
          `status=${applied.status}\nstdout=${applied.stdout}\nstderr=${applied.stderr}`,
        );
        assert.match(applied.stdout, /source collections remain unchanged/);
        assert.deepEqual(await allDocuments(users), sourceBefore);
        assert.deepEqual(
          await allDocuments(client.db('continuum_iam').collection('users')),
          sourceBefore,
        );
        assert.ok(
          (
            await client
              .db('continuum_iam')
              .collection('users')
              .listIndexes()
              .toArray()
          ).some((index) => index.name === 'status_1_createdAt_1'),
          'apply must create a required index declared by the active IAM schema',
        );
        t.diagnostic(
          `Initial MongoDB 7 disposable-fixture scan metrics: ${JSON.stringify(plan.scanMetrics)}`,
        );

        const retryPlanResult = await runRunner();
        assert.equal(
          retryPlanResult.status,
          0,
          `${retryPlanResult.stdout}\n${retryPlanResult.stderr}`,
        );
        const retryPlan = parseReport(retryPlanResult.stdout);
        assert.equal(retryPlan.clean, true);
        assert.equal(retryPlan.counts.documentsToInsert, 0);

        const retried = await runRunner(applyArgs(retryPlan.reportSha256));
        assert.equal(retried.status, 0, retried.stderr);
        assert.deepEqual(await allDocuments(users), sourceBefore);
        assert.equal(
          await client.db('continuum_iam').collection('users').countDocuments(),
          sourceBefore.length,
        );
      },
    );

    await t.test(
      'index failure after copy preserves source and a fresh retry completes',
      async () => {
        await resetDatabases(client);
        const teams = await createCollection(
          client.db(sourceDatabase),
          'teams',
          {
            indexes: [{ name: 'team_code_1', key: { code: 1 }, unique: true }],
            documents: [
              {
                _id: 'team-1',
                organizationId: 'org-1',
                projectId: 'project-1',
                code: 'TEAM-1',
              },
              {
                _id: 'team-2',
                organizationId: 'org-1',
                projectId: 'project-1',
                code: 'TEAM-2',
              },
            ],
          },
        );
        const sourceBefore = await allDocuments(teams);
        const dryRun = await runRunner();
        assert.equal(dryRun.status, 0, dryRun.stderr);
        const plan = parseReport(dryRun.stdout);
        assert.equal(plan.clean, true);

        await admin.command({
          configureFailPoint: 'failCommand',
          mode: { times: 1 },
          data: { failCommands: ['createIndexes'], errorCode: 123 },
        });
        let failedApply;
        try {
          failedApply = await runRunner(applyArgs(plan.reportSha256));
        } finally {
          await admin.command({
            configureFailPoint: 'failCommand',
            mode: 'off',
          });
        }

        assert.equal(failedApply.status, 1, failedApply.stdout);
        assert.match(failedApply.stderr, /createIndexes|failCommand|123/);
        assert.deepEqual(await allDocuments(teams), sourceBefore);
        const partialTarget = client.db('continuum_iam').collection('teams');
        assert.deepEqual(await allDocuments(partialTarget), sourceBefore);

        const retryPlanResult = await runRunner();
        assert.equal(
          retryPlanResult.status,
          0,
          `${retryPlanResult.stdout}\n${retryPlanResult.stderr}`,
        );
        const retryPlan = parseReport(retryPlanResult.stdout);
        assert.equal(retryPlan.clean, true);
        assert.equal(retryPlan.counts.documentsToInsert, 0);
        const retried = await runRunner(applyArgs(retryPlan.reportSha256));
        assert.equal(retried.status, 0, retried.stderr);
        assert.deepEqual(await allDocuments(teams), sourceBefore);
        assert.deepEqual(await allDocuments(partialTarget), sourceBefore);
        assert.ok(
          (await partialTarget.listIndexes().toArray()).some(
            (index) => index.name === 'team_code_1',
          ),
        );
      },
    );

    await t.test(
      'inherited non-simple unique collation blocks before copy',
      async () => {
        await resetDatabases(client);
        const options = { collation: { locale: 'en', strength: 2 } };
        const source = await createCollection(
          client.db(sourceDatabase),
          'users',
          {
            options,
            indexes: [{ name: 'email_1', key: { email: 1 }, unique: true }],
            documents: [{ _id: 'source-user', email: 'Person@example.test' }],
          },
        );
        const sourceBefore = await allDocuments(source);
        await createCollection(client.db('continuum_iam'), 'users', {
          options,
          documents: [{ _id: 'target-user', email: 'person@EXAMPLE.test' }],
        });

        const dryRun = await runRunner();
        assert.equal(dryRun.status, 2, dryRun.stderr);
        const plan = parseReport(dryRun.stdout);
        assert.equal(plan.clean, false);
        assert.ok(
          plan.unverifiableUniqueIndexes.some(
            (index) =>
              index.index === 'email_1' &&
              index.effectiveCollation.locale === 'en',
          ),
        );
        assert.deepEqual(await allDocuments(source), sourceBefore);
        assert.equal(
          await client
            .db('continuum_iam')
            .collection('users')
            .countDocuments({ _id: 'source-user' }),
          0,
        );
      },
    );

    await t.test(
      'equivalent index under another name blocks before copy',
      async () => {
        await resetDatabases(client);
        const source = await createCollection(
          client.db(sourceDatabase),
          'users',
          {
            indexes: [{ name: 'email_1', key: { email: 1 }, unique: true }],
            documents: [{ _id: 'source-user', email: 'person@example.test' }],
          },
        );
        const sourceBefore = await allDocuments(source);
        await createCollection(client.db('continuum_iam'), 'users', {
          indexes: [{ name: 'legacy_email', key: { email: 1 }, unique: true }],
        });

        const dryRun = await runRunner();
        assert.equal(dryRun.status, 2, dryRun.stderr);
        const plan = parseReport(dryRun.stdout);
        assert.equal(plan.clean, false);
        assert.ok(
          plan.blockingIndexDifferences.some(
            (difference) =>
              difference.status === 'EQUIVALENT_TARGET_INDEX_DIFFERENT_NAME' &&
              difference.index === 'email_1' &&
              difference.targetIndex === 'legacy_email',
          ),
        );
        assert.deepEqual(await allDocuments(source), sourceBefore);
        assert.equal(
          await client.db('continuum_iam').collection('users').countDocuments(),
          0,
        );
      },
    );

    await t.test(
      'MongoDB-incompatible TTL options block before copy',
      async () => {
        await resetDatabases(client);
        const source = await createCollection(
          client.db(sourceDatabase),
          'users',
          {
            indexes: [
              {
                name: 'expiresAt_1',
                key: { expiresAt: 1 },
                expireAfterSeconds: 60,
              },
            ],
            documents: [
              {
                _id: 'source-user',
                expiresAt: new Date('2030-01-01T00:00:00.000Z'),
              },
            ],
          },
        );
        const sourceBefore = await allDocuments(source);
        await createCollection(client.db('continuum_iam'), 'users', {
          indexes: [
            {
              name: 'legacy_expiry',
              key: { expiresAt: 1 },
              expireAfterSeconds: 120,
            },
          ],
        });

        const dryRun = await runRunner();
        assert.equal(dryRun.status, 2, dryRun.stderr);
        const plan = parseReport(dryRun.stdout);
        assert.equal(plan.clean, false);
        assert.ok(
          plan.blockingIndexDifferences.some(
            (difference) =>
              difference.status === 'INCOMPATIBLE_TARGET_INDEX_OPTIONS' &&
              difference.index === 'expiresAt_1' &&
              difference.targetIndex === 'legacy_expiry',
          ),
        );
        assert.deepEqual(await allDocuments(source), sourceBefore);
        assert.equal(
          await client.db('continuum_iam').collection('users').countDocuments(),
          0,
        );
      },
    );

    await t.test(
      'same-key MongoDB-supported collation and sparse variants coexist',
      async () => {
        await resetDatabases(client);
        const source = await createCollection(
          client.db(sourceDatabase),
          'audit_logs_iam',
          {
            indexes: [
              {
                name: 'email_en',
                key: { email: 1 },
                collation: { locale: 'en', strength: 2 },
              },
              { name: 'username_sparse', key: { username: 1 }, sparse: true },
            ],
            documents: [{ _id: 'source-user', email: 'person@example.test' }],
          },
        );
        const target = await createCollection(
          client.db('continuum_audit'),
          'audit_logs_iam',
          {
            indexes: [
              { name: 'email_simple', key: { email: 1 } },
              { name: 'username_dense', key: { username: 1 } },
            ],
            documents: [{ _id: 'target-user', email: 'other@example.test' }],
          },
        );
        const sourceBefore = await allDocuments(source);

        const dryRun = await runRunner();
        assert.equal(dryRun.status, 0, dryRun.stderr);
        const plan = parseReport(dryRun.stdout);
        assert.equal(plan.clean, true);
        const applied = await runRunner(applyArgs(plan.reportSha256));
        assert.equal(
          applied.status,
          0,
          `status=${applied.status}\nstdout=${applied.stdout}\nstderr=${applied.stderr}`,
        );
        assert.deepEqual(await allDocuments(source), sourceBefore);
        const indexNames = (await target.listIndexes().toArray()).map(
          (index) => index.name,
        );
        assert.ok(indexNames.includes('email_en'));
        assert.ok(indexNames.includes('email_simple'));
        assert.ok(indexNames.includes('username_sparse'));
        assert.ok(indexNames.includes('username_dense'));
      },
    );

    await t.test(
      'reports measured memory for a bounded multi-batch document scan',
      async () => {
        await resetDatabases(client);
        const source = await client
          .db(sourceDatabase)
          .createCollection('users');
        const payload = 'm'.repeat(8 * 1024 * 1024);
        for (let index = 0; index < 4; index += 1) {
          await source.insertOne({
            _id: `measured-user-${index}`,
            email: `measured-${index}@example.test`,
            payload,
          });
        }

        const dryRun = await runRunner();
        assert.equal(dryRun.status, 0, dryRun.stderr);
        const plan = parseReport(dryRun.stdout);
        assert.equal(plan.clean, true);
        assert.ok(plan.scanMetrics.ejsonDocumentBytes >= 32 * 1024 * 1024);
        assert.ok(
          plan.scanMetrics.peakHeapUsedBytes <=
            plan.scanMetrics.limits.maxHeapUsedBytes,
        );
        assert.ok(
          plan.scanMetrics.reportBytes <=
            plan.scanMetrics.limits.maxReportBytes,
        );
        t.diagnostic(
          `32 MiB+ MongoDB 7 disposable-fixture scan metrics: ${JSON.stringify(plan.scanMetrics)}`,
        );
      },
    );

    await t.test(
      'destination-only collections block and are reported before copy',
      async () => {
        await resetDatabases(client);
        const source = await createCollection(
          client.db(sourceDatabase),
          'users',
          {
            documents: [{ _id: 'source-user', email: 'person@example.test' }],
          },
        );
        const sourceBefore = await allDocuments(source);
        await createCollection(client.db('continuum_iam'), 'users', {
          documents: [{ _id: 'target-only-user', email: 'other@example.test' }],
        });
        await createCollection(
          client.db('continuum_iam'),
          'unexpected_iam_collection',
          {
            documents: [{ _id: 'extra-iam' }],
          },
        );
        await createCollection(
          client.db('continuum_capture'),
          'unexpected_capture_collection',
          {
            documents: [{ _id: 'extra-capture' }],
          },
        );

        const dryRun = await runRunner();
        assert.equal(dryRun.status, 2, dryRun.stderr);
        const plan = parseReport(dryRun.stdout);
        assert.equal(plan.clean, false);
        assert.deepEqual(
          plan.targetOnlyCollections.map((collection) => collection.collection),
          ['unexpected_capture_collection', 'unexpected_iam_collection'],
        );
        assert.ok(
          plan.targetOnlyDocuments.some(
            (document) => document.id === 'target-only-user',
          ),
        );
        assert.deepEqual(await allDocuments(source), sourceBefore);
        assert.equal(
          await client
            .db('continuum_iam')
            .collection('users')
            .countDocuments({ _id: 'source-user' }),
          0,
        );
        assert.equal(
          await client
            .db('continuum_iam')
            .collection('unexpected_iam_collection')
            .countDocuments(),
          1,
        );
        assert.equal(
          await client
            .db('continuum_capture')
            .collection('unexpected_capture_collection')
            .countDocuments(),
          1,
        );
      },
    );

    await t.test(
      'scan refuses a dataset beyond its configured memory input budget',
      async () => {
        await resetDatabases(client);
        const source = await client
          .db(sourceDatabase)
          .createCollection('users');
        const oversizedPayload = 'x'.repeat(13 * 1024 * 1024);
        for (let index = 0; index < 5; index += 1) {
          await source.insertOne({
            _id: `large-user-${index}`,
            email: `large-${index}@example.test`,
            payload: oversizedPayload,
          });
        }

        const dryRun = await runRunner();
        assert.equal(dryRun.status, 1, dryRun.stdout);
        assert.match(
          dryRun.stderr,
          /EJSON document-byte limit; refusing to build a partial report/,
        );
        assert.equal(dryRun.stdout.includes('reportSha256'), false);
        assert.equal(await source.countDocuments(), 5);
        assert.equal(
          await client.db('continuum_iam').collection('users').countDocuments(),
          0,
        );
      },
    );
  } finally {
    await resetDatabases(client);
    await client.close();
  }
});
