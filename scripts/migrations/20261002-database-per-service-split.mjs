import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import {
  COLLECTION_OPTION_ALLOWLIST,
  DATABASE_PER_SERVICE_INVENTORY,
  SPLIT_SOURCE_DATABASE,
  buildDatabasePerServiceSplitReport,
  ownerForCollection,
} from './database-per-service-split.plan.mjs';
import { targetFingerprint } from './organization-membership-backfill.plan.mjs';

const apply = process.argv.includes('--apply');
const sourceWritesPaused = process.argv.includes('--source-writes-paused');
const targetWritesPaused = process.argv.includes('--target-writes-paused');
const backupVerified = process.argv.includes('--backup-verified');
const cutoverAuthorized = process.argv.includes('--cutover-authorized');
const expectedHash = process.argv
  .find((argument) => argument.startsWith('--expected-report-sha256='))
  ?.split('=')[1];
const uri = process.env.MONGODB_URI;
const targetDatabases = Object.keys(DATABASE_PER_SERVICE_INVENTORY).sort();
const { EJSON } = mongoose.mongo.BSON;
const plannerPath = fileURLToPath(
  new URL('./database-per-service-split.plan.mjs', import.meta.url),
);

async function implementationDigest() {
  const [runner, planner] = await Promise.all([
    readFile(fileURLToPath(import.meta.url)),
    readFile(plannerPath),
  ]);
  return createHash('sha256')
    .update(runner)
    .update('\u0000')
    .update(planner)
    .digest('hex');
}

if (!uri) throw new Error('MONGODB_URI is required for the read-only report');
if (apply && !expectedHash) {
  throw new Error('Apply requires --expected-report-sha256=<hash> from a reviewed clean dry-run');
}
if (apply && !sourceWritesPaused) {
  throw new Error('Apply requires --source-writes-paused after stopping every writer to continuum_db');
}
if (apply && !targetWritesPaused) {
  throw new Error('Apply requires --target-writes-paused after stopping every writer to all target databases');
}
if (apply && !backupVerified) {
  throw new Error('Apply requires --backup-verified after a restorable backup has been verified');
}
if (apply && !cutoverAuthorized) {
  throw new Error('Apply requires --cutover-authorized after the environment cutover is separately approved');
}

const fingerprint = targetFingerprint(uri, SPLIT_SOURCE_DATABASE);
const connection = mongoose.createConnection(uri, {
  dbName: SPLIT_SOURCE_DATABASE,
  autoIndex: false,
  serverSelectionTimeoutMS: 5000,
});

function documentDigest(document) {
  return createHash('sha256')
    .update(EJSON.stringify(document, { relaxed: false }))
    .digest('hex');
}

