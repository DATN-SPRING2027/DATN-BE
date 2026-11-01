import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { migrateWorkNoteEditor } from './20261028-work-note-editor.mjs';
test('creates workflow indexes separately from repeatable Report backfill and preserves legacy values', async () => {
  const repl = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: { count: 1 },
    }),
    client = new mongoose.mongo.MongoClient(repl.getUri());
  try {
    await client.connect();
    const db = client.db('continuum_capture'),
      id = new mongoose.Types.ObjectId(),
      scope = {
        organizationId: new mongoose.Types.ObjectId(),
        projectId: new mongoose.Types.ObjectId(),
        memberUserId: new mongoose.Types.ObjectId(),
      },
      date = new Date('2026-10-26');
    await db.collection('work_reports').insertMany([
      {
        _id: id,
        ...scope,
        periodStart: date,
        periodEnd: date,
        dueAt: date,
        status: 'DRAFT',
        frequency: 'WEEKLY',
        accomplishments: 'Chưa test.\r\n  log',
        approach: 'Đọc log',
        reason: 'Chưa rõ',
      },
      { ...scope, periodStart: date },
    ]);
    await migrateWorkNoteEditor(client, { apply: true });
    assert.equal(
      (await db.collection('work_reports').findOne({ _id: id }))
        .contentSchemaVersion,
      undefined,
    );
    assert.equal(
      (await migrateWorkNoteEditor(client, { apply: true, backfill: true }))
        .applied,
      1,
    );
    assert.equal(
      (await migrateWorkNoteEditor(client, { apply: true, backfill: true }))
        .applied,
      0,
    );
    const saved = await db.collection('work_reports').findOne({ _id: id });
    assert.equal(saved.accomplishments, 'Chưa test.\r\n  log');
    assert.match(saved.contentMarkdown, /Chưa test/);
    assert.equal(
      await db.collection('work_report_versions').countDocuments(),
      1,
    );
  } finally {
    await client.close();
    await repl.stop();
  }
});
