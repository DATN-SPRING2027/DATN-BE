import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import {
  resolveIamDatabaseName,
  targetFingerprint,
} from './organization-membership-backfill.plan.mjs';
import {
  getDesiredOrganizationInvitationIndexes,
  planOrganizationInvitationIndexes,
} from './organization-invitations.plan.mjs';

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
  const objectType = objects.length === 0 ? null : objects[0].type;
  const collectionExists = objectType !== null;
  const collection = db.collection('organization_invitations');
  const documentCount =
    objectType === 'collection' ? await collection.countDocuments() : 0;
  const pendingInvitationCount =
    objectType === 'collection'
      ? await collection.countDocuments({ status: 'PENDING', expiresAt: { $gt: new Date() } })
      : 0;
  const pendingDuplicatePairs =
    objectType === 'collection'
      ? await collection
          .aggregate([
            { $match: { status: 'PENDING' } },
            {
              $group: {
                _id: { organizationId: '$organizationId', email: '$email' },
                count: { $sum: 1 },
              },
            },
            { $match: { count: { $gt: 1 } } },
            {
              $project: {
                _id: 0,
                organizationId: { $toString: '$_id.organizationId' },
                email: '$_id.email',
                count: 1,
              },
            },
            { $limit: 100 },
          ])
          .toArray()
      : [];
  const invalidRecords =
    objectType === 'collection'
      ? await collection
          .find(
            {
              $or: [
                { organizationId: { $not: { $type: 'objectId' } } },
                { invitedBy: { $not: { $type: 'objectId' } } },
                { email: { $not: { $type: 'string' } } },
                { roleCode: { $nin: ['ADMIN', 'TEAM_LEADER', 'MEMBER'] } },
                { status: { $nin: ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'] } },
                { expiresAt: { $not: { $type: 'date' } } },
                {
                  $expr: {
                    $cond: [
                      { $eq: [{ $type: '$email' }, 'string'] },
                      { $ne: ['$email', { $toLower: { $trim: { input: '$email' } } }] },
                      false,
                    ],
                  },
                },
              ],
            },
            { projection: { _id: 1, status: 1 } },
          )
          .limit(100)
          .toArray()
          .then((rows) => rows.map((row) => ({ id: String(row._id), status: row.status ?? null })))
      : [];
  const indexes =
    objectType === 'collection'
      ? await collection.indexes().catch((error) => {
          if (error?.codeName === 'NamespaceNotFound') return [];
          throw error;
        })
      : [];
  return planOrganizationInvitationIndexes({
    databaseName: db.databaseName,
    targetFingerprint: fingerprint,
    collectionExists,
    objectType,
    documentCount,
    pendingInvitationCount,
    pendingDuplicatePairs,
    invalidRecords,
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
    if (!plan.collectionExists)
      await db.createCollection('organization_invitations');
    const collection = db.collection('organization_invitations');
    for (const index of plan.desiredIndexes) {
      if (index.action === 'CREATE') {
        const { key, unique, name, partialFilterExpression } = index;
        await collection.createIndex(key, {
          name,
          ...(unique ? { unique } : {}),
          ...(partialFilterExpression ? { partialFilterExpression } : {}),
        });
      }
    }
    const after = await inspect(db);
    if (!after.clean || after.documentCount < plan.documentCount ||
      after.desiredIndexes.some((index) => index.action !== 'NOOP'))
      throw new Error('Organization invitation collection/index verification failed');
    process.stdout.write(
      `Verified organization_invitations; documents before=${plan.documentCount}, after=${after.documentCount}.\n`,
    );
  }

  if (rollback) {
    if (!plan.clean || expectedHash !== reportSha256)
      throw new Error('Rollback refused: report does not match the reviewed dry-run');
    if (plan.pendingInvitationCount > 0)
      throw new Error('Rollback refused while unexpired pending invitations exist');
    if (plan.collectionExists) {
      const collection = db.collection('organization_invitations');
      for (const index of plan.desiredIndexes) {
        if (index.action === 'NOOP') await collection.dropIndex(index.name);
      }
    }
    process.stdout.write(
      'Removed only the invitation indexes. Invitation records and collection data were preserved.\n',
    );
  }
} finally {
  await connection.close();
}
