import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { DATABASE, contract } from './handover-v2.plan.mjs';
import {
  inspectHandoverV2,
  migrateHandoverV2,
  parseArguments,
} from './20261028-handover-v2.mjs';

const id = () => new mongoose.Types.ObjectId();
const user = () => id().toHexString();
const record = (scope) => ({
  schemaVersion: 2,
  ...scope,
  departingUserId: user(),
  assignedLeaderId: user(),
  successorUserId: null,
  title: 'Bàn giao',
  targetCompletionDate: new Date(),
  status: 'OPEN',
  version: 1,
  assignmentVersion: 0,
  draftVersion: 0,
  publishedRevisionId: null,
  selectedSources: [],
  selectedTasks: [],
  createdBy: user(),
});

test('CLI requires a reviewed report and paused writers before apply', () => {
  assert.throws(() => parseArguments(['--apply']));
  assert.throws(() => parseArguments(['--apply', '--writes-paused']));
  assert.throws(() => parseArguments(['--unknown']));
  assert.throws(() =>
    parseArguments([
      '--expected-report-sha256=' + 'a'.repeat(64),
      '--expected-report-sha256=' + 'b'.repeat(64),
    ]),
  );
  assert.equal(parseArguments([]).apply, false);
});

test(
  'MongoDB 7: additive migration, legacy preservation, V2 bindings, indexes and retry safety',
  { timeout: 180_000 },
  async () => {
    const replSet = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: { count: 1 },
    });
    const client = new mongoose.mongo.MongoClient(replSet.getUri());
    try {
      await client.connect();
      const db = client.db(DATABASE);
      const scope = { organizationId: id(), projectId: id() };
      const legacy = {
        _id: id(),
        ...scope,
        departingUserId: user(),
        status: 'COMPLETED',
        completedAt: new Date(),
      };
      await db.collection('handovers').insertOne(legacy);
      await db.collection('handover_items').insertOne({
        _id: id(),
        status: 'VERIFIED_BY_SUCCESSOR',
        successorUserId: user(),
        handoverId: legacy._id,
      });
      const before = await db.listCollections().toArray();
      const dry = await migrateHandoverV2(db);
      assert.equal(dry.applied, false);
      assert.equal(
        (await db.listCollections().toArray()).length,
        before.length,
      );
      assert.equal(dry.inventory.handovers.legacyCount, 1);
      assert.equal(dry.blockers.length, 0);
      await assert.rejects(
        migrateHandoverV2(db, {
          apply: true,
          writesPaused: true,
          expectedReportSha256: 'a'.repeat(64),
        }),
        /report changed/,
      );
      assert.equal(
        (await db.listCollections().toArray()).length,
        before.length,
      );
      const result = await migrateHandoverV2(db, {
        apply: true,
        writesPaused: true,
        expectedReportSha256: dry.reportSha256,
      });
      assert.equal(result.applied, true);
      assert.ok(result.collections.every((c) => c.action === 'KEEP'));
      assert.ok(result.indexes.every((i) => i.action === 'KEEP'));
      assert.deepEqual(
        await db.collection('handovers').findOne({ _id: legacy._id }),
        legacy,
      );
      assert.equal(
        await db.collection('handover_acceptances').countDocuments(),
        0,
      );
      const stable = await inspectHandoverV2(db);
      await migrateHandoverV2(db, {
        apply: true,
        writesPaused: true,
        expectedReportSha256: stable.reportSha256,
      });

      const handover = { _id: id(), ...record(scope) };
      await db.collection('handovers').insertOne(handover);
      await assert.rejects(
        db.collection('handovers').insertOne({ ...handover, _id: id() }),
        { code: 11000 },
      );
      await assert.rejects(
        db
          .collection('handovers')
          .insertOne({ ...record(scope), assignmentVersion: 1.5 }),
        { code: 121 },
      );
      await assert.rejects(
        db
          .collection('handovers')
          .insertOne({ ...record(scope), successorUserId: [user(), user()] }),
        { code: 121 },
      );
      await assert.rejects(
        db
          .collection('handovers')
          .insertOne({ ...record(scope), status: 'COMPLETED' }),
        { code: 121 },
      );
      await assert.rejects(
        db
          .collection('handovers')
          .insertOne({ ...record(scope), schemaVersion: 3 }),
        { code: 121 },
      );
      await db.collection('handovers').insertOne({
        ...record(scope),
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: user(),
        cancellationReason: 'Hủy',
      });
      const b = user();
      const itemId = id();
      const revision = {
        _id: id(),
        schemaVersion: 2,
        ...scope,
        handoverId: handover._id,
        number: 1,
        draftVersion: 0,
        assignmentVersion: 1,
        successorUserId: b,
        items: [],
        selectedSources: [],
        selectedTasks: [],
        reviews: [],
        gaps: [],
        publishedBy: user(),
        publishedAt: new Date(),
        sourceFingerprint: 'a'.repeat(64),
        reviewNote: 'Đã kiểm tra bản phát hành',
      };
      await db.collection('handover_revisions').insertOne(revision);
      await assert.rejects(
        db
          .collection('handover_revisions')
          .insertOne({ ...revision, _id: id() }),
        { code: 11000 },
      );
      const item = {
        itemId,
        contentVersion: 1,
        dependencyFingerprint: 'b'.repeat(64),
        title: 'X',
        body: 'x'.repeat(20000),
        requirement: 'Cần hiểu',
        isRequired: true,
        evidenceRequired: true,
        sources: [],
        citations: [],
      };
      const oversizedItems = Array.from({ length: 100 }, () => ({
        ...item,
        // A valid individual item with enough citations to exceed 4 MiB overall.
        citations: Array.from({ length: 100 }, () => ({
          source: {
            kind: 'PROJECT_DOCUMENT',
            id: 'x'.repeat(200),
            version: 'v1',
          },
          locator: { kind: 'SECTION', value: 'x'.repeat(500) },
        })),
      }));
      await assert.rejects(
        db.collection('handover_revisions').insertOne({
          ...revision,
          _id: id(),
          number: 2,
          items: oversizedItems,
        }),
        { code: 121 },
      );
      const binding = {
        schemaVersion: 2,
        ...scope,
        handoverId: handover._id,
        revisionId: revision._id,
        successorUserId: b,
        assignmentVersion: 1,
      };
      const acknowledgement = {
        ...binding,
        itemId,
        contentVersion: 1,
        dependencyFingerprint: 'b'.repeat(64),
        kind: 'ITEM',
        decision: 'UNDERSTOOD',
        note: '',
        commandId: id(),
        sequence: 1,
        occurredAt: new Date(),
      };
      await db.collection('handover_acceptances').insertOne(acknowledgement);
      const { contentVersion: _version, ...withoutContentVersion } =
        acknowledgement;
      await assert.rejects(
        db
          .collection('handover_acceptances')
          .insertOne({ ...withoutContentVersion, _id: id(), commandId: id() }),
        { code: 121 },
      );
      await assert.rejects(
        db
          .collection('handover_acceptances')
          .insertOne({ ...acknowledgement, _id: id() }),
        { code: 11000 },
      );
      // The same B with a new epoch stores independent history, without overwriting epoch 1.
      await db.collection('handover_acceptances').insertOne({
        ...acknowledgement,
        _id: id(),
        assignmentVersion: 3,
        commandId: id(),
        sequence: 2,
      });
      assert.equal(
        await db
          .collection('handover_acceptances')
          .countDocuments({ successorUserId: b }),
        2,
      );
      const evidence = {
        ...binding,
        itemId,
        contentVersion: 1,
        dependencyFingerprint: 'b'.repeat(64),
        resultText: 'Đã thực hiện',
        links: ['https://example.test/evidence'],
        commandId: id(),
        sequence: 1,
        submittedAt: new Date(),
      };
      await db.collection('handover_evidence').insertOne(evidence);
      const submission = await db
        .collection('handover_evidence')
        .findOne({ commandId: evidence.commandId });
      const evidenceReview = {
        ...binding,
        itemId,
        contentVersion: 1,
        dependencyFingerprint: 'b'.repeat(64),
        evidenceId: submission._id,
        reviewerUserId: b,
        decision: 'APPROVED',
        note: 'Review',
        commandId: id(),
        sequence: 1,
        reviewedAt: new Date(),
      };
      await assert.rejects(
        db.collection('handover_evidence_reviews').insertOne(evidenceReview),
        { code: 121 },
      );
      await db
        .collection('handover_evidence_reviews')
        .insertOne({ ...evidenceReview, reviewerUserId: user() });
      await assert.rejects(
        db.collection('handover_evidence').insertOne({
          ...evidence,
          _id: id(),
          commandId: id(),
          links: ['http://example.test'],
        }),
        { code: 121 },
      );
      await assert.rejects(
        db.collection('handover_evidence').insertOne({
          ...evidence,
          _id: id(),
          commandId: id(),
          links: Array(11).fill('https://example.test'),
        }),
        { code: 121 },
      );
      const followUp = {
        schemaVersion: 2,
        ...scope,
        handoverId: handover._id,
        revisionId: revision._id,
        itemId,
        kind: 'KNOWLEDGE_GAP',
        isRequired: false,
        ownerUserId: user(),
        reason: 'Cần bổ sung',
        dueAt: new Date(),
        status: 'OPEN',
        version: 1,
        createdBy: user(),
        resolvedAt: null,
      };
      await db.collection('follow_up_tasks').insertOne(followUp);
      await assert.rejects(
        db
          .collection('follow_up_tasks')
          .updateOne({ itemId }, { $set: { status: 'RESOLVED' } }),
        { code: 121 },
      );
      await db.collection('follow_up_tasks').updateOne(
        { itemId },
        {
          $set: {
            status: 'RESOLVED',
            resolvedAt: new Date(),
            resolvedBy: user(),
            resolutionNote: 'Đã bổ sung',
            version: 2,
          },
        },
      );
      const operation = {
        schemaVersion: 2,
        ...scope,
        actorUserId: b,
        namespace: 'create',
        key: '00000000-0000-4000-8000-000000000001',
        fingerprint: 'a'.repeat(64),
        kind: 'COMMAND',
        state: 'COMMITTED',
        receipt: { resourceId: handover._id, resourceVersion: 1 },
      };
      await db.collection('handover_operations').insertOne(operation);
      await assert.rejects(
        db
          .collection('handover_operations')
          .insertOne({ ...operation, _id: id() }),
        { code: 11000 },
      );
      await assert.rejects(
        db.collection('handover_operations').insertOne({
          ...operation,
          _id: id(),
          key: '00000000-0000-4000-8000-000000000002',
          receipt: { body: 'protected cached body' },
        }),
        { code: 121 },
      );
      assert.ok(
        (await db.collection('handover_operations').indexes()).every(
          (i) => i.expireAfterSeconds === undefined,
        ),
      );
      const job = {
        schemaVersion: 2,
        ...scope,
        handoverId: handover._id,
        initiatedBy: b,
        commandId: id(),
        kind: 'SOURCE_PROPOSAL',
        state: 'PENDING',
        inputDraftVersion: 0,
        sourceFingerprint: 'a'.repeat(64),
        selectedSources: [],
        attempt: 0,
      };
      await assert.rejects(db.collection('handover_jobs').insertOne(job), {
        code: 121,
      });
      await db
        .collection('handover_jobs')
        .insertOne({ ...job, query: 'Các quyết định cần bàn giao' });
      await assert.rejects(
        db.collection('handover_operations').insertOne({
          ...operation,
          _id: id(),
          key: '00000000-0000-4000-8000-000000000003',
          kind: 'TASK_TRANSFER_CHILD',
        }),
        { code: 121 },
      );
      assert.equal((await inspectHandoverV2(db)).blockers.length, 0);

      // Wrong-owner access fails before inspecting another logical database.
      const collisionDb = client.db('handover_v2_wrong_owner');
      await assert.rejects(
        migrateHandoverV2(collisionDb),
        /Expected continuum_handover/,
      );
      // Introduce an orphan through a shape-valid raw write; preflight must detect it.
      await db.collection('handover_acceptances').insertOne({
        ...acknowledgement,
        _id: id(),
        commandId: id(),
        handoverId: id(),
      });
      const blocked = await inspectHandoverV2(db);
      assert.ok(blocked.blockers.some((b) => b.code === 'ORPHAN_REFERENCES'));
      await assert.rejects(
        migrateHandoverV2(db, {
          apply: true,
          writesPaused: true,
          expectedReportSha256: blocked.reportSha256,
        }),
        /blocked by preflight/,
      );
      assert.equal(Object.keys(contract.collections).length, 9);
    } finally {
      await client.close();
      await replSet.stop();
    }
  },
);

