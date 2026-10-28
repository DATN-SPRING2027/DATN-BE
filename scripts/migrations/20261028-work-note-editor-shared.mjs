import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import { sharedTarget } from './work-note-agent.shared-policy.mjs';
import { migrateWorkNoteEditor } from './20261028-work-note-editor.mjs';

/** Explicit operator entrypoint; never loaded by application startup. */
export async function runSharedEditorMigration(
  args,
  env = process.env,
  connect = async (uri) => {
    const client = new mongoose.mongo.MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      tls: true,
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  },
) {
  if (
    args.some((a) => !['--inspect', '--apply', '--backfill'].includes(a)) ||
    new Set(args).size !== args.length
  )
    throw Error('Unknown or duplicate argument');
  if (!args.length)
    return {
      dryRun: true,
      networkCalls: 0,
      database: 'continuum_capture',
      status: 'PREPARED_NOT_EXECUTED',
      backfill: 'Explicit --backfill only',
    };
  if (
    Number(args.includes('--inspect')) + Number(args.includes('--apply')) !==
    1
  )
    throw Error('Choose inspect or apply');
  const apply = args.includes('--apply'),
    target = sharedTarget(env, apply);
  const client = await connect(target.uri);
  try {
    const hello = await client.db('admin').command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid')
      throw Error('Transaction-capable target required');
    const result = await migrateWorkNoteEditor(client, {
      apply,
      backfill: args.includes('--backfill'),
      maxRecords: 10000,
    });
    return {
      targetHost: target.host,
      database: target.database,
      apply,
      result,
      backupReferenceProvided: apply,
    };
  } finally {
    await client.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runSharedEditorMigration(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        'Shared editor migration failed. No URI, credentials or source content are logged.',
      );
      process.exitCode = 1;
    });
