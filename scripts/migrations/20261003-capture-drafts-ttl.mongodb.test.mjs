import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import {
  applyCaptureDraftsTtl,
  buildCaptureDraftsTtlReport,
} from './20261003-capture-drafts-ttl.mjs';
import {
  CAPTURE_DRAFTS_RETENTION_SECONDS,
  isCaptureDraftTtlEligible,
} from './capture-drafts-ttl.plan.mjs';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? test : test.skip;
const requiredTargetMarker = 'datn-capture-drafts-ttl-mongo7-disposable';
const databaseName = 'continuum_capture';
const collectionName = 'capture_drafts';
const retentionMs = CAPTURE_DRAFTS_RETENTION_SECONDS * 1000;

function assertDisposableReplicaSetTarget() {
  assert.equal(
    process.env.MONGODB_INTEGRATION_TARGET,
    requiredTargetMarker,
    `Set MONGODB_INTEGRATION_TARGET=${requiredTargetMarker} only for the dedicated disposable MongoDB 7 fixture`,
  );

  const rawUri = process.env.MONGODB_URI;
  assert.ok(
    rawUri,
    'MONGODB_URI must point to the disposable local replica set',
  );
  const uri = new URL(rawUri);
  assert.ok(
    ['mongodb:', 'mongodb+srv:'].includes(uri.protocol),
    'MONGODB_URI must use the MongoDB protocol',
  );
  assert.ok(
    ['localhost', '127.0.0.1', '::1', '[::1]'].includes(uri.hostname),
    'integration may connect only to a loopback MongoDB host',
  );
  assert.equal(uri.port, '27019', 'integration requires fixture port 27019');
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
    'integration requires replica set rs0',
  );
}

function matchingIndex(indexes, key) {
  return indexes.find(
    (index) => JSON.stringify(index.key) === JSON.stringify(key),
  );
}

async function waitForDocumentRemoval(collection, id, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!(await collection.findOne({ _id: id }))) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`TTL monitor did not remove expired fixture document ${id}`);
}

