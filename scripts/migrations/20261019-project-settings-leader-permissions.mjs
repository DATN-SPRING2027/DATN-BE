import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import {
  resolveIamDatabaseName,
  targetFingerprint,
} from './organization-membership-backfill.plan.mjs';
import {
  assertLeaderPermissionsReceiptKey,
  createLeaderPermissionsApplyReceipt,
  getLeaderPermissionsRollbackAdditions,
  hashLeaderPermissionsReport,
  planProjectSettingsLeaderPermissions,
  PROJECT_SETTINGS_LEADER_PERMISSIONS_PROVISIONING,
} from './project-settings-leader-permissions.plan.mjs';

export function resolveDatabaseName(env = process.env, override = null) {
  const canonical = resolveIamDatabaseName({
    mongodbEnabled: env.MONGODB_ENABLED,
    infraEnabled: env.INFRA_ENABLED,
    configuredName: env.MONGODB_DATABASE,
  });

  if (override) {
    const allowed = new Set([canonical]);
    if (!allowed.has(override)) {
      throw new Error(
        `Database override '${override}' is not an approved IAM database (allowed: ${[...allowed].join(', ')})`,
      );
    }
    return override;
  }

  return canonical;
}

async function inspectDatabase(db, uri) {
  const collections = await db.listCollections().toArray();
  const object = collections.find(
    (entry) =>
      entry.name ===
      PROJECT_SETTINGS_LEADER_PERMISSIONS_PROVISIONING.collectionName,
  );
  const objectType = object?.type ?? null;
  const collectionExists = objectType === 'collection';
  const roles = collectionExists
    ? await db
        .collection(
          PROJECT_SETTINGS_LEADER_PERMISSIONS_PROVISIONING.collectionName,
        )
        .find(
          {},
          {
            projection: {
              _id: 1,
              code: 1,
              name: 1,
              permissions: 1,
              isSystem: 1,
            },
          },
        )
        .sort({ code: 1, _id: 1 })
        .toArray()
    : [];

  return planProjectSettingsLeaderPermissions({
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
    name: role.name,
    isSystem: true,
    permissions: role.permissionsFieldMissing
      ? { $exists: false }
      : role.existingPermissions,
  };
}

async function addPermissions(db, plan) {
  const collection = db.collection(
    PROJECT_SETTINGS_LEADER_PERMISSIONS_PROVISIONING.collectionName,
  );
  if (plan.role.missingPermissions.length === 0) return [];
  const result = await collection.updateOne(roleFilter(plan.role), {
    $addToSet: { permissions: { $each: plan.role.missingPermissions } },
  });
  if (result.matchedCount !== 1) {
    throw new Error(
      `Apply stopped because inspected ${plan.role.code} Role changed after preflight`,
    );
  }
  return [...plan.role.missingPermissions];
}

async function removePermissions(db, currentPlan, additions) {
  const collection = db.collection(
    PROJECT_SETTINGS_LEADER_PERMISSIONS_PROVISIONING.collectionName,
  );
  if (additions.permissions.length === 0) return 0;
  const result = await collection.updateOne(roleFilter(currentPlan.role), {
    $pullAll: { permissions: additions.permissions },
  });
  if (result.matchedCount !== 1) {
    throw new Error(
      `Rollback stopped because inspected TEAM_LEADER Role changed after preflight`,
    );
  }
  return additions.permissions.filter((p) =>
    currentPlan.role.existingPermissions.includes(p),
  ).length;
}

export async function runProjectSettingsLeaderPermissions(options = {}) {
  const env = options.env ?? process.env;
  const canonicalDatabaseName = resolveDatabaseName(env);
  const databaseName = options.databaseName ?? canonicalDatabaseName;
  const uri = options.uri ?? env.MONGODB_URI;
  const mode = options.mode ?? 'dry-run';
  const expectedReportSha256 = options.expectedReportSha256;
  const expectedApplyReceiptHmac = options.expectedApplyReceiptHmac;
  const receiptKey = options.receiptKey ?? env.PROJECT_SETTINGS_RECEIPT_KEY;
  const rollbackReport = options.rollbackReport;

  if (databaseName !== canonicalDatabaseName) {
    throw new Error('Database target must match the canonical IAM resolver');
  }
  if (!uri) {
    throw new Error(
      'MONGODB_URI is required; this script does not load .env files',
    );
  }
  if (!['dry-run', 'apply', 'rollback'].includes(mode)) {
    throw new Error(`Unsupported migration mode: ${mode}`);
  }
  if (mode !== 'dry-run' && !expectedReportSha256) {
    throw new Error(
      'Apply and rollback require the reviewed dry-run report SHA-256',
    );
  }
  if (mode !== 'dry-run') {
    assertLeaderPermissionsReceiptKey(receiptKey);
  }
  if (mode === 'rollback' && !expectedApplyReceiptHmac) {
    throw new Error('Rollback requires the reviewed apply receipt HMAC');
  }

  const parsedUri = new URL(uri);
  if (!['mongodb:', 'mongodb+srv:'].includes(parsedUri.protocol)) {
    throw new Error('MONGODB_URI must use a MongoDB protocol');
  }

  const connection = await (
    options.connectionFactory
      ? options.connectionFactory(uri, {
          dbName: databaseName,
          autoIndex: false,
          serverSelectionTimeoutMS: 15000,
        })
      : mongoose.createConnection(uri, {
          dbName: databaseName,
          autoIndex: false,
          serverSelectionTimeoutMS: 15000,
        })
  ).asPromise();

  try {
    const db = connection.db;
    if (!db || db.databaseName !== databaseName) {
      throw new Error(
        'Connected database does not match the configured IAM target',
      );
    }

    const plan = await inspectDatabase(db, uri);
    const reportSha256 = hashLeaderPermissionsReport(plan);
    if (mode === 'dry-run') return { ...plan, reportSha256 };
    if (expectedReportSha256 !== reportSha256) {
      throw new Error(
        'Operation refused: report differs from the reviewed dry-run',
      );
    }
    if (!plan.clean) {
      throw new Error(
        `Operation blocked by preflight findings: ${plan.issues.join(', ')}`,
      );
    }

    if (mode === 'apply') {
      const addedPermissions = await addPermissions(db, plan);
      const after = await inspectDatabase(db, uri);
      if (!after.clean || after.role.missingPermissions.length > 0) {
        throw new Error(
          'Post-apply verification failed; rerun dry-run before retrying',
        );
      }
      const result = {
        action: plan.action === 'NOOP' ? 'NOOP' : 'APPLIED',
        addedPermissions: addedPermissions.length,
        verified: true,
      };
      if (addedPermissions.length > 0) {
        result.applyReceipt = createLeaderPermissionsApplyReceipt(
          plan,
          after,
          addedPermissions,
          receiptKey,
        );
      }
      return {
        ...plan,
        reportSha256,
        result,
      };
    }

    if (!rollbackReport) {
      throw new Error('Rollback requires the verified apply report');
    }
    const additions = getLeaderPermissionsRollbackAdditions(
      rollbackReport,
      plan,
      expectedApplyReceiptHmac,
      receiptKey,
    );
    const removedCount = await removePermissions(db, plan, additions);
    const after = await inspectDatabase(db, uri);
    const remaining = after.role.existingPermissions.filter((p) =>
      additions.permissions.includes(p),
    );
    if (!after.clean || remaining.length > 0) {
      throw new Error(
        'Post-rollback verification failed; rerun dry-run before retrying',
      );
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
  const expectedApplyReceiptHmac = process.argv
    .find((argument) => argument.startsWith('--expected-apply-receipt-hmac='))
    ?.slice('--expected-apply-receipt-hmac='.length);
  const rollbackReportPath = process.argv
    .find((argument) => argument.startsWith('--rollback-from-report='))
    ?.slice('--rollback-from-report='.length);
  const rollbackReport = rollbackReportPath
    ? JSON.parse(await readFile(rollbackReportPath, 'utf8'))
    : undefined;
  const cliDatabase = process.argv
    .find((argument) => argument.startsWith('--database='))
    ?.split('=')[1];

  const report = await runProjectSettingsLeaderPermissions({
    databaseName: resolveDatabaseName(process.env, cliDatabase),
    mode,
    expectedReportSha256,
    expectedApplyReceiptHmac,
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
