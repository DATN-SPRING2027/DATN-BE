import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import {
  indexes,
  buildBackfill,
  validateDatabaseName,
} from './work-note-agent.plan.mjs';

/** Local-only migration package. No dotenv loading, implicit default URI or shared target. */
export async function migrateWorkNoteAgent(
  client,
  { apply = false, maxRecords = 10000, backfill = true } = {},
) {
  if (
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 1 ||
    maxRecords > 100000
  )
    throw new Error('Invalid scan budget');
  const db = client.db('continuum_capture');
  validateDatabaseName(db.databaseName);
  const notes = backfill
    ? await db
        .collection('work_notes')
        .find({ type: 'TASK_NOTE', contentSchemaVersion: { $exists: false } })
        .limit(maxRecords + 1)
        .toArray()
    : [];
  if (notes.length > maxRecords)
    throw new Error('Scan budget exceeded; no migration writes were made');
  // Validate every candidate before any write. Do not log source bodies or IDs.
  for (const row of notes) buildBackfill(row);
  if (!apply)
    return {
      inspected: notes.length,
      wouldBackfill: notes.length,
      applied: 0,
      indexes,
    };
  for (const [collection, definitions] of Object.entries(indexes)) {
    for (const { key, ...options } of definitions)
      await db.collection(collection).createIndex(key, options);
  }
  await db
    .collection('work_note_versions')
    .createIndex({ workNoteId: 1, versionNumber: 1 }, { unique: true });
  let applied = 0;
  for (const candidate of notes) {
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const row = await db
          .collection('work_notes')
          .findOne(
            { _id: candidate._id, contentSchemaVersion: { $exists: false } },
            { session },
          );
        if (!row) return;
        const latest = await db
          .collection('work_note_versions')
          .find({ workNoteId: row._id }, { session })
          .sort({ versionNumber: -1 })
          .limit(1)
          .next();
        const patch = buildBackfill({
          ...row,
          currentVersionNumber:
            row.currentVersionNumber ?? (latest?.versionNumber ?? 0) + 1,
        });
        if (!patch) return;
        const existing = await db
          .collection('work_note_versions')
          .findOne(
            { workNoteId: row._id, versionNumber: patch.currentVersionNumber },
            { session },
          );
        if (existing)
          throw new Error(
            'Current snapshot version conflict; manual review required',
          );
        await db
          .collection('work_note_versions')
          .insertOne(
            {
              workNoteId: row._id,
              versionNumber: patch.currentVersionNumber,
              title: row.title,
              contentMarkdown: patch.contentMarkdown,
              contentSchemaVersion: 2,
              editedByUserId: row.authorUserId,
              provenance: { kind: 'DETERMINISTIC_LEGACY_BACKFILL' },
              createdAt: row.updatedAt ?? row.createdAt ?? new Date(),
            },
            { session },
          );
        const result = await db
          .collection('work_notes')
          .updateOne(
            { _id: row._id, contentSchemaVersion: { $exists: false } },
            { $set: patch },
            { session },
          );
        if (result.modifiedCount !== 1)
          throw new Error('Concurrent migration conflict');
      });
      applied++;
    } finally {
      await session.endSession();
    }
  }
  return { inspected: notes.length, applied };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => !['--apply', '--inspect'].includes(a)))
    throw new Error('Unknown argument');
  if (!args.length) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          networkCalls: 0,
          database: 'continuum_capture',
          indexes,
          backfill:
            'Deterministic legacy concatenation; inventory requires explicit --inspect and loopback URI.',
        },
        null,
        2,
      ),
    );
    return;
  }
  const uri = process.env.WORKNOTE_MIGRATION_URI;
  if (!uri) throw new Error('Explicit WORKNOTE_MIGRATION_URI is required');
  const parsed = new URL(uri);
  const authority = uri.slice(uri.indexOf('://') + 3).split(/[/?#]/, 1)[0];
  if (
    parsed.protocol !== 'mongodb:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    authority.includes(',')
  )
    throw new Error(
      'This local migration package accepts one loopback MongoDB host only',
    );
  if (
    parsed.pathname &&
    parsed.pathname !== '/' &&
    parsed.pathname !== '/continuum_capture'
  )
    throw new Error('URI database must be continuum_capture');
  const client = new mongoose.mongo.MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await client.connect();
    console.log(
      JSON.stringify(
        await migrateWorkNoteAgent(client, { apply: args.includes('--apply') }),
      ),
    );
  } finally {
    await client.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      'WorkNote migration failed. Inspect the local target and migration contract; no source text is logged.',
    );
    process.exitCode = 1;
  });
