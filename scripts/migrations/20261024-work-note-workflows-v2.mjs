import 'dotenv/config';
import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import {
  buildWorkNoteWorkflowIndexPlan,
  validateWorkNoteDatabaseName,
  WORK_NOTE_WORKFLOW_INDEXES,
} from './work-note-workflows.plan.mjs';

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

function optionsMatch(existing, planned) {
  const comparable = [
    'unique',
    'sparse',
    'expireAfterSeconds',
    'partialFilterExpression',
    'collation',
    'wildcardProjection',
    'hidden',
  ];
  return comparable.every(
    (name) =>
      JSON.stringify(existing[name] ?? null) ===
      JSON.stringify(planned[name] ?? null),
  );
}

export async function applyWorkNoteWorkflowIndexesV2(db) {
  validateWorkNoteDatabaseName(db.databaseName);
  const results = [];
  const pending = [];
  for (const [collectionName, indexes] of Object.entries(
    WORK_NOTE_WORKFLOW_INDEXES,
  )) {
    const collection = db.collection(collectionName);
    const exists = await db
      .listCollections({ name: collectionName }, { nameOnly: true })
      .hasNext();
    const existing = exists ? await collection.listIndexes().toArray() : [];
    for (const index of indexes) {
      const sameName = existing.find((item) => item.name === index.name);
      const sameKey = existing.find(
        (item) => JSON.stringify(item.key) === JSON.stringify(index.key),
      );
      if (
        sameName &&
        JSON.stringify(sameName.key) !== JSON.stringify(index.key)
      )
        throw new Error(
          `Index name conflict in ${collectionName}.${index.name}`,
        );
      if (sameKey) {
        if (!optionsMatch(sameKey, index))
          throw new Error(
            `Index options conflict in ${collectionName}.${index.name}`,
          );
        results.push({
          collection: collectionName,
          name: sameKey.name,
          action: 'skipped',
        });
        continue;
      }
      pending.push({ collectionName, collection, index, exists });
      existing.push({
        key: index.key,
        name: index.name,
        ...(index.unique ? { unique: true } : {}),
      });
    }
  }
  for (const { collectionName, collection, index, exists } of pending) {
    if (!index.unique || !exists) continue;
    const groupKey = Object.fromEntries(
      Object.keys(index.key).map((field) => [field, `$${field}`]),
    );
    const duplicate = await collection
      .aggregate([
        { $group: { _id: groupKey, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $limit: 1 },
      ])
      .toArray();
    if (duplicate.length > 0)
      throw new Error(`Duplicate keys in ${collectionName}.${index.name}`);
  }
  for (const { collectionName, collection, index } of pending) {
    const name = await collection.createIndex(index.key, {
      name: index.name,
      ...(index.unique ? { unique: true } : {}),
    });
    results.push({ collection: collectionName, name, action: 'created' });
  }
  return results;
}

async function run() {
  const databaseName = process.env.SERVICE_DATABASE ?? 'continuum_capture';
  const plan = buildWorkNoteWorkflowIndexPlan(databaseName);
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--apply', '--allow-shared-database'].includes(arg)))
    throw new Error('Unknown migration argument');
  if (!args.includes('--apply')) {
    process.stdout.write(
      `${JSON.stringify({ dryRun: true, plan }, null, 2)}\n`,
    );
    return;
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required when applying indexes');
  const parsed = new URL(uri);
  const authority = uri.slice(uri.indexOf('://') + 3).split(/[/?#]/, 1)[0];
  if (
    !['mongodb:', 'mongodb+srv:'].includes(parsed.protocol) ||
    authority.includes(',') ||
    !parsed.hostname
  )
    throw new Error('One MongoDB host is required');
  if (!loopbackHosts.has(parsed.hostname.toLowerCase())) {
    if (
      !args.includes('--allow-shared-database') ||
      process.env.WORK_NOTE_MIGRATION_CONFIRM_DATABASE !== databaseName
    )
      throw new Error(
        'A non-loopback target requires explicit database confirmation',
      );
  }
  const client = new mongoose.mongo.MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await client.connect();
    const results = await applyWorkNoteWorkflowIndexesV2(
      client.db(databaseName),
    );
    process.stdout.write(
      `${JSON.stringify({ databaseName, results }, null, 2)}\n`,
    );
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
