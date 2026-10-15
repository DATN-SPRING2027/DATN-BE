import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { targetFingerprint } from './organization-membership-backfill.plan.mjs';
import {
  MigrationScanBudget,
  MIGRATION_SCAN_LIMITS,
} from './migration-scan-budget.mjs';
import {
  planTeamFoundationRuntime,
  publicTeamFoundationRuntimeReport,
  TEAM_FOUNDATION_AUDIT_DATABASE,
  TEAM_FOUNDATION_IAM_DATABASE,
} from './team-foundation-runtime.plan.mjs';

const { MongoClient, BSON } = mongoose.mongo;
const teamProjection = {
  _id: 1,
  organizationId: 1,
  projectId: 1,
  name: 1,
  code: 1,
  description: 1,
  status: 1,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  archivedAt: 1,
  archivedBy: 1,
  archivedReason: 1,
};
const operationProjection = {
  organizationId: 1,
  actorUserId: 1,
  keyHash: 1,
};

async function collectionObject(db, name) {
  const [entry] = await db.listCollections({ name }).toArray();
  if (!entry) return null;
  return {
    type: entry.type,
    options: entry.options,
    indexes:
      entry.type === 'collection'
        ? await db.collection(name).listIndexes().toArray()
        : [],
  };
}

async function readRows(db, name, projection, budget) {
  const object = await collectionObject(db, name);
  if (object?.type !== 'collection') return { object, rows: [] };
  const cursor = db
    .collection(name)
    .find({}, { projection })
    .sort({ _id: 1 })
    .batchSize(MIGRATION_SCAN_LIMITS.cursorBatchSize);
  const rows = [];
  try {
    for await (const row of cursor) {
      budget.addDocument(
        Buffer.byteLength(BSON.EJSON.stringify(row, { relaxed: false })),
      );
      rows.push(row);
    }
  } finally {
    await cursor.close();
  }
  return { object, rows };
}

export function duplicateGroupPipeline(match, key) {
  const groupKey = Object.fromEntries(
    Object.keys(key).map((field, index) => [
      `field${index}`,
      { $ifNull: [`$${field}`, null] },
    ]),
  );
  return [
    { $match: match },
    {
      $group: {
        _id: groupKey,
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 },
    { $project: { _id: 0, count: 1 } },
  ];
}

async function duplicateCount(collection, match, key) {
  const groups = await collection
    .aggregate(duplicateGroupPipeline(match, key))
    .toArray();
  return groups[0]?.count ?? 0;
}

async function collectSnapshot(client, fingerprint) {
  const iamDb = client.db(TEAM_FOUNDATION_IAM_DATABASE);
  const auditDb = client.db(TEAM_FOUNDATION_AUDIT_DATABASE);
  if (iamDb.databaseName !== TEAM_FOUNDATION_IAM_DATABASE)
    throw new Error('IAM_TARGET_REQUIRED');
  if (auditDb.databaseName !== TEAM_FOUNDATION_AUDIT_DATABASE)
    throw new Error('AUDIT_TARGET_REQUIRED');

  const budget = new MigrationScanBudget();
  const [teams, organizations, projects, operations] = await Promise.all([
    readRows(iamDb, 'teams', teamProjection, budget),
    readRows(iamDb, 'organizations', { _id: 1 }, budget),
    readRows(iamDb, 'projects', { _id: 1, organizationId: 1 }, budget),
    readRows(iamDb, 'team_operations', operationProjection, budget),
  ]);
  const auditObject = await collectionObject(auditDb, 'audit_logs_iam');
  const duplicateGroups = [];
  if (operations.object?.type === 'collection') {
    const count = await duplicateCount(
      iamDb.collection('team_operations'),
      {},
      { organizationId: 1, actorUserId: 1, keyHash: 1 },
    );
    if (count > 0)
      duplicateGroups.push({
        collection: 'team_operations',
        index: 'team_operation_scope',
        count,
      });
  }
  if (auditObject?.type === 'collection') {
    const count = await duplicateCount(
      auditDb.collection('audit_logs_iam'),
      { targetResource: 'Team', 'metadata.commandId': { $exists: true } },
      {
        organizationId: 1,
        'metadata.commandId': 1,
        action: 1,
        targetResourceId: 1,
      },
    );
    if (count > 0)
      duplicateGroups.push({
        collection: 'audit_logs_iam',
        index: 'team_audit_command_dedupe',
        count,
      });
  }

  return {
    iamDatabaseName: iamDb.databaseName,
    auditDatabaseName: auditDb.databaseName,
    targetFingerprint: fingerprint,
    objects: {
      teams: teams.object,
      organizations: organizations.object,
      projects: projects.object,
      team_operations: operations.object,
    },
    auditObjects: { audit_logs_iam: auditObject },
    teams: teams.rows,
    organizations: organizations.rows,
    projects: projects.rows,
    duplicateGroups,
  };
}

function compareFilterValue(current, expected) {
  if (expected && typeof expected === 'object') {
    if (
      '$exists' in expected &&
      Boolean(expected.$exists) !== (current !== undefined)
    )
      return false;
    if ('$eq' in expected)
      return (
        current !== undefined &&
        BSON.EJSON.stringify(current, { relaxed: false }) ===
          BSON.EJSON.stringify(expected.$eq, { relaxed: false })
      );
    if ('$exists' in expected) return true;
  }
  return (
    BSON.EJSON.stringify(current, { relaxed: false }) ===
    BSON.EJSON.stringify(expected, { relaxed: false })
  );
}

export async function applyTeamFoundationRuntimePlan({ iamDb, auditDb, plan }) {
  if (!plan.clean) throw new Error('MIGRATION_PLAN_NOT_CLEAN');
  for (const update of plan.updates) {
    const collection = iamDb.collection('teams');
    const current = await collection.findOne(
      { _id: update.filter._id },
      { projection: teamProjection },
    );
    if (
      !current ||
      !Object.entries(update.filter).every(([field, expected]) =>
        compareFilterValue(current[field], expected),
      )
    )
      throw new Error('TEAM_CHANGED_AFTER_PREFLIGHT');
    const result = await collection.updateOne(update.filter, {
      $set: update.set,
    });
    if (result.matchedCount !== 1)
      throw new Error('TEAM_CHANGED_DURING_MIGRATION');
  }

  for (const collectionPlan of plan.createCollections) {
    const db =
      collectionPlan.database === TEAM_FOUNDATION_IAM_DATABASE
        ? iamDb
        : auditDb;
    try {
      await db.createCollection(collectionPlan.name);
    } catch (error) {
      if (error?.code !== 48) throw error;
    }
  }

  for (const index of plan.indexesToCreate) {
    const db = index.collection === 'audit_logs_iam' ? auditDb : iamDb;
    const { collection, key, ...options } = index;
    await db.collection(collection).createIndex(key, options);
  }
}

function parseArgs(args) {
  const options = { mode: null, mappingFile: null, expectedHash: null };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run' || argument === '--apply') {
      if (options.mode) throw new Error('ONE_MODE_REQUIRED');
      options.mode = argument.slice(2);
    } else if (argument === '--database') {
      options.database = args[++index];
    } else if (argument.startsWith('--mapping-file=')) {
      options.mappingFile = argument.slice('--mapping-file='.length);
    } else if (argument.startsWith('--expected-report-sha256=')) {
      options.expectedHash = argument.slice('--expected-report-sha256='.length);
    } else {
      throw new Error('UNSUPPORTED_ARGUMENT');
    }
  }
  if (
    !options.mode ||
    options.database !== TEAM_FOUNDATION_IAM_DATABASE ||
    (options.mode === 'apply' &&
      !/^[a-f\d]{64}$/i.test(options.expectedHash ?? '')) ||
    (options.mode === 'dry-run' && options.expectedHash)
  )
    throw new Error('EXPLICIT_MODE_TARGET_AND_REPORT_REQUIRED');
  return options;
}

