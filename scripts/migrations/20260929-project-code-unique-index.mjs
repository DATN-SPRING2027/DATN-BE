import 'dotenv/config';
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { resolveIamDatabaseName, targetFingerprint } from './organization-membership-backfill.plan.mjs';
import { inspectProjectCodeIndex } from './project-code-index.inspect.mjs';

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
  dbName: databaseName,
  autoIndex: false,
  serverSelectionTimeoutMS: 5000,
});

try {
  await connection.asPromise();
  const db = connection.db;
  const collection = db.collection('projects');
  const plan = await inspectProjectCodeIndex({ db, targetFingerprint: fingerprint });
  const reportSha256 = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  process.stdout.write(`${JSON.stringify({ ...plan, reportSha256 }, null, 2)}\n`);
  if (!apply) {
    if (!plan.clean) process.exitCode = 2;
  } else {
    if (!plan.clean || expectedHash !== reportSha256)
      throw new Error('Apply refused: report is not clean or does not match reviewed dry-run');
    if (plan.action === 'CREATE_UNIQUE_INDEX')
      await collection.createIndex(plan.desiredIndex.key, {
        unique: true, name: plan.desiredIndex.name, collation: { locale: 'simple' },
      });
    const afterIndexes = await collection.indexes();
    if (!afterIndexes.some((item) => item.unique === true &&
      item.sparse !== true && item.partialFilterExpression === undefined &&
      (item.collation === undefined ||
        (item.collation?.locale === 'simple' && Object.keys(item.collation).length === 1)) &&
      item.expireAfterSeconds === undefined &&
      JSON.stringify(item.key) === JSON.stringify(plan.desiredIndex.key)))
      throw new Error('Project code unique index verification failed');
    const afterCount = await collection.countDocuments();
    if (afterCount < plan.projectCount) throw new Error('Project document count fell during index migration');
    process.stdout.write(`Verified ${plan.desiredIndex.name}; project documents before=${plan.projectCount}, after=${afterCount}; action=${plan.action}.\n`);
  }
} finally {
  await connection.close();
}
