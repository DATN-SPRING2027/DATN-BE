import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import {
  resolveIamDatabaseName,
  targetFingerprint,
} from './organization-membership-backfill.plan.mjs';
import {
  hashCreatorLeaderReport,
  planProjectCreatorLeader,
} from './project-creator-leader.plan.mjs';

export function resolveDatabaseName(env = process.env) {
  return resolveIamDatabaseName({
    mongodbEnabled: env.MONGODB_ENABLED,
    infraEnabled: env.INFRA_ENABLED,
    configuredName: env.MONGODB_DATABASE,
  });
}

async function inspectDatabase(db, uri, targetProjectId) {
  const [projects, memberships, roleAssignments, roles] = await Promise.all([
    db
      .collection('projects')
      .find(
        { status: 'ACTIVE' },
        {
          projection: {
            _id: 1,
            organizationId: 1,
            name: 1,
            createdBy: 1,
            status: 1,
          },
        },
      )
      .sort({ createdAt: 1, _id: 1 })
      .toArray(),
    db
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
      .toArray(),
    db
      .collection('role_assignments')
      .find(
        { projectId: { $ne: null } },
        {
          projection: {
            _id: 1,
            organizationId: 1,
            projectId: 1,
            userId: 1,
            roleId: 1,
            roleCode: 1,
          },
        },
      )
      .toArray(),
    db
      .collection('roles')
      .find(
        {},
        {
          projection: {
            _id: 1,
            code: 1,
            permissions: 1,
          },
        },
      )
      .toArray(),
  ]);

  return planProjectCreatorLeader({
    databaseName: db.databaseName,
    targetFingerprint: targetFingerprint(uri, db.databaseName),
    targetProjectId,
    projects,
    memberships,
    roleAssignments,
    roles,
  });
}

async function applyPromotions(db, plan, session) {
  const collection = db.collection('role_assignments');
  let appliedCount = 0;

  for (const promotion of plan.plannedPromotions) {
    const filter = {
      _id: new mongoose.Types.ObjectId(promotion.assignmentId),
      organizationId: new mongoose.Types.ObjectId(promotion.organizationId),
      projectId: new mongoose.Types.ObjectId(promotion.projectId),
      userId: new mongoose.Types.ObjectId(promotion.creatorId),
      roleId: new mongoose.Types.ObjectId(promotion.fromRoleId),
      roleCode: 'MEMBER',
    };
    const update = {
      $set: {
        roleId: new mongoose.Types.ObjectId(promotion.toRoleId),
        roleCode: 'TEAM_LEADER',
      },
    };

    const result = await collection.updateOne(filter, update, { session });
    if (result.matchedCount !== 1) {
      throw new Error(
        `Apply failed for assignment ${promotion.assignmentId}: record changed during migration`,
      );
    }
    appliedCount += result.modifiedCount;
  }

  return appliedCount;
}

export async function applyPromotionsAtomically(connection, db, plan) {
  if (plan.plannedPromotions.length === 0) return 0;
  const session = await connection.startSession();
  try {
    let appliedCount = 0;
    await session.withTransaction(async () => {
      appliedCount = await applyPromotions(db, plan, session);
    });
    return appliedCount;
  } finally {
    await session.endSession();
  }
}

export async function runProjectCreatorLeader({
  uri = process.env.MONGODB_URI,
  databaseName = resolveDatabaseName(process.env),
  mode = 'dry-run',
  expectedReportSha256,
  targetProjectId,
} = {}) {
  if (!uri) throw new Error('MONGODB_URI is required');
  if (!['dry-run', 'apply'].includes(mode)) {
    throw new Error(`Unsupported migration mode: ${mode}`);
  }
  if (mode === 'apply' && !expectedReportSha256) {
    throw new Error('Apply requires the reviewed dry-run report SHA-256');
  }

  const parsedUri = new URL(uri);
  if (!['mongodb:', 'mongodb+srv:'].includes(parsedUri.protocol)) {
    throw new Error('MONGODB_URI must use a MongoDB protocol');
  }

  const connection = await mongoose
    .createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15000,
    })
    .asPromise();

  try {
    const db = connection.db;
    if (!db || db.databaseName !== databaseName) {
      throw new Error(
        'Connected database does not match the configured IAM target',
      );
    }

    const plan = await inspectDatabase(db, uri, targetProjectId);
    const reportSha256 = hashCreatorLeaderReport(plan);

    if (mode === 'dry-run') {
      return { ...plan, reportSha256 };
    }

    if (expectedReportSha256 !== reportSha256) {
      throw new Error(
        'Operation refused: report differs from the reviewed dry-run',
      );
    }

    if (!plan.isSafe) {
      const skippedReasons = [
        ...new Set(plan.skippedProjects.map(({ reason }) => reason)),
      ];
      const findings = [...plan.globalIssues, ...skippedReasons];
      throw new Error(
        `Operation blocked by preflight findings: ${findings.join(', ')}`,
      );
    }

    const appliedCount = await applyPromotionsAtomically(connection, db, plan);
    const after = await inspectDatabase(db, uri, targetProjectId);

    if (!after.isSafe || after.plannedPromotions.length > 0) {
      throw new Error(
        'Post-apply verification failed; re-run dry-run to inspect',
      );
    }

    return {
      ...plan,
      reportSha256,
      result: {
        action: plan.plannedPromotions.length === 0 ? 'NOOP' : 'APPLIED',
        appliedCount,
        verified: after.isSafe,
        remainingSkippedProjects: after.skippedProjects,
      },
    };
  } finally {
    await connection.close();
  }
}

async function runCli() {
  const apply = process.argv.includes('--apply');
  const mode = apply ? 'apply' : 'dry-run';
  const expectedReportSha256 = process.argv
    .find((arg) => arg.startsWith('--expected-report-sha256='))
    ?.split('=')[1];
  const targetProjectId = process.argv
    .find((arg) => arg.startsWith('--project-id='))
    ?.split('=')[1];

  const report = await runProjectCreatorLeader({
    mode,
    expectedReportSha256,
    targetProjectId,
  });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.isSafe || report.result?.verified === false) {
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCli().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
