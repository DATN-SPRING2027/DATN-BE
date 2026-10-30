import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';

export const DATABASE = 'continuum_capture';

export const LEGACY_SETTINGS_UNIQUE_INDEX =
  'work_report_settings_project_effective_unique';
export const LEGACY_SETTINGS_UNIQUE_KEY = Object.freeze({
  projectId: 1,
  effectiveAt: 1,
});

export const LEGACY_REPORTS_UNIQUE_INDEX = 'work_reports_member_period_unique';
export const LEGACY_REPORTS_UNIQUE_KEY = Object.freeze({
  projectId: 1,
  memberUserId: 1,
  periodStart: 1,
});

export const TARGET_INDEXES = Object.freeze({
  work_reports: Object.freeze([
    Object.freeze({
      name: 'work_reports_member_scope_period_unique',
      key: Object.freeze({
        projectId: 1,
        memberUserId: 1,
        reportScope: 1,
        periodStart: 1,
      }),
      unique: true,
    }),
    Object.freeze({
      name: 'work_reports_project_scope_status_period',
      key: Object.freeze({
        organizationId: 1,
        projectId: 1,
        reportScope: 1,
        status: 1,
        periodStart: -1,
      }),
      unique: false,
    }),
    Object.freeze({
      name: 'work_reports_project_scope_member_period',
      key: Object.freeze({
        organizationId: 1,
        projectId: 1,
        reportScope: 1,
        memberUserId: 1,
        periodStart: -1,
      }),
      unique: false,
    }),
  ]),
  work_report_settings: Object.freeze([
    Object.freeze({
      name: 'work_report_settings_project_scope_effective_unique',
      key: Object.freeze({
        projectId: 1,
        reportScope: 1,
        effectiveAt: 1,
      }),
      unique: true,
    }),
    Object.freeze({
      name: 'work_report_settings_project_scope_history',
      key: Object.freeze({
        organizationId: 1,
        projectId: 1,
        reportScope: 1,
        effectiveAt: -1,
      }),
      unique: false,
    }),
  ]),
});

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function sameKey(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateExistingIndexList(collectionName, existingIndexes, targets) {
  const indexesToCreate = [];
  for (const target of targets) {
    const byName = existingIndexes.find((item) => item.name === target.name);
    const byKey = existingIndexes.find((item) => sameKey(item.key, target.key));
    if (byName && !sameKey(byName.key, target.key)) {
      throw new Error(
        `Index name conflict on ${collectionName}.${target.name}`,
      );
    }
    if (byKey) {
      if (Boolean(byKey.unique) !== Boolean(target.unique)) {
        throw new Error(
          `Index unique option conflict on ${collectionName}.${byKey.name}`,
        );
      }
      continue;
    }
    indexesToCreate.push({
      collection: collectionName,
      name: target.name,
      key: target.key,
      unique: target.unique,
    });
  }
  return indexesToCreate;
}

export function planWorkReportGovernanceSchema({
  databaseName,
  reportIndexes = [],
  settingsIndexes = [],
  legacyReportsMissingScopeCount = 0,
  legacySettingsMissingScopeCount = 0,
  duplicateReportScopeKeysCount = 0,
  duplicateSettingsScopeKeysCount = 0,
}) {
  if (databaseName !== DATABASE) {
    throw new Error(`Expected database ${DATABASE}, got ${databaseName}`);
  }
  if (duplicateReportScopeKeysCount > 0) {
    throw new Error(
      `Found ${duplicateReportScopeKeysCount} duplicate work_reports (projectId, memberUserId, reportScope, periodStart) key groups`,
    );
  }
  if (duplicateSettingsScopeKeysCount > 0) {
    throw new Error(
      `Found ${duplicateSettingsScopeKeysCount} duplicate work_report_settings (projectId, reportScope, effectiveAt) key groups`,
    );
  }

  const legacyReportUnique = reportIndexes.find(
    (item) => item.name === LEGACY_REPORTS_UNIQUE_INDEX,
  );
  if (
    legacyReportUnique &&
    (!legacyReportUnique.unique ||
      !sameKey(legacyReportUnique.key, LEGACY_REPORTS_UNIQUE_KEY))
  ) {
    throw new Error(
      `Legacy index ${LEGACY_REPORTS_UNIQUE_INDEX} has an unexpected definition`,
    );
  }

  const legacySettingsUnique = settingsIndexes.find(
    (item) => item.name === LEGACY_SETTINGS_UNIQUE_INDEX,
  );
  if (
    legacySettingsUnique &&
    (!legacySettingsUnique.unique ||
      !sameKey(legacySettingsUnique.key, LEGACY_SETTINGS_UNIQUE_KEY))
  ) {
    throw new Error(
      `Legacy index ${LEGACY_SETTINGS_UNIQUE_INDEX} has an unexpected definition`,
    );
  }

  const indexesToCreate = [
    ...validateExistingIndexList(
      'work_reports',
      reportIndexes,
      TARGET_INDEXES.work_reports,
    ),
    ...validateExistingIndexList(
      'work_report_settings',
      settingsIndexes,
      TARGET_INDEXES.work_report_settings,
    ),
  ];

  const indexesToDrop = [];
  if (legacyReportUnique) {
    indexesToDrop.push({
      collection: 'work_reports',
      name: LEGACY_REPORTS_UNIQUE_INDEX,
    });
  }
  if (legacySettingsUnique) {
    indexesToDrop.push({
      collection: 'work_report_settings',
      name: LEGACY_SETTINGS_UNIQUE_INDEX,
    });
  }

  return {
    databaseName,
    legacyReportsMissingScopeCount,
    legacySettingsMissingScopeCount,
    backfillReports: legacyReportsMissingScopeCount > 0,
    backfillSettings: legacySettingsMissingScopeCount > 0,
    indexesToCreate,
    indexesToDrop,
  };
}

async function collectionExists(db, collectionName) {
  return db
    .listCollections({ name: collectionName }, { nameOnly: true })
    .hasNext();
}

async function countNormalizedDuplicateGroups(collection, fieldsWithFallback) {
  const groupId = Object.fromEntries(
    Object.entries(fieldsWithFallback).map(([field, fallback]) => [
      field,
      fallback === undefined
        ? `$${field}`
        : { $ifNull: [`$${field}`, fallback] },
    ]),
  );
  const duplicates = await collection
    .aggregate([
      { $group: { _id: groupId, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 5 },
    ])
    .toArray();
  return duplicates.length;
}

export async function migrateWorkReportGovernanceSchema(db, apply = false) {
  if (db.databaseName !== DATABASE) {
    throw new Error(`Expected database ${DATABASE}, got ${db.databaseName}`);
  }

  const reportsExist = await collectionExists(db, 'work_reports');
  const settingsExist = await collectionExists(db, 'work_report_settings');

  const reports = db.collection('work_reports');
  const settings = db.collection('work_report_settings');

  const missingScopeFilter = {
    $or: [{ reportScope: { $exists: false } }, { reportScope: null }],
  };

  const [
    reportIndexes,
    settingsIndexes,
    legacyReportsMissingScopeCount,
    legacySettingsMissingScopeCount,
    duplicateReportScopeKeysCount,
    duplicateSettingsScopeKeysCount,
  ] = await Promise.all([
    reportsExist ? reports.indexes() : Promise.resolve([]),
    settingsExist ? settings.indexes() : Promise.resolve([]),
    reportsExist
      ? reports.countDocuments(missingScopeFilter)
      : Promise.resolve(0),
    settingsExist
      ? settings.countDocuments(missingScopeFilter)
      : Promise.resolve(0),
    reportsExist
      ? countNormalizedDuplicateGroups(reports, {
          projectId: undefined,
          memberUserId: undefined,
          reportScope: 'MEMBER',
          periodStart: undefined,
        })
      : Promise.resolve(0),
    settingsExist
      ? countNormalizedDuplicateGroups(settings, {
          projectId: undefined,
          reportScope: 'MEMBER',
          effectiveAt: undefined,
        })
      : Promise.resolve(0),
  ]);

  const plan = planWorkReportGovernanceSchema({
    databaseName: db.databaseName,
    reportIndexes,
    settingsIndexes,
    legacyReportsMissingScopeCount,
    legacySettingsMissingScopeCount,
    duplicateReportScopeKeysCount,
    duplicateSettingsScopeKeysCount,
  });

  if (!apply) {
    return { ...plan, applied: false };
  }

  if (plan.backfillReports) {
    await reports.updateMany(missingScopeFilter, {
      $set: { reportScope: 'MEMBER' },
    });
  }

  if (plan.backfillSettings) {
    await settings.updateMany(missingScopeFilter, [
      {
        $set: {
          reportScope: 'MEMBER',
          updatedByUserId: {
            $ifNull: ['$updatedByUserId', '$createdByUserId'],
          },
        },
      },
    ]);
  }

  for (const item of plan.indexesToCreate) {
    await db.collection(item.collection).createIndex(item.key, {
      name: item.name,
      ...(item.unique ? { unique: true } : {}),
    });
  }

  for (const item of plan.indexesToDrop) {
    await db.collection(item.collection).dropIndex(item.name);
  }

  return { ...plan, applied: true };
}

export function validateMigrationCliOptions(args, env) {
  const allowedFlags = new Set([
    '--apply',
    '--writes-paused',
    '--allow-shared-database',
  ]);
  for (const arg of args) {
    if (!allowedFlags.has(arg)) {
      throw new Error(`Unknown migration argument: ${arg}`);
    }
  }

  const apply = args.includes('--apply');
  const uri = env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is required');
  }

  const parsed = new URL(uri);
  const authority = uri.slice(uri.indexOf('://') + 3).split(/[/?#]/, 1)[0];
  if (
    !['mongodb:', 'mongodb+srv:'].includes(parsed.protocol) ||
    authority.includes(',') ||
    !parsed.hostname
  ) {
    throw new Error('A valid single-entry MongoDB URI is required');
  }

  if (apply) {
    if (!args.includes('--writes-paused')) {
      throw new Error('Applying schema/index changes requires --writes-paused');
    }
    if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
      if (
        !args.includes('--allow-shared-database') ||
        env.WORK_NOTE_MIGRATION_CONFIRM_DATABASE !== DATABASE
      ) {
        throw new Error(
          `Applying against non-loopback target requires --allow-shared-database and WORK_NOTE_MIGRATION_CONFIRM_DATABASE=${DATABASE}`,
        );
      }
    }
  }

  return { apply, uri };
}

async function runCli() {
  const { apply, uri } = validateMigrationCliOptions(
    process.argv.slice(2),
    process.env,
  );
  const connection = mongoose.createConnection(uri, {
    dbName: DATABASE,
    autoIndex: false,
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await connection.asPromise();
    const report = await migrateWorkReportGovernanceSchema(
      connection.db,
      apply,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await connection.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

