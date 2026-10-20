import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import {
  resolveIamDatabaseName,
  targetFingerprint,
} from './organization-membership-backfill.plan.mjs';
import {
  getDesiredOrganizationInvitationTokenIndex,
  planOrganizationInvitationTokenIndex,
} from './organization-invitation-token-index.plan.mjs';

const apply = process.argv.includes('--apply');
const rollback = process.argv.includes('--rollback');
const expectedHash = process.argv
  .find((value) => value.startsWith('--expected-report-sha256='))
  ?.split('=')[1];
if (apply && rollback) throw new Error('Choose either --apply or --rollback');
if ((apply || rollback) && !expectedHash)
  throw new Error('Apply and rollback require a reviewed dry-run report SHA-256');
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');

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
  const objects = await db
    .listCollections({ name: 'organization_invitations' })
    .toArray();
  const objectType = objects[0]?.type ?? null;
  const collection = db.collection('organization_invitations');
  const documentCount =
    objectType === 'collection' ? await collection.countDocuments() : 0;
  const pendingV3InvitationCount =
    objectType === 'collection'
      ? await collection.countDocuments({ contractVersion: 3, status: 'PENDING' })
      : 0;
  const v3InvitationCount =
    objectType === 'collection'
      ? await collection.countDocuments({ contractVersion: 3 })
      : 0;
  const v3InvitationsWithoutTokenHashCount =
    objectType === 'collection'
      ? await collection.countDocuments({
          contractVersion: 3,
          $or: [{ tokenHash: { $exists: false } }, { tokenHash: null }],
        })
      : 0;
  const duplicateTokenHashGroups =
    objectType === 'collection'
      ? (
          await collection
            .aggregate([
              { $match: { tokenHash: { $type: 'string' } } },
              { $group: { _id: '$tokenHash', count: { $sum: 1 } } },
              { $match: { count: { $gt: 1 } } },
              { $count: 'count' },
            ])
            .toArray()
        )[0]?.count ?? 0
      : 0;
  const malformedTokenHashCount =
    objectType === 'collection'
      ? await collection.countDocuments({
          tokenHash: { $exists: true, $ne: null, $not: /^[a-f\d]{64}$/ },
        })
      : 0;
  const indexes =
    objectType === 'collection'
      ? await collection.indexes().catch((error) => {
          if (error?.codeName === 'NamespaceNotFound') return [];
          throw error;
        })
      : [];
  return planOrganizationInvitationTokenIndex({
    databaseName: db.databaseName,
    targetFingerprint: fingerprint,
    objectType,
    documentCount,
    v3InvitationCount,
    v3InvitationsWithoutTokenHashCount,
    pendingV3InvitationCount,
    duplicateTokenHashGroups,
    malformedTokenHashCount,
    indexes,
  });
}

try {
  await connection.asPromise();
  const db = connection.db;
  if (!db || db.databaseName !== databaseName)
    throw new Error('Connected IAM database does not match the configured target');
  const plan = await inspect(db);
  const reportSha256 = createHash('sha256')
    .update(JSON.stringify(plan))
    .digest('hex');
  process.stdout.write(`${JSON.stringify({ ...plan, reportSha256 }, null, 2)}\n`);
  if (!plan.clean) process.exitCode = 2;

  if (apply) {
    if (!plan.clean || expectedHash !== reportSha256)
      throw new Error('Apply refused: report does not match the reviewed dry-run');
    const collection = db.collection('organization_invitations');
    const { key, name, unique, partialFilterExpression } =
      getDesiredOrganizationInvitationTokenIndex();
    if (plan.desiredIndex.action === 'CREATE')
      await collection.createIndex(key, { name, unique, partialFilterExpression });
    const after = await inspect(db);
    if (!after.clean || after.desiredIndex.action !== 'NOOP' ||
      after.documentCount !== plan.documentCount)
      throw new Error('Organization invitation token index verification failed');
    process.stdout.write(
      `Verified token hash index; invitation documents before=${plan.documentCount}, after=${after.documentCount}.\n`,
    );
  }

  if (rollback) {
    if (!plan.clean || expectedHash !== reportSha256)
      throw new Error('Rollback refused: report does not match the reviewed dry-run');
    if (!plan.rollbackAllowed)
      throw new Error('Rollback refused while V3 invitation records exist');
    if (plan.desiredIndex.action === 'NOOP')
      await db
        .collection('organization_invitations')
        .dropIndex('invitation_token_hash_unique_v3');
    process.stdout.write(
      'Removed only the token hash index. Invitation documents and token hashes were preserved.\n',
    );
  }
} finally {
  await connection.close();
}
