import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';

export const DATABASE = 'continuum_capture';
export const OLD_INDEX = 'work_reports_member_period_unique';
export const NEW_INDEX = 'work_reports_member_scope_period_unique';
export const OLD_KEY = { projectId: 1, memberUserId: 1, periodStart: 1 };
export const NEW_KEY = {
  projectId: 1,
  memberUserId: 1,
  reportScope: 1,
  periodStart: 1,
};

export function planWorkReportScopeIndex({
  databaseName,
  indexes,
  legacyCount,
}) {
  if (databaseName !== DATABASE) throw new Error(`Expected ${DATABASE}`);
  const old = indexes.find((item) => item.name === OLD_INDEX);
  const next = indexes.find((item) => item.name === NEW_INDEX);
  if (
    old &&
    (!old.unique || JSON.stringify(old.key) !== JSON.stringify(OLD_KEY))
  ) {
    throw new Error('Old work report index has an unexpected definition');
  }
  if (
    next &&
    (!next.unique || JSON.stringify(next.key) !== JSON.stringify(NEW_KEY))
  ) {
    throw new Error('New work report index has an unexpected definition');
  }
  return {
    databaseName,
    legacyCount,
    backfill: legacyCount > 0,
    create: !next,
    drop: Boolean(old),
  };
}

export async function migrateWorkReportScopeIndex(db, apply = false) {
  if (db.databaseName !== DATABASE) throw new Error(`Expected ${DATABASE}`);
  const collection = db.collection('work_reports');
  const indexes = await collection.indexes();
  const legacyCount = await collection.countDocuments({
    reportScope: { $exists: false },
  });
  const plan = planWorkReportScopeIndex({
    databaseName: db.databaseName,
    indexes,
    legacyCount,
  });
  if (!apply) return plan;
  if (plan.backfill) {
    await collection.updateMany(
      { reportScope: { $exists: false } },
      { $set: { reportScope: 'MEMBER' } },
    );
  }
  if (plan.create)
    await collection.createIndex(NEW_KEY, { unique: true, name: NEW_INDEX });
  if (plan.drop) await collection.dropIndex(OLD_INDEX);
  return plan;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const apply = process.argv.includes('--apply');
  if (apply && !process.argv.includes('--writes-paused')) {
    throw new Error('Apply requires --writes-paused');
  }
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  const connection = mongoose.createConnection(process.env.MONGODB_URI, {
    dbName: DATABASE,
    autoIndex: false,
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await connection.asPromise();
    const plan = await migrateWorkReportScopeIndex(connection.db, apply);
    process.stdout.write(`${JSON.stringify({ ...plan, applied: apply })}\n`);
  } finally {
    await connection.close();
  }
}
