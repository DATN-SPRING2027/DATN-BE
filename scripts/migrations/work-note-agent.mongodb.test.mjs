import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { migrateWorkNoteAgent } from './20261027-work-note-agent.mjs';

test(
  'local replica-set backfill is repeatable, preserves history and creates exact TTL indexes',
  { timeout: 120000 },
  async () => {
    const repl = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: { count: 1 },
    });
    const client = new mongoose.mongo.MongoClient(repl.getUri());
    try {
      await client.connect();
      const db = client.db('continuum_capture');
      const id = new mongoose.Types.ObjectId();
      const actor = new mongoose.Types.ObjectId();
      await db
        .collection('work_notes')
        .insertOne({
          _id: id,
          type: 'TASK_NOTE',
          title: 'Synthetic note',
          authorUserId: actor,
          whatDone: 'A\r\n  B',
          howSolved: 'C',
          whyThisWay: 'D',
        });
      await db
        .collection('work_note_versions')
        .insertOne({
          workNoteId: id,
          versionNumber: 3,
          title: 'Older',
          whatDone: 'old',
          howSolved: 'old',
          whyThisWay: 'old',
        });
      assert.equal((await migrateWorkNoteAgent(client)).wouldBackfill, 1);
      assert.equal(
        (await db.collection('work_notes').findOne({ _id: id }))
          .contentSchemaVersion,
        undefined,
      );
      assert.equal(
        (await migrateWorkNoteAgent(client, { apply: true, backfill: false }))
          .applied,
        0,
      );
      assert.equal(
        (await db.collection('work_notes').findOne({ _id: id }))
          .contentSchemaVersion,
        undefined,
      );
      assert.equal(
        await db
          .collection('work_note_versions')
          .countDocuments({ workNoteId: id }),
        1,
      );
      assert.equal(
        (await migrateWorkNoteAgent(client, { apply: true })).applied,
        1,
      );
      const row = await db.collection('work_notes').findOne({ _id: id });
      assert.equal(row.currentVersionNumber, 4);
      assert.equal(row.whatDone, 'A\r\n  B');
      assert.match(row.contentMarkdown, /A\r\n  B/);
      assert.equal(
        await db
          .collection('work_note_versions')
          .countDocuments({ workNoteId: id }),
        2,
      );
      assert.equal(
        (await migrateWorkNoteAgent(client, { apply: true })).applied,
        0,
      );
      const ttl = await db
        .collection('work_note_agent_drafts')
        .listIndexes()
        .toArray();
      assert.equal(
        ttl.find((x) => x.name === 'agent_drafts_expiry').expireAfterSeconds,
        0,
      );
    } finally {
      await client.close();
      await repl.stop();
    }
  },
);
