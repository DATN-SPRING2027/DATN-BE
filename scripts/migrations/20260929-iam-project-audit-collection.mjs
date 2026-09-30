import 'dotenv/config';
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { resolveIamDatabaseName, targetFingerprint } from './organization-membership-backfill.plan.mjs';
import { planIamProjectAuditCollection } from './iam-project-audit-collection.plan.mjs';

const apply = process.argv.includes('--apply');
const expectedHash = process.argv.find((value) => value.startsWith('--expected-report-sha256='))?.split('=')[1];
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
if (apply && !expectedHash) throw new Error('Apply requires a reviewed dry-run report SHA-256');

const databaseName = resolveIamDatabaseName({
  mongodbEnabled: process.env.MONGODB_ENABLED,
  infraEnabled: process.env.INFRA_ENABLED,
  configuredName: process.env.MONGODB_DATABASE,
});
const fingerprint = targetFingerprint(process.env.MONGODB_URI, databaseName);
const connection = mongoose.createConnection(process.env.MONGODB_URI, {
  dbName: databaseName, autoIndex: false, serverSelectionTimeoutMS: 5000,
});

async function inspect(db) {
  const objects = await db.listCollections({ name: 'audit_logs_iam' }).toArray();
  const objectType = objects.length === 0 ? null : objects[0].type;
  const collectionExists = objectType !== null;
  const documentCount = objectType === 'collection'
    ? await db.collection('audit_logs_iam').countDocuments() : 0;
  return planIamProjectAuditCollection({
    databaseName: db.databaseName,
    targetFingerprint: fingerprint,
    collectionExists,
    objectType,
    documentCount,
  });
}

try {
  await connection.asPromise();
  const db = connection.db;
  const plan = await inspect(db);
  const reportSha256 = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  process.stdout.write(`${JSON.stringify({ ...plan, reportSha256 }, null, 2)}\n`);
  if (!plan.clean) process.exitCode = 2;
  if (apply) {
    if (!plan.clean || expectedHash !== reportSha256)
      throw new Error('Apply refused: report does not match reviewed dry-run');
    if (plan.action === 'CREATE_COLLECTION') await db.createCollection(plan.collectionName);
    const after = await inspect(db);
    if (!after.collectionExists || after.documentCount < plan.documentCount)
      throw new Error('IAM audit collection verification failed');
    process.stdout.write(`Verified ${plan.collectionName}; documents before=${plan.documentCount}, after=${after.documentCount}; action=${plan.action}.\n`);
  }
} finally {
  await connection.close();
}
