import 'dotenv/config';
import mongoose from 'mongoose';
import {
  buildWorkNoteWorkflowIndexPlan,
  validateWorkNoteDatabaseName,
  WORK_NOTE_WORKFLOW_INDEXES,
} from './work-note-workflows.plan.mjs';

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const duplicateKeys = {
  project_document_versions: { documentId: 1, versionNumber: 1 },
  work_reports: { projectId: 1, memberUserId: 1, periodStart: 1 },
  work_report_settings: { projectId: 1, effectiveAt: 1 },
};

export async function applyWorkNoteWorkflowIndexes(db) {
  validateWorkNoteDatabaseName(db.databaseName);

  for (const [collectionName, key] of Object.entries(duplicateKeys)) {
    const duplicates = await db
      .collection(collectionName)
      .aggregate([
        { $group: { _id: key, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $limit: 5 },
      ])
      .toArray();
    if (duplicates.length > 0) {
      throw new Error(
        `Index migration refused: duplicate keys exist in ${collectionName}`,
      );
    }
  }

  const created = [];
  for (const [collectionName, indexes] of Object.entries(
    WORK_NOTE_WORKFLOW_INDEXES,
  )) {
    for (const index of indexes) {
      const name = await db.collection(collectionName).createIndex(index.key, {
        name: index.name,
        ...(index.unique ? { unique: true } : {}),
      });
      created.push({ collection: collectionName, name });
    }
  }
  return created;
}

function parseArguments(args) {
  return {
    apply: args.includes('--apply'),
    allowShared: args.includes('--allow-shared-database'),
  };
}

async function run() {
  const databaseName =
    process.env.SERVICE_DATABASE ?? 'continuum_capture';
  const plan = buildWorkNoteWorkflowIndexPlan(databaseName);
  const options = parseArguments(process.argv.slice(2));

  if (!options.apply) {
    process.stdout.write(`${JSON.stringify({ dryRun: true, plan }, null, 2)}\n`);
    return;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required when applying indexes');
  const parsedUri = new URL(uri);
  const isLoopback = loopbackHosts.has(parsedUri.hostname.toLowerCase());
  if (!isLoopback) {
    if (!options.allowShared) {
      throw new Error(
        'Refusing a non-loopback MongoDB host without --allow-shared-database',
      );
    }
    if (process.env.WORK_NOTE_MIGRATION_CONFIRM_DATABASE !== databaseName) {
      throw new Error(
        'Set WORK_NOTE_MIGRATION_CONFIRM_DATABASE to the exact target database before applying to a non-loopback host',
      );
    }
  }

  const client = new mongoose.mongo.MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await client.connect();
    const created = await applyWorkNoteWorkflowIndexes(client.db(databaseName));
    process.stdout.write(
      `${JSON.stringify({ databaseName, created }, null, 2)}\n`,
    );
  } finally {
    await client.close();
  }
}

if (process.argv[1]?.endsWith('20261024-work-note-workflows.mjs')) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
