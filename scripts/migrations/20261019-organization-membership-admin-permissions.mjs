import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import {
  resolveIamDatabaseName,
  targetFingerprint,
} from './organization-membership-backfill.plan.mjs';
import {
  getAdminPermissionsRollbackAdditions,
  hashAdminPermissionsReport,
  planOrganizationMembershipAdminPermissions,
  ORGANIZATION_MEMBERSHIP_ADMIN_PERMISSIONS_PROVISIONING,
} from './organization-membership-admin-permissions.plan.mjs';

export function resolveDatabaseName(env = process.env) {
  return resolveIamDatabaseName({
    mongodbEnabled: env.MONGODB_ENABLED,
    infraEnabled: env.INFRA_ENABLED,
    configuredName: env.MONGODB_DATABASE,
  });
}

async function inspectDatabase(db, uri) {
  const collections = await db.listCollections().toArray();
  const object = collections.find(
    (entry) => entry.name === ORGANIZATION_MEMBERSHIP_ADMIN_PERMISSIONS_PROVISIONING.collectionName,
  );
  const objectType = object?.type ?? null;
  const collectionExists = objectType === 'collection';
  const roles = collectionExists
    ? await db
        .collection(ORGANIZATION_MEMBERSHIP_ADMIN_PERMISSIONS_PROVISIONING.collectionName)
        .find(
          {},
          {
            projection: {
              _id: 1,
              code: 1,
              permissions: 1,
              isSystem: 1,
            },
          },
        )
        .sort({ code: 1, _id: 1 })
        .toArray()
    : [];

  return planOrganizationMembershipAdminPermissions({
    databaseName: db.databaseName,
    targetFingerprint: targetFingerprint(uri, db.databaseName),
    collectionExists,
    objectType,
    roles,
  });
}

function roleFilter(role) {
  return {
    _id: new mongoose.Types.ObjectId(role.id),
    code: role.code,
    isSystem: true,
    permissions: role.permissionsFieldMissing
      ? { $exists: false }
      : role.existingPermissions,
  };
}

async function addPermissions(db, plan) {
  const collection = db.collection(
    ORGANIZATION_MEMBERSHIP_ADMIN_PERMISSIONS_PROVISIONING.collectionName,
  );
  if (plan.role.missingPermissions.length === 0) return 0;
  const result = await collection.updateOne(roleFilter(plan.role), {
    $addToSet: { permissions: { $each: plan.role.missingPermissions } },
  });
  if (result.matchedCount !== 1) {
    throw new Error(
      `Apply stopped because inspected ${plan.role.code} Role changed after preflight`,
    );
  }
  return plan.role.missingPermissions.length;
}

function verifyRollbackReport(originalReport, currentPlan) {
  const additions = getAdminPermissionsRollbackAdditions(originalReport);
  if (
    originalReport.databaseName !== currentPlan.databaseName ||
    originalReport.targetFingerprint !== currentPlan.targetFingerprint
  ) {
    throw new Error('Rollback report targets a different MongoDB database');
  }

  if (currentPlan.role.id !== additions.id) {
    throw new Error(
      `Rollback stopped because ADMIN Role identity changed`,
    );
  }
  return additions;
}

async function removePermissions(db, currentPlan, additions) {
  const collection = db.collection(
    ORGANIZATION_MEMBERSHIP_ADMIN_PERMISSIONS_PROVISIONING.collectionName,
  );
  if (additions.permissions.length === 0) return 0;
  const result = await collection.updateOne(roleFilter(currentPlan.role), {
    $pullAll: { permissions: additions.permissions },
  });
  if (result.matchedCount !== 1) {
    throw new Error(
      `Rollback stopped because inspected ADMIN Role changed after preflight`,
    );
  }
  return additions.permissions.filter((p) =>
    currentPlan.role.existingPermissions.includes(p),
  ).length;
}

export async function runOrganizationMembershipAdminPermissions({
  uri = process.env.MONGODB_URI,
  databaseName = resolveDatabaseName(),
  mode = 'dry-run',
  expectedReportSha256,
  rollbackReport,
} = {}) {
  if (!uri) {
    throw new Error('MONGODB_URI is required; this script does not load .env files');
  }
  if (!['dry-run', 'apply', 'rollback'].includes(mode)) {
    throw new Error(`Unsupported migration mode: ${mode}`);
  }
  if (mode !== 'dry-run' && !expectedReportSha256) {
    throw new Error('Apply and rollback require the reviewed dry-run report SHA-256');
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
      throw new Error('Connected database does not match the configured IAM target');
    }

    const plan = await inspectDatabase(db, uri);
    const reportSha256 = hashAdminPermissionsReport(plan);
    if (mode === 'dry-run') return { ...plan, reportSha256 };
    if (expectedReportSha256 !== reportSha256) {
      throw new Error('Operation refused: report differs from the reviewed dry-run');
    }
    if (!plan.clean) {
      throw new Error(
        `Operation blocked by preflight findings: ${plan.issues.join(', ')}`,
      );
    }

    if (mode === 'apply') {
      const addedCount = await addPermissions(db, plan);
      const after = await inspectDatabase(db, uri);
      if (
        !after.clean ||
        after.role.missingPermissions.length > 0
      ) {
        throw new Error('Post-apply verification failed; rerun dry-run before retrying');
      }
      return {
        ...plan,
        reportSha256,
        result: {
          action: plan.action === 'NOOP' ? 'NOOP' : 'APPLIED',
          addedPermissions: addedCount,
          verified: true,
        },
      };
    }

    if (!rollbackReport) {
      throw new Error('Rollback requires the saved pre-apply dry-run report');
    }
    const additions = verifyRollbackReport(rollbackReport, plan);
    const removedCount = await removePermissions(db, plan, additions);
    const after = await inspectDatabase(db, uri);
    const remaining = after.role.existingPermissions.filter((p) =>
      additions.permissions.includes(p),
    );
    if (!after.clean || remaining.length > 0) {
      throw new Error('Post-rollback verification failed; rerun dry-run before retrying');
    }

    return {
      ...plan,
      reportSha256,
      result: {
        action: 'ROLLED_BACK',
        removedPermissions: removedCount,
        verified: true,
      },
    };
  } finally {
    await connection.close();
  }
}

async function runCli() {
  const apply = process.argv.includes('--apply');
  const rollback = process.argv.includes('--rollback');
  if (apply && rollback) throw new Error('Choose either --apply or --rollback');
  const mode = apply ? 'apply' : rollback ? 'rollback' : 'dry-run';
  const expectedReportSha256 = process.argv
    .find((argument) => argument.startsWith('--expected-report-sha256='))
    ?.split('=')[1];
  const rollbackReportPath = process.argv
    .find((argument) => argument.startsWith('--rollback-from-report='))
    ?.slice('--rollback-from-report='.length);
  const rollbackReport = rollbackReportPath
    ? JSON.parse(await readFile(rollbackReportPath, 'utf8'))
    : undefined;

  const report = await runOrganizationMembershipAdminPermissions({
    mode,
    expectedReportSha256,
    rollbackReport,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.clean) process.exitCode = 2;
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
