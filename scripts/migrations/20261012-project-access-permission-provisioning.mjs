import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import {
  resolveIamDatabaseName,
  targetFingerprint,
} from './organization-membership-backfill.plan.mjs';
import {
  getProjectAccessPermissionRollbackAdditions,
  hashProjectAccessPermissionReport,
  planProjectAccessPermissionProvisioning,
  PROJECT_ACCESS_PERMISSION_PROVISIONING,
} from './project-access-permission-provisioning.plan.mjs';

const targetRoleCodes = PROJECT_ACCESS_PERMISSION_PROVISIONING.roles.map(
  ({ code }) => code,
);

function resolveDatabaseName() {
  return resolveIamDatabaseName({
    mongodbEnabled: process.env.MONGODB_ENABLED,
    infraEnabled: process.env.INFRA_ENABLED,
    configuredName: process.env.MONGODB_DATABASE,
  });
}

async function inspectDatabase(db, uri) {
  const objects = await db
    .listCollections({
      name: PROJECT_ACCESS_PERMISSION_PROVISIONING.collectionName,
    })
    .toArray();
  const object = objects.find(
    (entry) =>
      entry.name === PROJECT_ACCESS_PERMISSION_PROVISIONING.collectionName,
  );
  const objectType = object?.type ?? null;
  const collectionExists = objectType === 'collection';
  const roles = collectionExists
    ? await db
        .collection(PROJECT_ACCESS_PERMISSION_PROVISIONING.collectionName)
        .find(
          { code: { $in: targetRoleCodes } },
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

  return planProjectAccessPermissionProvisioning({
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
    PROJECT_ACCESS_PERMISSION_PROVISIONING.collectionName,
  );
  for (const role of plan.roles) {
    if (role.missingPermissions.length === 0) continue;
    const result = await collection.updateOne(roleFilter(role), {
      $addToSet: { permissions: { $each: role.missingPermissions } },
    });
    if (result.matchedCount !== 1) {
      throw new Error(
        `Apply stopped because the inspected ${role.code} Role changed after preflight`,
      );
    }
  }
}

function verifyRollbackReport(originalReport, currentPlan) {
  const additions = getProjectAccessPermissionRollbackAdditions(originalReport);
  if (
    originalReport.databaseName !== currentPlan.databaseName ||
    originalReport.targetFingerprint !== currentPlan.targetFingerprint
  ) {
    throw new Error('Rollback report targets a different MongoDB database');
  }

  const currentRoles = new Map(
    currentPlan.roles.map((role) => [role.code, role]),
  );
  for (const [code, addition] of additions) {
    const current = currentRoles.get(code);
    if (!current || current.id !== addition.id) {
      throw new Error(
        `Rollback stopped because the ${code} Role identity changed`,
      );
    }
  }
  return additions;
}

async function removePermissions(db, currentPlan, additions) {
  const currentRoles = new Map(
    currentPlan.roles.map((role) => [role.code, role]),
  );
  const collection = db.collection(
    PROJECT_ACCESS_PERMISSION_PROVISIONING.collectionName,
  );
  let removedPermissions = 0;
  for (const [code, addition] of additions) {
    if (addition.permissions.length === 0) continue;
    const role = currentRoles.get(code);
    const result = await collection.updateOne(roleFilter(role), {
      $pullAll: { permissions: addition.permissions },
    });
    if (result.matchedCount !== 1) {
      throw new Error(
        `Rollback stopped because the inspected ${code} Role changed after preflight`,
      );
    }
    removedPermissions += addition.permissions.filter((permission) =>
      role.existingPermissions.includes(permission),
    ).length;
  }
  return removedPermissions;
}

export async function runProjectAccessPermissionProvisioning({
  uri = process.env.MONGODB_URI,
  databaseName = resolveDatabaseName(),
  mode = 'dry-run',
  expectedReportSha256,
  rollbackReport,
} = {}) {
  if (!uri)
    throw new Error(
      'MONGODB_URI is required; this script does not load .env files',
    );
  if (!['dry-run', 'apply', 'rollback'].includes(mode))
    throw new Error(`Unsupported migration mode: ${mode}`);
  if (mode !== 'dry-run' && !expectedReportSha256)
    throw new Error(
      'Apply and rollback require the reviewed dry-run report SHA-256',
    );

  const parsedUri = new URL(uri);
  if (!['mongodb:', 'mongodb+srv:'].includes(parsedUri.protocol))
    throw new Error('MONGODB_URI must use a MongoDB protocol');

  const connection = await mongoose
    .createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 5000,
    })
    .asPromise();

  try {
    const db = connection.db;
    if (!db || db.databaseName !== databaseName)
      throw new Error(
        'Connected database does not match the configured IAM target',
      );

    const plan = await inspectDatabase(db, uri);
    const reportSha256 = hashProjectAccessPermissionReport(plan);
    if (mode === 'dry-run') return { ...plan, reportSha256 };
    if (expectedReportSha256 !== reportSha256)
      throw new Error(
        'Operation refused: report differs from the reviewed dry-run',
      );
    if (!plan.clean)
      throw new Error(
        `Operation blocked by preflight findings: ${plan.issues.join(', ')}`,
      );

    if (mode === 'apply') {
      await addPermissions(db, plan);
      const after = await inspectDatabase(db, uri);
      if (
        !after.clean ||
        after.roles.some((role) => role.missingPermissions.length > 0)
      ) {
        throw new Error(
          'Post-apply verification failed; rerun dry-run before retrying',
        );
      }
      return {
        ...plan,
        reportSha256,
        result: {
          action: plan.action === 'NOOP' ? 'NOOP' : 'APPLIED',
          addedPermissions: plan.roles.reduce(
            (total, role) => total + role.missingPermissions.length,
            0,
          ),
          verified: true,
        },
      };
    }

    if (!rollbackReport)
      throw new Error('Rollback requires the saved pre-apply dry-run report');
    const additions = verifyRollbackReport(rollbackReport, plan);
    const removedPermissions = await removePermissions(db, plan, additions);
    const after = await inspectDatabase(db, uri);
    const remainingRollbackPermissions = after.roles.some((role) => {
      const rollbackRole = additions.get(role.code);
      return rollbackRole?.permissions.some((permission) =>
        role.existingPermissions.includes(permission),
      );
    });
    if (!after.clean || remainingRollbackPermissions)
      throw new Error(
        'Post-rollback verification failed; rerun dry-run before retrying',
      );

    return {
      ...plan,
      reportSha256,
      result: {
        action: 'ROLLED_BACK',
        removedPermissions,
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
  const report = await runProjectAccessPermissionProvisioning({
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
