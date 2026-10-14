import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { targetFingerprint } from './organization-membership-backfill.plan.mjs';
import {
  MigrationScanBudget,
  MIGRATION_SCAN_LIMITS,
} from './migration-scan-budget.mjs';
import {
  planTeamFoundation,
  TEAM_FOUNDATION_DATABASE,
} from './team-foundation.plan.mjs';

const { MongoClient, BSON } = mongoose.mongo;
export async function inspectTeamFoundation(db, fingerprint) {
  if (db.databaseName !== TEAM_FOUNDATION_DATABASE)
    throw new Error('IAM_TARGET_REQUIRED');
  const objects = {},
    rows = {},
    budget = new MigrationScanBudget();
  for (const name of ['teams', 'organizations', 'projects']) {
    const [object] = await db.listCollections({ name }).toArray();
    objects[name] = object
      ? {
          type: object.type,
          options: object.options,
          indexes:
            object.type === 'collection'
              ? await db.collection(name).listIndexes().toArray()
              : [],
        }
      : null;
    if (object?.type !== 'collection') {
      rows[name] = [];
      continue;
    }
    const projection =
      name === 'organizations'
        ? { _id: 1 }
        : name === 'projects'
          ? { _id: 1, organizationId: 1 }
          : {
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
    const cursor = db
      .collection(name)
      .find({}, { projection })
      .sort({ _id: 1 })
      .batchSize(MIGRATION_SCAN_LIMITS.cursorBatchSize);
    rows[name] = [];
    try {
      for await (const row of cursor) {
        budget.addDocument(Buffer.byteLength(BSON.EJSON.stringify(row)));
        rows[name].push(row);
      }
    } finally {
      await cursor.close();
    }
  }
  const report = planTeamFoundation({
    databaseName: db.databaseName,
    targetFingerprint: fingerprint,
    objects,
    ...rows,
  });
  budget.setReportBytes(Buffer.byteLength(JSON.stringify(report)));
  return report;
}

export async function runTeamFoundationPreflight(args, env = process.env) {
  if (
    args.length !== 3 ||
    args[0] !== '--dry-run' ||
    args[1] !== '--database' ||
    args[2] !== TEAM_FOUNDATION_DATABASE
  )
    throw new Error('DRY_RUN_AND_EXPLICIT_IAM_TARGET_REQUIRED');
  if (!env.MONGODB_URI) throw new Error('MONGODB_URI_REQUIRED');
  const fingerprint = targetFingerprint(
    env.MONGODB_URI,
    TEAM_FOUNDATION_DATABASE,
  );
  const client = new MongoClient(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await client.connect();
    const report = await inspectTeamFoundation(
      client.db(TEAM_FOUNDATION_DATABASE),
      fingerprint,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.clean ? 0 : 2;
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await runTeamFoundationPreflight(process.argv.slice(2));
  } catch {
    process.stderr.write(
      'Team preflight failed; verify explicit dry-run/IAM target, read access and scan budget. No credentials or documents logged.\n',
    );
    process.exitCode = 1;
  }
}
