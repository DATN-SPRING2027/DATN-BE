import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  migrateWorkNoteFeedbackTtl,
  runFeedbackTtlMigration,
  feedbackReadiness,
  DATABASE,
  COLLECTION,
  TTL_INDEX_NAME,
  COMPOUND_INDEX_NAME,
  TTL_SECONDS,
} from './20261103-work-note-feedback-ttl.mjs';

test('default feedback TTL migration rejects non-loopback and production environments', async () => {
  let calls = 0;
  const connect = async () => {
    calls++;
    throw Error('network forbidden');
  };

  // Dry run with no arguments
  const zeroArg = await runFeedbackTtlMigration([], {}, connect);
  assert.equal(zeroArg.networkCalls, 0);
  assert.equal(zeroArg.dryRun, true);

  // Reject non-loopback URI
  await assert.rejects(
    runFeedbackTtlMigration(
      ['--apply'],
      { WORKNOTE_MIGRATION_URI: 'mongodb://remote-host:27017/continuum_capture' },
      connect,
    ),
    /loopback/i,
  );

  // Reject production
  await assert.rejects(
    runFeedbackTtlMigration(
      ['--apply'],
      {
        WORKNOTE_MIGRATION_URI: 'mongodb://127.0.0.1:27017/continuum_capture',
        NODE_ENV: 'production',
      },
      connect,
    ),
    /non-production/i,
  );

  // Reject missing URI
  await assert.rejects(
    runFeedbackTtlMigration(['--apply'], {}, connect),
    /Explicit WORKNOTE_MIGRATION_URI required/,
  );

  assert.equal(calls, 0);
});

test(
  'feedback TTL migration creates 180d TTL index and compound index idempotently',
  { timeout: 120000 },
  async () => {
    const repl = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: { count: 1 },
    });
    const client = new mongoose.mongo.MongoClient(repl.getUri());

    try {
      await client.connect();
      const db = client.db(DATABASE);

      // 1. Initial inspect on empty db: indexes not ready
      const initialInspect = await migrateWorkNoteFeedbackTtl(client, { apply: false });
      assert.equal(initialInspect.before.ttlReady, false);
      assert.equal(initialInspect.before.compoundReady, false);
      assert.equal(initialInspect.ttlCreated, false);

      // 2. Apply migration: creates collection and both indexes
      const applyResult = await migrateWorkNoteFeedbackTtl(client, { apply: true });
      assert.equal(applyResult.ttlCreated, true);
      assert.equal(applyResult.compoundCreated, true);
      assert.equal(applyResult.after.ttlReady, true);
      assert.equal(applyResult.after.compoundReady, true);
      assert.equal(applyResult.after.allReady, true);

      // Verify indexes in MongoDB directly
      const indexes = await db.collection(COLLECTION).indexes();
      const ttlIdx = indexes.find((i) => i.name === TTL_INDEX_NAME);
      assert.ok(ttlIdx, 'TTL index must exist');
      assert.equal(ttlIdx.expireAfterSeconds, TTL_SECONDS);
      assert.deepEqual(ttlIdx.key, { recordedAt: 1 });

      const compoundIdx = indexes.find((i) => i.name === COMPOUND_INDEX_NAME);
      assert.ok(compoundIdx, 'Compound index must exist');
      assert.deepEqual(compoundIdx.key, {
        promptVersion: 1,
        purpose: 1,
        category: 1,
        recordedAt: -1,
      });

      // 3. Second apply: idempotent, no redundant creations
      const secondApply = await migrateWorkNoteFeedbackTtl(client, { apply: true });
      assert.equal(secondApply.ttlCreated, false);
      assert.equal(secondApply.compoundCreated, false);
      assert.equal(secondApply.before.allReady, true);
      assert.equal(secondApply.after.allReady, true);

      // 4. Inspect again: reports ready
      const finalInspect = await migrateWorkNoteFeedbackTtl(client, { apply: false });
      assert.equal(finalInspect.before.allReady, true);
    } finally {
      await client.close();
      await repl.stop();
    }
  },
);