function canonicalize(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    value instanceof Date ||
    Buffer.isBuffer(value) ||
    value._bsontype
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function reportHash(report) {
  return createHash('sha256')
    .update(EJSON.stringify(canonicalize(report), { relaxed: false }))
    .digest('hex');
}

function collectionCreateOptions(sourceOptions = {}) {
  return Object.fromEntries(
    COLLECTION_OPTION_ALLOWLIST
      .filter((key) => sourceOptions[key] !== undefined)
      .map((key) => [key, sourceOptions[key]]),
  );
}

function indexCreateOptions(index) {
  const excluded = new Set(['key', 'ns', 'v', 'name']);
  return Object.fromEntries(
    Object.entries(index).filter(([key]) => !excluded.has(key)),
  );
}

async function readCollection(db, collectionInfo) {
  if (collectionInfo.type !== 'collection') {
    return {
      name: collectionInfo.name,
      type: collectionInfo.type,
      options: collectionInfo.options ?? {},
      indexes: [],
      documents: [],
    };
  }
  const collection = db.collection(collectionInfo.name);
  const [indexes, rawDocuments] = await Promise.all([
    collection.listIndexes().toArray(),
    collection.find({}).sort({ _id: 1 }).toArray(),
  ]);
  const documents = rawDocuments.map((raw) => ({
    _id: raw._id,
    digest: documentDigest(raw),
    raw,
  }));
  return {
    name: collectionInfo.name,
    type: collectionInfo.type,
    options: collectionInfo.options ?? {},
    indexes: indexes.sort((left, right) => left.name.localeCompare(right.name)),
    documents,
  };
}

async function scan() {
  const sourceDb = connection.db;
  if (!sourceDb || sourceDb.databaseName !== SPLIT_SOURCE_DATABASE) {
    throw new Error('Connected source database does not match continuum_db');
  }

  const sourceInfo = await sourceDb.listCollections({}, { nameOnly: false }).toArray();
  const sourceCollections = await Promise.all(
    sourceInfo
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((info) => readCollection(sourceDb, info)),
  );
  const targetCollections = {};
  const mappedSourceNames = new Map();
  for (const source of sourceCollections) {
    const owner = ownerForCollection(source.name);
    if (owner) mappedSourceNames.set(owner, [...(mappedSourceNames.get(owner) ?? []), source.name]);
  }

  for (const databaseName of targetDatabases) {
    const names = mappedSourceNames.get(databaseName) ?? [];
    const targetDb = connection.useDb(databaseName, { useCache: true }).db;
    if (!targetDb) throw new Error(`Target database handle unavailable for ${databaseName}`);
    const collections = [];
    for (const name of names.sort()) {
      const info = (await targetDb.listCollections({ name }, { nameOnly: false }).toArray())[0];
      if (info) collections.push(await readCollection(targetDb, info));
    }
    targetCollections[databaseName] = collections;
  }

  const plan = buildDatabasePerServiceSplitReport({
    sourceCollections,
    targetCollections,
  });
  const report = {
    migrationId: '20261002-database-per-service-split-v1',
    implementationSha256: await implementationDigest(),
    sourceDatabase: SPLIT_SOURCE_DATABASE,
    sourceTargetFingerprint: fingerprint,
    targetDatabases,
    ...plan,
  };
  const sha256 = reportHash(report);
  return { report, sha256, sourceCollections };
}

async function applyPlan(scanned) {
  const sourceDb = connection.db;
  if (!sourceDb) throw new Error('Source database handle unavailable');
  const sourceByName = new Map(scanned.sourceCollections.map((item) => [item.name, item]));

  for (const planned of scanned.report.collections) {
    const source = sourceByName.get(planned.sourceCollection);
    if (!source) throw new Error(`Source collection disappeared: ${planned.sourceCollection}`);
    const targetDb = connection.useDb(planned.targetDatabase, { useCache: true }).db;
    if (!targetDb) throw new Error(`Target database unavailable: ${planned.targetDatabase}`);
    const targetInfo = (await targetDb.listCollections(
      { name: planned.targetCollection },
      { nameOnly: false },
    ).toArray())[0];
    if (!targetInfo) {
      await targetDb.createCollection(
        planned.targetCollection,
        collectionCreateOptions(source.options),
      );
    }

    const target = targetDb.collection(planned.targetCollection);
    const operations = [];
    for (const document of source.documents) {
      operations.push({
        updateOne: {
          filter: { _id: document._id },
          update: { $setOnInsert: document.raw },
          upsert: true,
        },
      });
      if (operations.length === 500) {
        await target.bulkWrite(operations, { ordered: true });
        operations.length = 0;
      }
    }
    if (operations.length) await target.bulkWrite(operations, { ordered: true });

    for (const index of source.indexes) {
      await target.createIndex(index.key, {
        name: index.name,
        ...indexCreateOptions(index),
      });
    }
  }
}

try {
  await connection.asPromise();
  const initial = await scan();
  const display = JSON.parse(EJSON.stringify(initial.report, { relaxed: true }));
  process.stdout.write(`${JSON.stringify({ ...display, reportSha256: initial.sha256 }, null, 2)}\n`);

  if (!apply) {
    if (!initial.report.clean) process.exitCode = 2;
  } else {
    if (!initial.report.clean || expectedHash !== initial.sha256) {
      throw new Error('Apply refused: report is not clean or SHA-256 differs from the reviewed dry-run');
    }
    const fresh = await scan();
    if (fresh.sha256 !== expectedHash) {
      throw new Error('Apply refused: source or destination changed since the reviewed dry-run');
    }
    await applyPlan(fresh);
    const verified = await scan();
    const remainingInserts = verified.report.counts.documentsToInsert;
    const missingIndexes = verified.report.indexDifferences.filter(
      (difference) => difference.status === 'MISSING_TARGET_INDEX',
    );
    if (
      !verified.report.clean ||
      remainingInserts !== 0 ||
      verified.report.counts.conflictingDocuments !== 0 ||
      missingIndexes.length !== 0
    ) {
      throw new Error('Post-copy verification failed; source remains intact. Review a new dry-run before retrying.');
    }
    process.stdout.write(
      `Verified copy to ${targetDatabases.length} database targets; source collections remain unchanged.\n`,
    );
  }
} finally {
  await connection.close();
}
