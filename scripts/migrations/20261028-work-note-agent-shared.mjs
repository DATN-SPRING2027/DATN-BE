import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import { migrateWorkNoteAgent } from './20261027-work-note-agent.mjs';
import { sharedTarget } from './work-note-agent.shared-policy.mjs';

/** Prepared operator tool. Never invoked by application startup or local preview. */
export async function runSharedMigration(
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
    throw Error('Unknown or duplicate migration argument');
  if (!args.length)
    return {
      dryRun: true,
      networkCalls: 0,
      database: 'continuum_capture',
      status: 'PREPARED_NOT_EXECUTED',
      instructions:
        'Review DB package and rollout runbook before --inspect or --apply. No populated application .env is read.',
    };
  if (
    Number(args.includes('--inspect')) + Number(args.includes('--apply')) !==
    1
  )
    throw Error('Choose inspect or apply');
  const apply = args.includes('--apply');
  const target = sharedTarget(env, apply);
  const client = await connect(target.uri);
  try {
    const hello = await client.db('admin').command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid')
      throw Error('Transaction-capable replica set or router is required');
    const result = await migrateWorkNoteAgent(client, {
      apply,
      maxRecords: 10000,
      backfill: args.includes('--backfill'),
    });
    return {
      database: target.database,
      targetHost: target.host,
      apply,
      result,
      backupReferenceProvided: apply,
    };
  } finally {
    await client.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runSharedMigration(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        'Shared WorkNote migration failed. No URI, credential or source content is logged. Inspect the reviewed target and runbook.',
      );
      process.exitCode = 1;
    });
