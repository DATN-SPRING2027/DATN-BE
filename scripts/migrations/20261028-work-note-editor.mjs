import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import { editorIndexes, reportBackfill } from './work-note-editor.plan.mjs';
export async function migrateWorkNoteEditor(
  client,
  { apply = false, backfill = false, maxRecords = 10000 } = {},
) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 10000)
    throw Error('Invalid scan budget');
  const db = client.db('continuum_capture');
  const candidates = backfill
    ? await db
        .collection('work_reports')
        .find({ contentSchemaVersion: { $exists: false } })
        .limit(maxRecords + 1)
        .toArray()
    : [];
  if (candidates.length > maxRecords) throw Error('Scan budget exceeded');
  const planned = candidates
    .map((row) => ({ row, patch: reportBackfill(row) }))
    .filter((r) => r.patch);
  if (!apply)
    return {
      database: 'continuum_capture',
      inspected: candidates.length,
      wouldBackfill: planned.length,
      emptyObligationsSkipped: candidates.length - planned.length,
      indexes: editorIndexes,
    };
  for (const [name, indexes] of Object.entries(editorIndexes))
    for (const { key, ...options } of indexes)
      await db.collection(name).createIndex(key, options);
  let applied = 0;
  for (const { row: candidate } of planned) {
    const session = client.startSession();
    let changed = false;
    try {
      await session.withTransaction(async () => {
        changed = false;
        const row = await db
          .collection('work_reports')
          .findOne(
            { _id: candidate._id, contentSchemaVersion: { $exists: false } },
            { session },
          );
        if (!row) return;
        const patch = reportBackfill(row);
        if (!patch) return;
        const latest = await db
          .collection('work_report_versions')
          .find({ reportId: row._id }, { session })
          .sort({ versionNumber: -1 })
          .limit(1)
          .next();
        const version = Number(latest?.versionNumber ?? 0) + 1;
        const canonical = {
          id: String(row._id),
          projectId: String(row.projectId),
          memberId: String(row.memberUserId),
          title: patch.title,
          contentMarkdown: patch.contentMarkdown,
          contentSchemaVersion: 2,
          currentVersionNumber: version,
          status: row.status,
          reportScope: row.reportScope ?? 'MEMBER',
          frequency: row.frequency,
          periodStart: new Date(row.periodStart).toISOString(),
          periodEnd: new Date(row.periodEnd).toISOString(),
          dueAt: new Date(row.dueAt).toISOString(),
        };
        await db
          .collection('work_report_versions')
          .insertOne(
            {
              organizationId: row.organizationId,
              projectId: row.projectId,
              reportId: row._id,
              versionNumber: version,
              title: patch.title,
              contentMarkdown: patch.contentMarkdown,
              canonicalResult: canonical,
              editedByUserId: row.memberUserId,
              createdAt: row.updatedAt ?? row.createdAt ?? new Date(),
              provenance: { kind: 'DETERMINISTIC_LEGACY_BACKFILL' },
            },
            { session },
          );
        const result = await db
          .collection('work_reports')
          .updateOne(
            { _id: row._id, contentSchemaVersion: { $exists: false } },
            { $set: { ...patch, currentVersionNumber: version } },
            { session },
          );
        if (result.modifiedCount !== 1)
          throw Error('Concurrent backfill conflict');
        changed = true;
      });
      if (changed) applied++;
    } finally {
      await session.endSession();
    }
  }
  return { database: 'continuum_capture', applied, indexesCreated: true };
}
async function main() {
  const args = process.argv.slice(2);
  if (
    args.some((a) => !['--inspect', '--apply', '--backfill'].includes(a)) ||
    new Set(args).size !== args.length
  )
    throw Error('Invalid arguments');
  if (!args.length) {
    console.log(
      JSON.stringify({
        dryRun: true,
        networkCalls: 0,
        database: 'continuum_capture',
        indexes: editorIndexes,
        backfill:
          'Explicit --backfill only; empty obligations stay legacy until written.',
      }),
    );
    return;
  }
  if (!args.some((a) => a === '--inspect' || a === '--apply'))
    throw Error('Inspect or apply required');
  const uri = process.env.WORKNOTE_MIGRATION_URI;
  if (!uri) throw Error('Explicit migration URI required');
  const parsed = new URL(uri);
  if (
    parsed.protocol !== 'mongodb:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    uri
      .slice(uri.indexOf('://') + 3)
      .split(/[/?#]/, 1)[0]
      .includes(',') ||
    parsed.hash ||
    (parsed.pathname !== '/' &&
      parsed.pathname !== '/continuum_capture' &&
      parsed.pathname !== '')
  )
    throw Error(
      'Local editor migration accepts one loopback Capture target only',
    );
  const client = new mongoose.mongo.MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await client.connect();
    console.log(
      JSON.stringify(
        await migrateWorkNoteEditor(client, {
          apply: args.includes('--apply'),
          backfill: args.includes('--backfill'),
        }),
      ),
    );
  } finally {
    await client.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      'Editor migration failed; no URI or source content is logged.',
    );
    process.exitCode = 1;
  });
