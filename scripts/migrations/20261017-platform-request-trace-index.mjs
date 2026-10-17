import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { planPlatformRequestTraceIndexes } from './platform-request-trace-index.plan.mjs';

const apply = process.argv.includes('--apply');
const rollback = process.argv.includes('--rollback');
const expectedHash = process.argv
  .find((value) => value.startsWith('--expected-report-sha256='))
  ?.split('=')[1];
if (apply && rollback) throw new Error('Choose either --apply or --rollback');
if ((apply || rollback) && !expectedHash)
  throw new Error(
    'Apply and rollback require a reviewed dry-run report SHA-256',
  );
if (!process.env.MONGODB_URI)
  throw new Error('MONGODB_URI must be provided by the invoking process');

const databaseName = process.env.AUDIT_DATABASE_NAME || 'continuum_audit';
const collectionName = 'audit_logs_iam';
const targetFingerprint = createHash('sha256')
  .update(`${process.env.MONGODB_URI}\n${databaseName}`)
  .digest('hex');
const connection = mongoose.createConnection(process.env.MONGODB_URI, {
  dbName: databaseName,
  autoIndex: false,
  serverSelectionTimeoutMS: 5000,
});

async function inspect(db) {
  const listed = await db.listCollections({ name: collectionName }).toArray();
  const objectType = listed.length ? listed[0].type : null;
  const collection = db.collection(collectionName);
  const indexes = objectType === 'collection' ? await collection.indexes() : [];
  const documentCount =
    objectType === 'collection' ? await collection.countDocuments() : 0;
  return planPlatformRequestTraceIndexes(
    {
      databaseName: db.databaseName,
      targetFingerprint,
      collection: { objectType, documentCount, indexes },
    },
    { rollback },
  );
}

try {
  await connection.asPromise();
  const db = connection.db;
  if (!db || db.databaseName !== databaseName)
    throw new Error(
      'Connected audit database does not match the configured target',
    );
  const plan = await inspect(db);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);

  if (apply || rollback) {
    if (!plan.clean || expectedHash !== plan.reportSha256)
      throw new Error('Migration refused: report is not clean or hash differs');

    const collection = db.collection(collectionName);
    for (const index of plan.desiredIndexes) {
      if (apply && index.action === 'CREATE')
        await collection.createIndex(index.key, { name: index.name });
      if (rollback && index.action === 'DROP')
        await collection.dropIndex(index.name);
    }

    const verification = await inspect(db);
    if (!verification.clean)
      throw new Error('Request trace index migration verification failed');
    if (
      apply &&
      verification.desiredIndexes.some((index) => index.action !== 'KEEP')
    )
      throw new Error('Request trace index verification failed');
    if (
      rollback &&
      verification.desiredIndexes.some((index) => index.action !== 'SKIP')
    )
      throw new Error('Request trace index rollback verification failed');
    process.stdout.write(
      `Verified request trace indexes ${apply ? 'installed' : 'removed'}; audit records and collection were preserved.\n`,
    );
  }
} finally {
  await connection.close();
}
