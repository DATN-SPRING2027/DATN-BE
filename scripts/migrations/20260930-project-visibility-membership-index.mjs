import 'dotenv/config';
import { createHash } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import {
  buildProjectFoundationReport,
  PROJECT_MEMBERSHIP_INDEX_NAME,
} from './project-foundation.plan.mjs';
import {
  resolveIamDatabaseName,
  targetFingerprint,
} from './organization-membership-backfill.plan.mjs';

const apply = process.argv.includes('--apply');
const projectWritesPaused = process.argv.includes('--project-writes-paused');
const projectMembershipWritesPaused = process.argv.includes(
  '--project-membership-writes-paused',
);
const expectedHashFlag = process.argv.find((argument) =>
  argument.startsWith('--expected-report-sha256='),
);
const expectedHash = expectedHashFlag?.split('=')[1];
const uri = process.env.MONGODB_URI;
const databaseName = resolveIamDatabaseName({
  mongodbEnabled: process.env.MONGODB_ENABLED,
  infraEnabled: process.env.INFRA_ENABLED,
  configuredName: process.env.MONGODB_DATABASE,
});

if (!uri) throw new Error('MONGODB_URI is required for the read-only report');
if (apply && !expectedHash) {
  throw new Error(
    'Apply requires --expected-report-sha256=<hash> from a reviewed clean dry-run',
  );
}
if (apply && !projectWritesPaused) {
  throw new Error('Apply requires --project-writes-paused');
}
if (apply && !projectMembershipWritesPaused) {
  throw new Error('Apply requires --project-membership-writes-paused');
}

const fingerprint = targetFingerprint(uri, databaseName);
const connection = mongoose.createConnection(uri, {
  dbName: databaseName,
  autoIndex: false,
  serverSelectionTimeoutMS: 5000,
});

async function collectionExists(db, collectionName) {
  return db
    .listCollections({ name: collectionName }, { nameOnly: true })
    .hasNext();
}

async function readReport(db) {
  const [hasProjects, hasMemberships] = await Promise.all([
    collectionExists(db, 'projects'),
    collectionExists(db, 'project_memberships'),
  ]);
  const [projects, projectMemberships, indexes] = await Promise.all([
    hasProjects
      ? db
          .collection('projects')
          .find(
            {},
            {
              projection: { _id: 1, organizationId: 1, visibility: 1 },
            },
          )
          .toArray()
      : Promise.resolve([]),
    hasMemberships
      ? db
          .collection('project_memberships')
          .find(
            {},
            {
              projection: {
                _id: 1,
                organizationId: 1,
                projectId: 1,
                userId: 1,
                status: 1,
              },
            },
          )
          .toArray()
      : Promise.resolve([]),
    hasMemberships
      ? db.collection('project_memberships').listIndexes().toArray()
      : Promise.resolve([]),
  ]);
  return buildProjectFoundationReport({
    projects,
    projectMemberships,
    indexes,
  });
}

try {
  await connection.asPromise();
  const db = connection.db;
  if (!db) throw new Error('MongoDB connection did not select a database');

  const report = await readReport(db);
  const reviewedReport = {
    databaseName,
    targetFingerprint: fingerprint,
    ...report,
  };
  const hash = createHash('sha256')
    .update(JSON.stringify(reviewedReport))
    .digest('hex');
  process.stdout.write(
    `${JSON.stringify({ ...reviewedReport, reportSha256: hash }, null, 2)}\n`,
  );

  if (!apply) {
    process.exitCode = report.clean ? 0 : 2;
  } else if (!report.clean || expectedHash !== hash) {
    throw new Error(
      'Apply refused: report is not clean or its SHA-256 differs from the reviewed dry-run',
    );
  } else {
    const projects = db.collection('projects');
    let projectsSetPrivate = 0;
    for (const projectId of report.projectsToSetPrivate) {
      const result = await projects.updateOne(
        {
          _id: new Types.ObjectId(projectId),
          visibility: { $exists: false },
        },
        { $set: { visibility: 'PRIVATE' } },
      );
      if (result.matchedCount !== 1) {
        throw new Error(
          `Project ${projectId} changed after dry-run; stop and review a new report`,
        );
      }
      projectsSetPrivate += result.modifiedCount;
    }

    if (report.projectMembershipIndex.action === 'CREATE') {
      await db
        .collection('project_memberships')
        .createIndex(
          { projectId: 1, userId: 1 },
          { unique: true, name: PROJECT_MEMBERSHIP_INDEX_NAME },
        );
    }

    const after = await readReport(db);
    if (
      !after.clean ||
      after.projectsToSetPrivate.length > 0 ||
      after.projectMembershipIndex.action !== 'PRESENT'
    ) {
      throw new Error(
        'Post-apply verification failed; preserve the report and stop before deploying dependent code',
      );
    }
    process.stdout.write(
      `Migration verified: ${projectsSetPrivate} Project(s) set to PRIVATE; unique Project Membership index is present.\n`,
    );
  }
} finally {
  await connection.close();
}
