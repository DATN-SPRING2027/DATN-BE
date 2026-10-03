import 'dotenv/config';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { targetFingerprint } from './organization-membership-backfill.plan.mjs';
import {
  buildCaptureDraftsTtlReport as buildCaptureDraftsTtlPlan,
  CAPTURE_DRAFTS_COLLECTION,
  CAPTURE_DRAFTS_EXAMPLE_LIMIT,
  CAPTURE_DRAFTS_RETENTION_SECONDS,
  CAPTURE_DRAFTS_TTL_INDEX_KEY,
  CAPTURE_DRAFTS_UNIQUE_INDEX_KEY,
  validateCaptureDraftsDatabaseName,
} from './capture-drafts-ttl.plan.mjs';

const typeCountsPipeline = [
  { $project: { type: { $type: '$lastSavedAt' } } },
  { $group: { _id: '$type', count: { $sum: 1 } } },
  { $sort: { _id: 1 } },
  { $project: { _id: 0, type: '$_id', count: 1 } },
];

async function fingerprintCollectionData(collection) {
  const digest = createHash('sha256');
  const cursor = collection.find({}).sort({ _id: 1 });
  const { EJSON } = mongoose.mongo.BSON;

  for await (const document of cursor) {
    digest.update(EJSON.stringify(document, null, 0, { relaxed: false }));
    digest.update('\n');
  }

  return digest.digest('hex');
}

export async function inspectCaptureDraftsTtl({
  db,
  databaseName,
  fingerprint,
  asOf = new Date(),
}) {
  const collection = db.collection(CAPTURE_DRAFTS_COLLECTION);
  const matchingCollections = await db
    .listCollections({ name: CAPTURE_DRAFTS_COLLECTION }, { nameOnly: false })
    .toArray();
  const collectionExists = matchingCollections.some(
    (item) =>
      item.name === CAPTURE_DRAFTS_COLLECTION && item.type === 'collection',
  );

  if (!collectionExists) {
    return buildCaptureDraftsTtlPlan({
      databaseName,
      targetFingerprint: fingerprint,
      collectionExists: false,
      documentCount: 0,
      lastSavedAtTypeCounts: [],
      malformedExamples: [],
      alreadyExpiredCount: 0,
      alreadyExpiredExamples: [],
      duplicatePairs: [],
      indexes: [],
      dataFingerprint: createHash('sha256').digest('hex'),
      asOf,
    });
  }

  const [documentCount, lastSavedAtTypeCounts, malformedExamples, indexes] =
    await Promise.all([
      collection.countDocuments(),
      collection.aggregate(typeCountsPipeline).toArray(),
      collection
        .aggregate([
          { $project: { _id: 1, lastSavedAtType: { $type: '$lastSavedAt' } } },
          { $match: { lastSavedAtType: { $ne: 'date' } } },
          { $sort: { _id: 1 } },
          { $limit: CAPTURE_DRAFTS_EXAMPLE_LIMIT },
        ])
        .toArray()
        .then((rows) =>
          rows.map((row) => ({
            id: String(row._id),
            lastSavedAtType: row.lastSavedAtType,
          })),
        ),
      collection.listIndexes().toArray(),
    ]);

  const expirationCutoff = new Date(
    asOf.getTime() - CAPTURE_DRAFTS_RETENTION_SECONDS * 1000,
  );
  const [alreadyExpiredCount, alreadyExpiredExamples, duplicatePairs] =
    await Promise.all([
      collection.countDocuments({
        lastSavedAt: { $type: 'date', $lte: expirationCutoff },
      }),
      collection
        .find({ lastSavedAt: { $type: 'date', $lte: expirationCutoff } })
        .project({ _id: 1, lastSavedAt: 1 })
        .sort({ lastSavedAt: 1, _id: 1 })
        .limit(CAPTURE_DRAFTS_EXAMPLE_LIMIT)
        .toArray()
        .then((rows) =>
          rows.map((row) => ({
            id: String(row._id),
            lastSavedAt: row.lastSavedAt.toISOString(),
          })),
        ),
      collection
        .aggregate([
          {
            $group: {
              _id: { userId: '$userId', contextKey: '$contextKey' },
              count: { $sum: 1 },
              documentIds: { $push: { $toString: '$_id' } },
            },
          },
          { $match: { count: { $gt: 1 } } },
          { $sort: { '_id.userId': 1, '_id.contextKey': 1 } },
          {
            $project: {
              _id: 0,
              userId: {
                $convert: {
                  input: '$_id.userId',
                  to: 'string',
                  onError: '[unserializable]',
                  onNull: null,
                },
              },
              contextKey: '$_id.contextKey',
              count: 1,
              ids: { $slice: ['$documentIds', 5] },
            },
          },
          { $limit: CAPTURE_DRAFTS_EXAMPLE_LIMIT },
        ])
        .toArray(),
    ]);
  const dataFingerprint = await fingerprintCollectionData(collection);

  return buildCaptureDraftsTtlPlan({
    databaseName,
    targetFingerprint: fingerprint,
    collectionExists: true,
    documentCount,
    lastSavedAtTypeCounts,
    malformedExamples,
    alreadyExpiredCount,
    alreadyExpiredExamples,
    duplicatePairs,
    indexes,
    dataFingerprint,
    asOf,
  });
}