async function loadMapping(file) {
  if (!file) return { teams: [] };
  const contents = await readFile(path.resolve(file), 'utf8');
  const parsed = BSON.EJSON.parse(contents, { relaxed: false });
  if (!parsed || !Array.isArray(parsed.teams))
    throw new Error('INVALID_MAPPING_FILE');
  return parsed;
}

export async function runTeamFoundationRuntimeMigration(
  args,
  env = process.env,
) {
  const options = parseArgs(args);
  if (!env.MONGODB_URI) throw new Error('MONGODB_URI_REQUIRED');
  const mapping = await loadMapping(options.mappingFile);
  const fingerprint = targetFingerprint(
    env.MONGODB_URI,
    TEAM_FOUNDATION_IAM_DATABASE,
  );
  const client = new MongoClient(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await client.connect();
    const iamDb = client.db(TEAM_FOUNDATION_IAM_DATABASE);
    const auditDb = client.db(TEAM_FOUNDATION_AUDIT_DATABASE);
    let snapshot = await collectSnapshot(client, fingerprint);
    let plan = planTeamFoundationRuntime(snapshot, mapping);
    process.stdout.write(
      `${JSON.stringify(publicTeamFoundationRuntimeReport(plan), null, 2)}\n`,
    );
    if (!plan.clean) return 2;
    if (options.mode === 'dry-run') return 0;
    if (plan.reportSha256 !== options.expectedHash)
      throw new Error('REPORT_HASH_MISMATCH');

    snapshot = await collectSnapshot(client, fingerprint);
    plan = planTeamFoundationRuntime(snapshot, mapping);
    if (!plan.clean || plan.reportSha256 !== options.expectedHash)
      throw new Error('TARGET_CHANGED_AFTER_REVIEW');
    await applyTeamFoundationRuntimePlan({ iamDb, auditDb, plan });

    const verified = planTeamFoundationRuntime(
      await collectSnapshot(client, fingerprint),
      mapping,
    );
    if (
      !verified.clean ||
      verified.updates.length > 0 ||
      verified.indexesToCreate.length > 0
    )
      throw new Error('POST_MIGRATION_VERIFICATION_FAILED');
    process.stdout.write(
      `${JSON.stringify(publicTeamFoundationRuntimeReport(verified), null, 2)}\n`,
    );
    return 0;
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await runTeamFoundationRuntimeMigration(
      process.argv.slice(2),
    );
  } catch {
    process.stderr.write(
      'Team runtime migration stopped before completion. Verify the explicit target, report hash, mapping, permissions, and scan output; credentials and document contents were not logged. Partial idempotent work may require a new dry-run.\n',
    );
    process.exitCode = 1;
  }
}
