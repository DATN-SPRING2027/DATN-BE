import 'dotenv/config';
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import {
  resolveIamDatabaseName,
  targetFingerprint,
} from './organization-membership-backfill.plan.mjs';
import {
  PLATFORM_OPERATOR_V1_EXPANSION_INDEX,
  planPlatformOperatorV1ExpansionIndex,
} from './platform-operator-v1-expansion-index.plan.mjs';

const apply = process.argv.includes('--apply');
const expectedHash = process.argv
  .find((value) => value.startsWith('--expected-report-sha256='))
  ?.split('=')[1];
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
if (apply && !expectedHash)
  throw new Error('Apply requires a reviewed dry-run report SHA-256');

const databaseName = resolveIamDatabaseName({
  mongodbEnabled: process.env.MONGODB_ENABLED,
  infraEnabled: process.env.INFRA_ENABLED,
  configuredName: process.env.MONGODB_DATABASE,
});
const fingerprint = targetFingerprint(process.env.MONGODB_URI, databaseName);
const connection = mongoose.createConnection(process.env.MONGODB_URI, {
  dbName: databaseName,
  autoIndex: false,
  serverSelectionTimeoutMS: 5000,
});

async function inspect(db) {
  const name = 'platform_authority_assignments';
  const objects = await db.listCollections({ name }).toArray();
  const objectType = objects.length === 0 ? null : objects[0].type;
  const collectionExists = objectType !== null;
  const collection = db.collection(name);
  const documentCount =
    objectType === 'collection' ? await collection.countDocuments() : 0;
  const indexes =
    objectType === 'collection'
      ? await collection.indexes().catch((error) => {
          if (error?.codeName === 'NamespaceNotFound') return [];
          throw error;
        })
      : [];
  return planPlatformOperatorV1ExpansionIndex({
    databaseName: db.databaseName,
    targetFingerprint: fingerprint,
    collectionExists,
    objectType,
    documentCount,
    indexes,
  });
}

try {
  await connection.asPromise();
  const db = connection.db;
  if (!db || db.databaseName !== databaseName)
    throw new Error('Connected IAM database does not match the configured target');

  const report = await inspect(db);
  const reportSha256 = createHash('sha256')
    .update(JSON.stringify(report))
    .digest('hex');
  process.stdout.write(`${JSON.stringify({ ...report, reportSha256 }, null, 2)}\n`);
  if (!report.clean) process.exitCode = 2;

  if (apply) {
    if (!report.clean || expectedHash !== reportSha256)
      throw new Error('Apply refused: report does not match reviewed dry-run');
    const collection = db.collection(report.collectionName);
    if (!report.collectionExists) await db.createCollection(report.collectionName);
    if (report.desiredIndex.action === 'CREATE')
      await collection.createIndex(PLATFORM_OPERATOR_V1_EXPANSION_INDEX.key, {
        name: PLATFORM_OPERATOR_V1_EXPANSION_INDEX.name,
        unique: false,
      });

    const after = await inspect(db);
    if (
      !after.clean ||
      after.desiredIndex.action !== 'NOOP' ||
      after.documentCount !== report.documentCount
    )
      throw new Error('Platform Operator V1 index verification failed');
    process.stdout.write(
      `Verified additive provenance index; assignment documents before=${report.documentCount}, after=${after.documentCount}.\n`,
    );
  }
} finally {
  await connection.close();
}