function hasSameKey(index, key) {
  const indexEntries = Object.entries(index.key ?? {});
  const desiredEntries = Object.entries(key);
  return (
    indexEntries.length === desiredEntries.length &&
    indexEntries.every(
      ([field, direction], position) =>
        desiredEntries[position]?.[0] === field &&
        desiredEntries[position]?.[1] === direction,
    )
  );
}

function isDesiredUniqueIndex(index) {
  return (
    hasSameKey(index, CAPTURE_DRAFTS_UNIQUE_INDEX_KEY) &&
    index.unique === true &&
    index.expireAfterSeconds === undefined &&
    index.sparse !== true &&
    index.partialFilterExpression === undefined &&
    (index.collation === undefined ||
      (index.collation.locale === 'simple' &&
        Object.keys(index.collation).length === 1)) &&
    index.hidden !== true
  );
}

function isDesiredTtlIndex(index) {
  return (
    hasSameKey(index, CAPTURE_DRAFTS_TTL_INDEX_KEY) &&
    index.expireAfterSeconds === CAPTURE_DRAFTS_RETENTION_SECONDS &&
    index.unique !== true &&
    index.sparse !== true &&
    index.partialFilterExpression === undefined &&
    (index.collation === undefined ||
      (index.collation.locale === 'simple' &&
        Object.keys(index.collation).length === 1)) &&
    index.hidden !== true
  );
}

export async function applyCaptureDraftsTtl({
  db,
  report,
  captureDraftWritesPaused = false,
  expiredDraftsReviewed = false,
}) {
  if (!report.clean) {
    throw new Error(
      `Apply refused: report is blocked (${report.problems.join(', ')})`,
    );
  }
  if (!captureDraftWritesPaused) {
    throw new Error('Apply refused: capture draft writes must be paused');
  }
  if (report.counts.alreadyExpired > 0 && !expiredDraftsReviewed) {
    throw new Error(
      'Apply refused: already-expired drafts must be reviewed before enabling TTL',
    );
  }

  const currentReport = await inspectCaptureDraftsTtl({
    db,
    databaseName: report.target.databaseName,
    fingerprint: report.target.targetFingerprint,
    asOf: new Date(report.reportAsOf),
  });
  if (JSON.stringify(currentReport) !== JSON.stringify(report)) {
    throw new Error(
      'Apply refused: collection data or indexes changed since the reviewed report; run a new dry-run',
    );
  }

  const collection = db.collection(CAPTURE_DRAFTS_COLLECTION);
  let indexes = await collection.listIndexes().toArray();
  const hasUniqueIndex = indexes.some(isDesiredUniqueIndex);
  const legacyIndexes = report.indexActions.legacyUserContextIndexesToDrop;

  if (!hasUniqueIndex && legacyIndexes.length > 0) {
    for (const indexName of legacyIndexes) {
      const current = indexes.find((index) => index.name === indexName);
      if (
        !current ||
        !hasSameKey(current, CAPTURE_DRAFTS_UNIQUE_INDEX_KEY) ||
        current.sparse === true ||
        current.partialFilterExpression !== undefined
      ) {
        throw new Error(
          `Apply refused: legacy index ${indexName} changed after dry-run`,
        );
      }
      await collection.dropIndex(indexName);
      indexes = await collection.listIndexes().toArray();
    }
  }

  if (!indexes.some(isDesiredUniqueIndex)) {
    await collection.createIndex(CAPTURE_DRAFTS_UNIQUE_INDEX_KEY, {
      unique: true,
    });
  }

  indexes = await collection.listIndexes().toArray();
  for (const indexName of legacyIndexes) {
    const current = indexes.find((index) => index.name === indexName);
    if (
      current &&
      !isDesiredUniqueIndex(current) &&
      hasSameKey(current, CAPTURE_DRAFTS_UNIQUE_INDEX_KEY)
    ) {
      await collection.dropIndex(indexName);
    }
  }

  indexes = await collection.listIndexes().toArray();
  const desiredTtlExists = indexes.some(isDesiredTtlIndex);
  const ttlIndexToConvert =
    report.indexActions.existingLastSavedAtIndexToConvert;
  if (!desiredTtlExists && ttlIndexToConvert) {
    const current = indexes.find((index) => index.name === ttlIndexToConvert);
    if (!current || !hasSameKey(current, CAPTURE_DRAFTS_TTL_INDEX_KEY)) {
      throw new Error(
        `Apply refused: lastSavedAt index ${ttlIndexToConvert} changed after dry-run`,
      );
    }
    await db.command({
      collMod: CAPTURE_DRAFTS_COLLECTION,
      index: {
        keyPattern: CAPTURE_DRAFTS_TTL_INDEX_KEY,
        expireAfterSeconds: CAPTURE_DRAFTS_RETENTION_SECONDS,
      },
    });
  } else if (!desiredTtlExists) {
    await collection.createIndex(CAPTURE_DRAFTS_TTL_INDEX_KEY, {
      expireAfterSeconds: CAPTURE_DRAFTS_RETENTION_SECONDS,
    });
  }

  indexes = await collection.listIndexes().toArray();
  if (!indexes.some(isDesiredUniqueIndex)) {
    throw new Error(
      'Post-apply verification failed: unique pair index missing',
    );
  }
  if (!indexes.some(isDesiredTtlIndex)) {
    throw new Error('Post-apply verification failed: 30-day TTL index missing');
  }
  if (
    indexes.some(
      (index) =>
        hasSameKey(index, CAPTURE_DRAFTS_UNIQUE_INDEX_KEY) &&
        !isDesiredUniqueIndex(index),
    )
  ) {
    throw new Error(
      'Post-apply verification failed: obsolete userId + contextKey index remains',
    );
  }

  return {
    uniqueIndex: indexes.find(isDesiredUniqueIndex),
    ttlIndex: indexes.find(isDesiredTtlIndex),
    // TTL cleanup is asynchronous. This migration issues no document deletes.
    documentDeletesIssuedByMigration: 0,
  };
}

