import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import mongoose from 'mongoose';
import {
  resolveIamDatabaseName,
  targetFingerprint,
} from './organization-membership-backfill.plan.mjs';
import {
  MigrationScanBudget,
  MIGRATION_SCAN_LIMITS,
} from './migration-scan-budget.mjs';
import {
  TRACKING_FIELDS,
  lifecycleHash,
  planMembershipLifecycle,
} from './organization-membership-lifecycle.plan.mjs';
const { MongoClient, ObjectId, BSON } = mongoose.mongo;
const projections = {
  users: ['status', 'mutationFence'],
  organizations: ['membershipAdminRevision'],
  organization_memberships: [
    'organizationId',
    'userId',
    'status',
    'version',
    'mutationFence',
    'createdAt',
    'updatedAt',
  ],
  organization_invitations: [
    'organizationId',
    'email',
    'roleCode',
    'status',
    'contractVersion',
    'version',
    'membershipId',
    'targetUserId',
    'supersedesInvitationId',
    'expiresAt',
    'createdAt',
    'acceptedAt',
    'acceptedBy',
    'revokedAt',
    'revokedBy',
  ],
  roles: ['code', 'isSystem', 'permissions', 'mutationFence'],
  role_assignments: [
    'organizationId',
    'userId',
    'roleId',
    'roleCode',
    'projectId',
    'mutationFence',
  ],
};
const names = [...Object.keys(projections), 'membership_operations'];
function normalizedRow(row) {
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'email') {
      result.emailHash = lifecycleHash(value);
      result.emailNormalized =
        typeof value === 'string' &&
        value === value.trim().toLowerCase() &&
        value.length <= 254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    } else if (key === '_id' || key.endsWith('Id'))
      result[key] =
        value instanceof ObjectId
          ? value.toHexString()
          : value === null
            ? null
            : 'INVALID_BSON_OBJECTID';
    else if (key.endsWith('At'))
      result[key] =
        value instanceof Date && Number.isFinite(value.getTime())
          ? value.toISOString()
          : null;
    else result[key] = value;
  }
  return result;
}
async function inventory(db) {
  const objects = {};
  for (const object of await db
    .listCollections({ name: { $in: names } })
    .toArray())
    objects[object.name] = {
      type: object.type,
      indexes:
        object.type === 'collection'
          ? await db.collection(object.name).listIndexes().toArray()
          : [],
    };
  return objects;
}
async function inspect(db, uri, session, objects) {
  objects ??= await inventory(db);
  const budget = new MigrationScanBudget(),
    rows = {};
  for (const [name, fields] of Object.entries(projections)) {
    rows[name] = [];
    const cursor = db
      .collection(name)
      .find(
        {},
        {
          projection: Object.fromEntries(
            ['_id', ...fields].map((key) => [key, 1]),
          ),
          session,
        },
      )
      .batchSize(MIGRATION_SCAN_LIMITS.cursorBatchSize);
    try {
      for await (const row of cursor) {
        budget.addDocument(Buffer.byteLength(BSON.EJSON.stringify(row)));
        rows[name].push(normalizedRow(row));
      }
    } finally {
      await cursor.close();
    }
  }
  const snapshot = {
    databaseName: db.databaseName,
    targetFingerprint: targetFingerprint(uri, db.databaseName),
    objects,
    rows,
    operationsCount: await db
      .collection('membership_operations')
      .countDocuments({}, { session }),
  };
  const report = planMembershipLifecycle(snapshot);
  budget.setReportBytes(Buffer.byteLength(JSON.stringify(report)));
  return { snapshot, report };
}
const byId = (snapshot, collection, id) =>
  snapshot.rows[collection].find((row) => row._id === id);
