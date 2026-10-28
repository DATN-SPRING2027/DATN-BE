import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  migrateWorkNoteAssessment,
  runAssessmentMigration,
} from './20261029-work-note-assessment.mjs';

test('default assessment migration has no network access and rejects implicit/shared targets', async () => {
  let calls = 0;
  const connect = async () => {
    calls++;
    throw Error('network forbidden');
  };
  assert.equal((await runAssessmentMigration([], {}, connect)).networkCalls, 0);
  await assert.rejects(runAssessmentMigration(['--apply'], {}, connect));
  await assert.rejects(
    runAssessmentMigration(
      ['--inspect'],
      {
        WORKNOTE_MIGRATION_URI:
          'mongodb+srv://example.invalid/continuum_capture',
      },
      connect,
    ),
  );
  await assert.rejects(
    runAssessmentMigration(
      ['--apply'],
      {
        WORKNOTE_MIGRATION_URI: 'mongodb://127.0.0.1/continuum_capture',
        NODE_ENV: 'production',
      },
      connect,
    ),
  );
  assert.equal(calls, 0);
});

test(
  'assessment retention migration is bounded, dry-run first and idempotent without canonical edits',
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
      const createdAt = new Date('2030-01-01T00:00:00.000Z');
      const cap = new Date('2030-01-02T00:00:00.000Z');
      const extended = new Date('2030-01-03T00:00:00.000Z');
      const draft = {
        _id: 'synthetic-draft',
        createdAt,
        expiresAt: extended,
        state: {
          contentMarkdown: 'Private draft',
          assessment: {
            schemaVersion: 'task-note-assessment/v1',
            createdAt: createdAt.toISOString(),
            expiresAt: extended.toISOString(),
            answers: [],
          },
        },
      };
      await db.collection('work_note_agent_drafts').insertOne(draft);
      const legacy = {
        _id: 'legacy-draft',
        createdAt,
        expiresAt: cap,
        state: { contentMarkdown: 'Legacy private text' },
      };
      await db.collection('work_note_agent_drafts').insertOne(legacy);
      await db.collection('work_note_agent_operations').insertMany([
        {
          _id: 'legacy-associated',
          draftId: draft._id,
          expiresAt: extended,
          result: { privateDraft: true },
        },
        {
          _id: 'legacy-orphan',
          draftId: 'gone',
          expiresAt: extended,
          result: { closed: true },
        },
      ]);
      const canonical = {
        _id: 'canonical',
        title: 'Preserve',
        contentMarkdown: 'Canonical body',
        currentVersionNumber: 3,
      };
      await db.collection('work_notes').insertOne(canonical);
      const beforeCanonical = await db
        .collection('work_notes')
        .findOne({ _id: canonical._id });
      await assert.rejects(
        migrateWorkNoteAssessment(client, { apply: true, maxRecords: 1 }),
        /budget/,
      );
      assert.equal(
        (
          await db
            .collection('work_note_agent_drafts')
            .findOne({ _id: draft._id })
        ).expiresAt.getTime(),
        extended.getTime(),
      );
      const dry = await migrateWorkNoteAssessment(client);
      assert.equal(dry.wouldClampDrafts, 1);
      assert.equal(dry.wouldClampOperations, 2);
      assert.equal(dry.legacyOrphanOperations, 1);
      assert.equal(dry.applied, 0);
      const applied = await migrateWorkNoteAssessment(client, { apply: true });
      assert.equal(applied.applied, 3);
      const saved = await db
        .collection('work_note_agent_drafts')
        .findOne({ _id: draft._id });
      assert.equal(saved.expiresAt.getTime(), cap.getTime());
      assert.equal(saved.state.assessment.expiresAt, cap.toISOString());
      assert.equal(saved.state.contentMarkdown, 'Private draft');
      assert.deepEqual(
        await db
          .collection('work_note_agent_drafts')
          .findOne({ _id: legacy._id }),
        legacy,
      );
      const associated = await db
        .collection('work_note_agent_operations')
        .findOne({ _id: 'legacy-associated' });
      assert.equal(associated.expiresAt.getTime(), cap.getTime());
      const orphan = await db
        .collection('work_note_agent_operations')
        .findOne({ _id: 'legacy-orphan' });
      assert.ok(orphan.expiresAt.getTime() <= Date.now());
      assert.equal(
        (await migrateWorkNoteAssessment(client, { apply: true })).applied,
        0,
      );
      const ttl = await db.collection('work_note_agent_drafts').indexes();
      assert.equal(
        ttl.find((i) => i.name === 'agent_drafts_expiry').expireAfterSeconds,
        0,
      );
      assert.deepEqual(
        await db.collection('work_notes').findOne({ _id: canonical._id }),
        beforeCanonical,
      );
    } finally {
      await client.close();
      await repl.stop();
    }
  },
);

test(
  'invalid legacy timestamps fail before any writes rather than inventing creation dates',
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
      await db.collection('work_note_agent_drafts').insertOne({
        _id: 'bad',
        expiresAt: new Date('2030-01-03T00:00:00.000Z'),
        state: {},
      });
      await assert.rejects(
        migrateWorkNoteAssessment(client, { apply: true }),
        /creation/,
      );
      assert.equal(
        (await db.collection('work_note_agent_drafts').indexes()).length,
        1,
      );
      await db.collection('work_note_agent_drafts').deleteOne({ _id: 'bad' });
      await db
        .collection('work_note_agent_drafts')
        .createIndex(
          { expiresAt: 1 },
          { name: 'agent_drafts_expiry', expireAfterSeconds: 3600 },
        );
      await assert.rejects(
        migrateWorkNoteAssessment(client, { apply: true }),
        /Conflicting expiry index/,
      );
      assert.equal(
        (await db.collection('work_note_agent_drafts').indexes()).find(
          (i) => i.name === 'agent_drafts_expiry',
        ).expireAfterSeconds,
        3600,
      );
    } finally {
      await client.close();
      await repl.stop();
    }
  },
);