test(
  'MongoDB 7: duplicate preflight blocks every DDL operation and leaves existing records untouched',
  { timeout: 120_000 },
  async () => {
    const replSet = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: { count: 1 },
    });
    const client = new mongoose.mongo.MongoClient(replSet.getUri());
    try {
      await client.connect();
      const db = client.db(DATABASE);
      const one = record({ organizationId: id(), projectId: id() });
      await db.collection('handovers').insertMany([
        { ...one, _id: id() },
        { ...one, _id: id() },
      ]);
      const before = await db.collection('handovers').find().toArray();
      const report = await inspectHandoverV2(db);
      assert.ok(
        report.blockers.some((entry) => entry.code === 'DUPLICATE_KEYS'),
      );
      await assert.rejects(
        migrateHandoverV2(db, {
          apply: true,
          writesPaused: true,
          expectedReportSha256: report.reportSha256,
        }),
        /blocked by preflight/,
      );
      assert.deepEqual(
        await db.collection('handovers').find().toArray(),
        before,
      );
      assert.equal((await db.listCollections().toArray()).length, 1);
      assert.equal((await db.collection('handovers').indexes()).length, 1);
      assert.equal(
        (await db.listCollections({ name: 'handovers' }).next()).options
          .validator,
        undefined,
      );
    } finally {
      await client.close();
      await replSet.stop();
    }
  },
);