function assertRollback(snapshot, original) {
  const { reportSha256, ...body } = original ?? {};
  if (
    original?.migration !== '20261012-organization-membership-lifecycle-v1' ||
    original.schemaVersion !== 1 ||
    !original.clean ||
    lifecycleHash(body) !== reportSha256 ||
    original.databaseName !== snapshot.databaseName ||
    original.targetFingerprint !== snapshot.targetFingerprint
  )
    throw new Error('ROLLBACK_REPORT_INVALID');
  if (
    snapshot.operationsCount ||
    snapshot.rows.organization_invitations.some(
      (row) => row.contractVersion === 2,
    )
  )
    throw new Error('ROLLBACK_AFTER_V2_USAGE_FORBIDDEN');
  const originals = new Map(
    original.rowFingerprints.map((row) => [
      `${row.collection}:${row.id}`,
      row.fingerprint,
    ]),
  );
  const current = snapshot.rows;
  const restores = [];
  for (const [collection, rows] of Object.entries(current))
    for (const row of rows) {
      const before = originals.get(`${collection}:${row._id}`);
      if (!before) throw new Error('ROLLBACK_NEW_RECORDS_REQUIRE_RECOVERY');
      if (lifecycleHash(row) === before) continue;
      const restored = structuredClone(row);
      const update = original.updates.find(
        (item) => item.collection === collection && item.id === row._id,
      );
      if (update)
        for (const [field, value] of Object.entries(update.set)) {
          if (
            TRACKING_FIELDS[collection]?.[field] !== value ||
            (Object.hasOwn(row, field) && row[field] !== value)
          )
            throw new Error('ROLLBACK_TRACKING_CHANGED');
          delete restored[field];
        }
      const role =
        collection === 'roles'
          ? original.permissionAdditions.find((item) => item.id === row._id)
          : undefined;
      if (role) {
        const expected = [
          ...role.existingPermissions,
          ...role.missingPermissions,
        ];
        if (lifecycleHash(row.permissions) !== lifecycleHash(expected))
          throw new Error('ROLLBACK_PERMISSIONS_CHANGED');
        if (role.permissionsFieldMissing) delete restored.permissions;
        else restored.permissions = role.existingPermissions;
      }
      if (lifecycleHash(restored) !== before)
        throw new Error('ROLLBACK_BUSINESS_OR_AUTHORITY_CHANGED');
      restores.push({
        collection,
        id: row._id,
        unset: Object.keys(update?.set ?? {}),
        role,
      });
    }
  if (
    Object.values(current).reduce((count, rows) => count + rows.length, 0) !==
    original.rowFingerprints.length
  )
    throw new Error('ROLLBACK_RECORDS_MISSING');
  return restores;
}
export async function runMembershipLifecycleMigration({
  uri = process.env.MONGODB_URI,
  databaseName = resolveIamDatabaseName({
    mongodbEnabled: process.env.MONGODB_ENABLED,
    infraEnabled: process.env.INFRA_ENABLED,
    configuredName: process.env.MONGODB_DATABASE,
  }),
  mode = 'dry-run',
  writersStopped = false,
  expectedReportSha256,
  rollbackReport,
  testHooks,
} = {}) {
  if (
    !uri ||
    !/^mongodb(?:\+srv)?:\/\//.test(uri) ||
    databaseName === 'continuum_db'
  )
    throw new Error('IAM_TARGET_REQUIRED_NO_LEGACY_FALLBACK');
  if (!['dry-run', 'apply', 'rollback'].includes(mode))
    throw new Error('INVALID_MIGRATION_MODE');
  if (mode !== 'dry-run' && !writersStopped)
    throw new Error('IAM_WRITERS_MUST_BE_STOPPED');
  if (mode !== 'dry-run' && !/^[a-f\d]{64}$/.test(expectedReportSha256 ?? ''))
    throw new Error('REVIEWED_REPORT_HASH_REQUIRED');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db(databaseName);
    const initial = await inspect(db, uri);
    if (mode === 'dry-run') return initial.report;
    if (expectedReportSha256 !== initial.report.reportSha256)
      throw new Error('REVIEWED_REPORT_HASH_CHANGED');
    if (!initial.report.clean) throw new Error('MIGRATION_PREFLIGHT_BLOCKED');
    const hello = await client.db('admin').command({ hello: 1 });
    const build = await client.db('admin').command({ buildInfo: 1 });
    if (
      !hello.setName ||
      !hello.isWritablePrimary ||
      build.versionArray[0] !== 7
    )
      throw new Error('MONGO7_WRITABLE_REPLICA_SET_REQUIRED');
    if (mode === 'apply') {
      // Index DDL is additive, deliberately outside the metadata transaction.
      for (const entry of initial.report.indexes.filter(
        (row) => row.action === 'CREATE',
      )) {
        const { key, ...options } = entry.spec;
        await db.collection(entry.collection).createIndex(key, options);
      }
    } else assertRollback(initial.snapshot, rollbackReport);
    const session = client.startSession();
    try {
      await session.withTransaction(
        async () => {
          const inspected = await inspect(
            db,
            uri,
            session,
            initial.snapshot.objects,
          );
          if (inspected.report.reportSha256 !== initial.report.reportSha256)
            throw new Error('REVIEWED_REPORT_HASH_CHANGED_DURING_APPLY');
          let writes = 0;
          if (mode === 'apply') {
            for (const update of initial.report.updates) {
              const match = {
                _id: new ObjectId(update.id),
                ...Object.fromEntries(
                  Object.keys(update.set).map((field) => [
                    field,
                    { $exists: false },
                  ]),
                ),
              };
              const result = await db
                .collection(update.collection)
                .updateOne(match, { $set: update.set }, { session });
              if (result.matchedCount !== 1)
                throw new Error('TRACKING_CAS_CONFLICT');
              await testHooks?.afterWrite?.(++writes);
            }
            for (const role of initial.report.permissionAdditions.filter(
              (row) => row.missingPermissions.length,
            )) {
              const result = await db.collection('roles').updateOne(
                {
                  _id: new ObjectId(role.id),
                  code: 'ADMIN',
                  isSystem: true,
                  permissions: role.permissionsFieldMissing
                    ? { $exists: false }
                    : role.existingPermissions,
                },
                {
                  $addToSet: {
                    permissions: { $each: role.missingPermissions },
                  },
                },
                { session },
              );
              if (result.matchedCount !== 1)
                throw new Error('ADMIN_PERMISSION_CAS_CONFLICT');
              await testHooks?.afterWrite?.(++writes);
            }
          } else {
            for (const restore of assertRollback(
              inspected.snapshot,
              rollbackReport,
            )) {
              const row = byId(
                inspected.snapshot,
                restore.collection,
                restore.id,
              );
              const match = {
                _id: new ObjectId(restore.id),
                ...Object.fromEntries(
                  restore.unset.map((field) => [
                    field,
                    Object.hasOwn(row, field) ? row[field] : { $exists: false },
                  ]),
                ),
              };
              const changes = {};
              if (restore.unset.length)
                changes.$unset = Object.fromEntries(
                  restore.unset.map((field) => [field, '']),
                );
              if (restore.role) {
                match.permissions = row.permissions;
                if (restore.role.permissionsFieldMissing) {
                  changes.$unset ??= {};
                  changes.$unset.permissions = '';
                } else
                  changes.$set = {
                    permissions: restore.role.existingPermissions,
                  };
              }
              const result = await db
                .collection(restore.collection)
                .updateOne(match, changes, { session });
              if (result.matchedCount !== 1)
                throw new Error('ROLLBACK_CAS_CONFLICT');
              await testHooks?.afterWrite?.(++writes);
            }
          }
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
        },
      );
    } finally {
      await session.endSession();
    }
    const verified = await inspect(db, uri);
    if (
      mode === 'apply' &&
      (!verified.report.clean ||
        verified.report.updates.length ||
        verified.report.permissionAdditions.some(
          (row) => row.missingPermissions.length,
        ))
    )
      throw new Error(
        'POST_APPLY_VERIFICATION_FAILED_FORWARD_RECOVERY_REQUIRED',
      );
    if (
      mode === 'rollback' &&
      assertRollback(verified.snapshot, rollbackReport).length
    )
      throw new Error('POST_ROLLBACK_VERIFICATION_FAILED');
    return { ...verified.report, mode, additiveIndexesRetained: true };
  } finally {
    await client.close();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const hash = args
    .find((arg) => arg.startsWith('--expected-report-sha256='))
    ?.split('=')[1];
  const reportFile = args
    .find((arg) => arg.startsWith('--rollback-report='))
    ?.slice('--rollback-report='.length);
  try {
    if (
      args.some(
        (arg) =>
          !['--apply', '--rollback', '--iam-writers-stopped'].includes(arg) &&
          !arg.startsWith('--expected-report-sha256=') &&
          !arg.startsWith('--rollback-report='),
      ) ||
      (args.includes('--apply') && args.includes('--rollback'))
    )
      throw new Error('INVALID_ARGUMENTS');
    const result = await runMembershipLifecycleMigration({
      mode: args.includes('--rollback')
        ? 'rollback'
        : args.includes('--apply')
          ? 'apply'
          : 'dry-run',
      writersStopped: args.includes('--iam-writers-stopped'),
      expectedReportSha256: hash,
      rollbackReport: reportFile
        ? JSON.parse(await readFile(reportFile, 'utf8'))
        : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch {
    console.error(
      'Membership lifecycle migration failed; verify IAM target, writers stopped, clean reviewed hash and recovery prerequisites. No credentials or documents logged.',
    );
    process.exitCode = 1;
  }
}
