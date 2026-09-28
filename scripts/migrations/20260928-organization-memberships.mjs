import 'dotenv/config';
import { createHash } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { buildBackfillReport, targetFingerprint } from './organization-membership-backfill.plan.mjs';

const apply = process.argv.includes('--apply');
const expectedHashFlag = process.argv.find((argument) =>
  argument.startsWith('--expected-report-sha256='),
);
const expectedHash = expectedHashFlag?.split('=')[1];
const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DATABASE;

if (!uri || !databaseName) {
  throw new Error('MONGODB_URI and MONGODB_DATABASE are required for the read-only report');
}
if (apply && !expectedHash) {
  throw new Error('Apply requires --expected-report-sha256=<hash> from a reviewed clean dry-run');
}
const intendedTarget = targetFingerprint(uri, databaseName);

const connection = mongoose.createConnection(uri, {
  dbName: databaseName,
  autoIndex: false,
  serverSelectionTimeoutMS: 5000,
});

try {
  await connection.asPromise();
  const db = connection.db;
  const [users, organizations, assignments, memberships] = await Promise.all([
    db.collection('users').find({}, { projection: { _id: 1 } }).toArray(),
    db.collection('organizations').find({}, { projection: { _id: 1 } }).toArray(),
    db.collection('role_assignments').find({}, {
      projection: { _id: 1, userId: 1, organizationId: 1, projectId: 1 },
    }).toArray(),
    db.collection('organization_memberships').find({}, {
      projection: { _id: 1, userId: 1, organizationId: 1, status: 1 },
    }).toArray(),
  ]);

  const report = buildBackfillReport({ users, organizations, assignments, memberships });
  const reviewedReport = { databaseName, targetFingerprint: intendedTarget, ...report };
  const hash = createHash('sha256').update(JSON.stringify(reviewedReport)).digest('hex');
  process.stdout.write(`${JSON.stringify({ ...reviewedReport, reportSha256: hash }, null, 2)}\n`);

  if (!apply) {
    process.exitCode = report.clean ? 0 : 2;
  } else if (!report.clean || expectedHash !== hash) {
    throw new Error('Apply refused: report is not clean or its SHA-256 differs from the reviewed dry-run');
  } else {
    const collection = db.collection('organization_memberships');
    await collection.createIndex(
      { organizationId: 1, userId: 1 },
      { unique: true, name: 'organizationId_1_userId_1' },
    );
    let created = 0;
    for (const row of report.toCreate) {
      const result = await collection.updateOne(
        {
          organizationId: new Types.ObjectId(row.organizationId),
          userId: new Types.ObjectId(row.userId),
        },
        { $setOnInsert: { status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date() } },
        { upsert: true },
      );
      created += result.upsertedCount;
    }
    process.stdout.write(`Backfill complete: ${created} memberships created; existing memberships and role assignments unchanged.\n`);
  }
} finally {
  await connection.close();
}