export async function buildCaptureDraftsTtlReport({
  db,
  databaseName,
  uri,
  asOf,
}) {
  const fingerprint = targetFingerprint(uri, databaseName);
  return inspectCaptureDraftsTtl({
    db,
    databaseName,
    fingerprint,
    asOf,
  });
}

export async function runCaptureDraftsTtlCli({
  argv = process.argv,
  env = process.env,
} = {}) {
  const apply = argv.includes('--apply');
  const uri = env.MONGODB_URI;
  const databaseName = validateCaptureDraftsDatabaseName(
    env.CAPTURE_DRAFTS_TTL_DATABASE,
  );
  if (!uri) throw new Error('MONGODB_URI is required');

  const expectedHash = argv
    .find((value) => value.startsWith('--expected-report-sha256='))
    ?.split('=')[1];
  const reportAsOfValue = argv
    .find((value) => value.startsWith('--report-as-of='))
    ?.slice('--report-as-of='.length);
  const writesPaused = argv.includes('--capture-draft-writes-paused');
  const expiredDraftsReviewed = argv.includes('--expired-drafts-reviewed');

  if (apply && !expectedHash) {
    throw new Error('Apply requires --expected-report-sha256=<reviewed hash>');
  }
  if (apply && !reportAsOfValue) {
    throw new Error('Apply requires --report-as-of=<reviewed reportAsOf>');
  }
  if (apply && !writesPaused) {
    throw new Error('Apply requires --capture-draft-writes-paused');
  }

  const asOf = reportAsOfValue ? new Date(reportAsOfValue) : new Date();
  if (!Number.isFinite(asOf.getTime())) {
    throw new Error('--report-as-of must be a valid ISO date');
  }

  const connection = mongoose.createConnection(uri, {
    dbName: databaseName,
    autoIndex: false,
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await connection.asPromise();
    if (!connection.db) throw new Error('MongoDB database selection failed');
    const report = await buildCaptureDraftsTtlReport({
      db: connection.db,
      databaseName,
      uri,
      asOf,
    });
    const reportSha256 = createHash('sha256')
      .update(JSON.stringify(report))
      .digest('hex');
    process.stdout.write(
      `${JSON.stringify({ ...report, reportSha256 }, null, 2)}\n`,
    );

    if (!apply) {
      if (!report.clean) process.exitCode = 2;
      return;
    }
    if (!report.clean || expectedHash !== reportSha256) {
      throw new Error(
        'Apply refused: report is blocked or differs from the reviewed dry-run',
      );
    }
    if (report.counts.alreadyExpired > 0 && !expiredDraftsReviewed) {
      throw new Error(
        'Apply requires --expired-drafts-reviewed after reviewing already-expired draft counts/examples',
      );
    }

    const applied = await applyCaptureDraftsTtl({
      db: connection.db,
      report,
      captureDraftWritesPaused: writesPaused,
      expiredDraftsReviewed,
    });
    process.stdout.write(
      `Verified unique index ${applied.uniqueIndex.name} and TTL index ${applied.ttlIndex.name}; no document delete command was issued.\n`,
    );
  } finally {
    await connection.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCaptureDraftsTtlCli().catch((error) => {
    const uri = process.env.MONGODB_URI;
    const message = String(error?.message ?? error).replace(
      uri ?? '\0',
      '<redacted MongoDB URI>',
    );
    process.stderr.write(`Capture draft TTL migration failed: ${message}\n`);
    process.exitCode = 1;
  });
}
