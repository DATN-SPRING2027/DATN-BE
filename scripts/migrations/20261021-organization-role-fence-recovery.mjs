import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { MigrationScanBudget } from './migration-scan-budget.mjs';
import {
  buildFenceRecoveryPlan,
  snapshotHash,
  validateRecoveryUri,
  validateReviewedPlan,
  RECOVERY_DATABASE,
  RECOVERY_MARKER,
} from './organization-role-fence-recovery.plan.mjs';

// Scoped MongoDB 8 disposable validation only. No dotenv or shared/remote target support.
export async function inspectRecoveryTarget(client) {
  if (
    client.options.dbName !== RECOVERY_DATABASE ||
    !client.options.hosts?.length ||
    !client.options.hosts.every((host) =>
      ['127.0.0.1', 'localhost', '::1'].includes(host.host),
    )
  )
    throw new Error('DISPOSABLE_LOOPBACK_IAM_ONLY');
  const admin = client.db('admin');
  const hello = await admin.command({ hello: 1 });
  const build = await admin.command({ buildInfo: 1 });
  const auth = await admin.command({ connectionStatus: 1 });
  const marker = await admin
    .collection('datn_migration_test_fixture')
    .findOne({ _id: RECOVERY_MARKER }, { maxTimeMS: 5000 });
  if (
    build.versionArray?.[0] !== 8 ||
    !hello.isWritablePrimary ||
    !hello.setName?.startsWith('org08-mongo8-recovery-') ||
    !hello.hosts?.length ||
    !hello.hosts.every((host) => /^127\.0\.0\.1:\d+$/.test(host)) ||
    !auth.authInfo?.authenticatedUsers?.length ||
    marker?.environment !== 'DISPOSABLE_LOCAL' ||
    marker?.replicaSet !== hello.setName
  )
    throw new Error(
      'AUTHENTICATED_MARKED_DISPOSABLE_MONGO8_REPLICA_SET_REQUIRED',
    );
  return {
    database: RECOVERY_DATABASE,
    replicaSet: hello.setName,
    markerId: RECOVERY_MARKER,
  };
}
export async function readRecoveryRows(client, session) {
  const budget = new MigrationScanBudget();
  const rows = [];
  const cursor = client
    .db(RECOVERY_DATABASE)
    .collection('role_assignments')
    .find({}, { session, maxTimeMS: 10000 })
    .sort({ _id: 1 })
    .batchSize(100);
  try {
    for await (const row of cursor) {
      budget.addDocument(
        Buffer.byteLength(mongoose.mongo.BSON.EJSON.stringify(row)),
      );
      rows.push(row);
    }
  } finally {
    await cursor.close();
  }
  return rows;
}
export function missingFenceCasFilter(row) {
  return {
    _id: row._id,
    mutationFence: { $exists: false },
    $expr: { $eq: ['$$ROOT', { $literal: row }] },
  };
}
export async function planRecovery(client) {
  const target = await inspectRecoveryTarget(client);
  return buildFenceRecoveryPlan(await readRecoveryRows(client), target);
}
export async function applyRecovery(
  client,
  reviewedPlan,
  { writersPaused = false } = {},
) {
  if (!writersPaused) throw new Error('WRITERS_PAUSED_ASSERTION_REQUIRED');
  const target = await inspectRecoveryTarget(client);
  validateReviewedPlan(reviewedPlan, target);
  const session = client.startSession();
  let result;
  try {
    await session.withTransaction(
      async () => {
        const rows = await readRecoveryRows(client, session);
        const beforeHash = snapshotHash(rows);
        if (beforeHash === reviewedPlan.afterHash) {
          result = {
            outcome: 'REPLAYED',
            changedCount: 0,
            planHash: reviewedPlan.planHash,
            afterHash: beforeHash,
          };
          return;
        }
        if (
          beforeHash !== reviewedPlan.beforeHash ||
          rows.length !== reviewedPlan.totalCount
        )
          throw new Error('SNAPSHOT_CHANGED_REVIEW_AGAIN');
        const current = buildFenceRecoveryPlan(rows, target);
        if (!current.clean || current.planHash !== reviewedPlan.planHash)
          throw new Error('SNAPSHOT_CHANGED_REVIEW_AGAIN');
        const collection = client
          .db(RECOVERY_DATABASE)
          .collection('role_assignments');
        let changedCount = 0;
        for (const row of rows.filter(
          (value) => !Object.hasOwn(value, 'mutationFence'),
        )) {
          const update = await collection.updateOne(
            missingFenceCasFilter(row),
            { $set: { mutationFence: 0 } },
            { session, upsert: false, maxTimeMS: 5000 },
          );
          if (update.matchedCount !== 1 || update.modifiedCount !== 1)
            throw new Error('FENCE_CAS_CONFLICT');
          changedCount += 1;
        }
        const afterHash = snapshotHash(await readRecoveryRows(client, session));
        if (
          changedCount !== reviewedPlan.missingCount ||
          afterHash !== reviewedPlan.afterHash
        )
          throw new Error('POST_APPLY_VERIFICATION_FAILED');
        result = {
          outcome: 'APPLIED',
          changedCount,
          planHash: reviewedPlan.planHash,
          afterHash,
        };
      },
      {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
        maxCommitTimeMS: 10000,
      },
    );
    return result;
  } finally {
    await session.endSession();
  }
}
export async function runRecoveryCli(
  args = process.argv.slice(2),
  env = process.env,
) {
  if (
    args.some(
      (arg) =>
        arg !== '--apply' &&
        arg !== '--writers-paused' &&
        !arg.startsWith('--reviewed-plan='),
    )
  )
    throw new Error('INVALID_ARGUMENTS');
  const applying = args.includes('--apply');
  if (
    (!applying && args.length) ||
    (applying &&
      (!args.includes('--writers-paused') ||
        args.filter((arg) => arg.startsWith('--reviewed-plan=')).length !== 1))
  )
    throw new Error('INVALID_ARGUMENTS');
  const uri = validateRecoveryUri(env.ORG08_RECOVERY_MONGODB_URI);
  const client = new mongoose.mongo.MongoClient(uri, {
    appName: 'ORG08-local-disposable-fence-recovery',
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 15000,
    maxPoolSize: 2,
  });
  try {
    await client.connect();
    if (!applying) return await planRecovery(client);
    const path = args
      .find((arg) => arg.startsWith('--reviewed-plan='))
      .slice('--reviewed-plan='.length);
    const reviewedPlan = JSON.parse(await readFile(path, 'utf8'));
    return await applyRecovery(client, reviewedPlan, { writersPaused: true });
  } finally {
    await client.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(JSON.stringify(await runRecoveryCli(), null, 2));
  } catch {
    console.error(
      'ORG08_LOCAL_RECOVERY_FAILED: verify disposable Mongo8 target, reviewed plan, paused writers and transaction outcome; no URI or documents logged.',
    );
    process.exitCode = 1;
  }
}