integration(
  'capture_drafts 30-day TTL migration on disposable MongoDB 7',
  async (t) => {
    assertDisposableReplicaSetTarget();
    const client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5_000,
    });
    await client.connect();
    const admin = client.db('admin');
    let testDatabaseCreated = false;

    try {
      const buildInfo = await admin.command({ buildInfo: 1 });
      assert.equal(buildInfo.versionArray[0], 7, 'fixture must run MongoDB 7');
      const hello = await admin.command({ hello: 1 });
      assert.equal(hello.setName, 'rs0', 'fixture must be replica set rs0');
      assert.equal(
        hello.isWritablePrimary,
        true,
        'fixture node must be primary',
      );
      const marker = await admin
        .collection('datn_migration_test_fixture')
        .findOne({ _id: requiredTargetMarker });
      assert.ok(marker, 'dedicated disposable fixture marker is missing');
      const existingDatabase = await client
        .db('admin')
        .admin()
        .listDatabases({ nameOnly: true });
      assert.equal(
        existingDatabase.databases.some((item) => item.name === databaseName),
        false,
        `${databaseName} must not exist before this isolated integration test`,
      );

      const database = client.db(databaseName);
      testDatabaseCreated = true;
      const drafts = database.collection(collectionName);
      const unrelated = database.collection('capture_drafts_test_sentinel');
      const unrelatedIndex = await unrelated.createIndex({ owner: 1 });
      await unrelated.insertOne({ _id: 'sentinel', owner: 'unchanged' });
      const unrelatedBefore = {
        documents: await unrelated.find().sort({ _id: 1 }).toArray(),
        indexes: await unrelated.listIndexes().toArray(),
      };

      await drafts.insertMany([
        {
          _id: 'expired-draft',
          userId: 'user-expired',
          contextKey: 'project-expired',
          lastSavedAt: new Date(Date.now() - retentionMs - 120_000),
        },
        {
          _id: 'fresh-draft',
          userId: 'user-fresh',
          contextKey: 'project-fresh',
          lastSavedAt: new Date(),
        },
        {
          _id: 'extended-draft',
          userId: 'user-extended',
          contextKey: 'project-extended',
          lastSavedAt: new Date(Date.now() - retentionMs - 86_400_000),
        },
        {
          _id: 'missing-date',
          userId: 'user-missing',
          contextKey: 'project-missing',
        },
        {
          _id: 'string-date',
          userId: 'user-string',
          contextKey: 'project-string',
          lastSavedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);

      await assert.rejects(
        drafts.createIndex(
          { userId: 1, contextKey: 1 },
          { expireAfterSeconds: 0 },
        ),
        (error) => error?.code === 67,
        "MongoDB 7 must reject the repository's old compound TTL definition",
      );
      // The closest index state MongoDB 7 can retain from the prior declaration.
      await drafts.createIndex({ userId: 1, contextKey: 1 });
      const oldIndexes = await drafts.listIndexes().toArray();
      const oldPairIndex = matchingIndex(oldIndexes, {
        userId: 1,
        contextKey: 1,
      });
      assert.ok(oldPairIndex, 'legacy compound index fixture was not created');
      assert.equal(oldPairIndex.expireAfterSeconds, undefined);
      assert.notEqual(oldPairIndex.unique, true);

      const malformedReport = await buildCaptureDraftsTtlReport({
        db: database,
        databaseName,
        uri: process.env.MONGODB_URI,
      });
      assert.equal(malformedReport.clean, false);
      assert.equal(malformedReport.counts.missingLastSavedAt, 1);
      assert.equal(malformedReport.counts.nonDateLastSavedAt, 1);
      assert.deepEqual(
        malformedReport.malformedExamples.map((item) => item.id).sort(),
        ['missing-date', 'string-date'],
      );
      assert.deepEqual(
        malformedReport.malformedExamples
          .map((item) => item.lastSavedAtType)
          .sort(),
        ['missing', 'string'],
      );
      await assert.rejects(
        applyCaptureDraftsTtl({ db: database, report: malformedReport }),
        /DRAFTS_MISSING_LAST_SAVED_AT, DRAFTS_NON_DATE_LAST_SAVED_AT/,
      );
      assert.equal(
        (await drafts.listIndexes().toArray()).some(
          (index) =>
            JSON.stringify(index.key) === JSON.stringify({ lastSavedAt: 1 }),
        ),
        false,
        'blocked preflight must not create a TTL index',
      );
      assert.equal(await drafts.countDocuments(), 5);
      assert.equal(
        (await drafts.listIndexes().toArray()).length,
        oldIndexes.length,
      );

      // Disposable-fixture cleanup only. Real malformed documents are never rewritten or deleted.
      await drafts.deleteMany({
        _id: { $in: ['missing-date', 'string-date'] },
      });
      await drafts.updateOne(
        { _id: 'extended-draft' },
        { $set: { lastSavedAt: new Date() } },
      );
      const report = await buildCaptureDraftsTtlReport({
        db: database,
        databaseName,
        uri: process.env.MONGODB_URI,
      });
      assert.equal(report.clean, true);
      assert.equal(report.counts.missingLastSavedAt, 0);
      assert.equal(report.counts.nonDateLastSavedAt, 0);
      assert.equal(report.counts.alreadyExpired, 1);
      assert.equal(report.indexActions.uniqueUserContext, 'REPLACE_LEGACY');
      assert.equal(report.indexActions.lastSavedAtTtl, 'CREATE');

      await assert.rejects(
        applyCaptureDraftsTtl({ db: database, report }),
        /capture draft writes must be paused/,
      );
      await assert.rejects(
        applyCaptureDraftsTtl({
          db: database,
          report,
          captureDraftWritesPaused: true,
        }),
        /already-expired drafts must be reviewed/,
      );
      assert.deepEqual(await drafts.listIndexes().toArray(), oldIndexes);

      const originalFreshDraft = await drafts.findOne({ _id: 'fresh-draft' });
      await drafts.updateOne(
        { _id: 'fresh-draft' },
        { $set: { lastSavedAt: new Date(Date.now() - 1_000) } },
      );
      await assert.rejects(
        applyCaptureDraftsTtl({
          db: database,
          report,
          captureDraftWritesPaused: true,
          expiredDraftsReviewed: true,
        }),
        /collection data or indexes changed since the reviewed report/,
      );
      assert.deepEqual(await drafts.listIndexes().toArray(), oldIndexes);
      await drafts.updateOne(
        { _id: 'fresh-draft' },
        { $set: { lastSavedAt: originalFreshDraft.lastSavedAt } },
      );

      await drafts.insertOne({
        _id: 'changed-after-report',
        userId: 'user-after-report',
        contextKey: 'project-after-report',
        lastSavedAt: 'not-a-date',
      });
      await assert.rejects(
        applyCaptureDraftsTtl({
          db: database,
          report,
          captureDraftWritesPaused: true,
          expiredDraftsReviewed: true,
        }),
        /collection data or indexes changed since the reviewed report/,
      );
      assert.deepEqual(await drafts.listIndexes().toArray(), oldIndexes);
      await drafts.deleteOne({ _id: 'changed-after-report' });
      const reviewedReport = await buildCaptureDraftsTtlReport({
        db: database,
        databaseName,
        uri: process.env.MONGODB_URI,
      });
      assert.equal(reviewedReport.clean, true);

      const applied = await applyCaptureDraftsTtl({
        db: database,
        report: reviewedReport,
        captureDraftWritesPaused: true,
        expiredDraftsReviewed: true,
      });
      assert.equal(applied.documentDeletesIssuedByMigration, 0);

      const indexes = await drafts.listIndexes().toArray();
      const uniqueIndex = matchingIndex(indexes, {
        userId: 1,
        contextKey: 1,
      });
      const ttlIndex = matchingIndex(indexes, { lastSavedAt: 1 });
      assert.ok(uniqueIndex);
      assert.equal(uniqueIndex.unique, true);
      assert.equal(uniqueIndex.expireAfterSeconds, undefined);
      assert.ok(ttlIndex);
      assert.equal(
        ttlIndex.expireAfterSeconds,
        CAPTURE_DRAFTS_RETENTION_SECONDS,
      );
      assert.equal(Object.keys(ttlIndex.key).length, 1);
      assert.equal(
        matchingIndex(indexes, { userId: 1, contextKey: 1 }).expireAfterSeconds,
        undefined,
      );
      await assert.rejects(
        drafts.insertOne({
          _id: 'duplicate-pair',
          userId: 'user-fresh',
          contextKey: 'project-fresh',
          lastSavedAt: new Date(),
        }),
        (error) => error?.code === 11000,
      );

      const extended = await drafts.findOne({ _id: 'extended-draft' });
      assert.ok(extended?.lastSavedAt instanceof Date);
      assert.ok(extended.lastSavedAt.getTime() > Date.now() - retentionMs);
      assert.equal(isCaptureDraftTtlEligible(extended.lastSavedAt), false);
      const fresh = await drafts.findOne({ _id: 'fresh-draft' });
      assert.ok(fresh, 'fresh draft should remain retained');
      const rerunReport = await buildCaptureDraftsTtlReport({
        db: database,
        databaseName,
        uri: process.env.MONGODB_URI,
      });
      assert.equal(rerunReport.clean, true);
      assert.equal(rerunReport.indexActions.uniqueUserContext, 'PRESENT');
      assert.equal(rerunReport.indexActions.lastSavedAtTtl, 'PRESENT');
      const rerun = await applyCaptureDraftsTtl({
        db: database,
        report: rerunReport,
        captureDraftWritesPaused: true,
        expiredDraftsReviewed: true,
      });
      assert.equal(rerun.documentDeletesIssuedByMigration, 0);

      await drafts.insertMany([
        {
          _id: 'missing-after-ttl',
          userId: 'user-missing-after',
          contextKey: 'project-missing-after',
        },
        {
          _id: 'string-after-ttl',
          userId: 'user-string-after',
          contextKey: 'project-string-after',
          lastSavedAt: '2020-01-01T00:00:00.000Z',
        },
      ]);
      const postIndexReport = await buildCaptureDraftsTtlReport({
        db: database,
        databaseName,
        uri: process.env.MONGODB_URI,
      });
      assert.equal(postIndexReport.counts.missingLastSavedAt, 1);
      assert.equal(postIndexReport.counts.nonDateLastSavedAt, 1);
      await waitForDocumentRemoval(drafts, 'expired-draft');
      assert.ok(await drafts.findOne({ _id: 'fresh-draft' }));
      assert.ok(await drafts.findOne({ _id: 'extended-draft' }));
      assert.ok(await drafts.findOne({ _id: 'missing-after-ttl' }));
      assert.ok(await drafts.findOne({ _id: 'string-after-ttl' }));

      assert.deepEqual(
        await unrelated.find().sort({ _id: 1 }).toArray(),
        unrelatedBefore.documents,
      );
      assert.deepEqual(
        await unrelated.listIndexes().toArray(),
        unrelatedBefore.indexes,
      );
      assert.ok(unrelatedIndex);
      t.diagnostic(
        `MongoDB ${buildInfo.version} transformed ${oldPairIndex.name} to unique pair + ${ttlIndex.name}; expired=${report.counts.alreadyExpired}; malformed preflight missing=1/nonDate=1 blocked; unrelated collection unchanged.`,
      );
    } finally {
      if (testDatabaseCreated) await client.db(databaseName).dropDatabase();
      await client.close();
    }
  },
);
