import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DATABASE,
  LEGACY_REPORTS_UNIQUE_INDEX,
  LEGACY_REPORTS_UNIQUE_KEY,
  LEGACY_SETTINGS_UNIQUE_INDEX,
  LEGACY_SETTINGS_UNIQUE_KEY,
  planWorkReportGovernanceSchema,
  TARGET_INDEXES,
  validateMigrationCliOptions,
} from './20261030-work-report-governance-schema.mjs';

test('plans backfill, new scoped indexes, and legacy unique index replacement', () => {
  const plan = planWorkReportGovernanceSchema({
    databaseName: DATABASE,
    reportIndexes: [
      {
        name: LEGACY_REPORTS_UNIQUE_INDEX,
        key: LEGACY_REPORTS_UNIQUE_KEY,
        unique: true,
      },
    ],
    settingsIndexes: [
      {
        name: LEGACY_SETTINGS_UNIQUE_INDEX,
        key: LEGACY_SETTINGS_UNIQUE_KEY,
        unique: true,
      },
    ],
    legacyReportsMissingScopeCount: 4,
    legacySettingsMissingScopeCount: 2,
    duplicateReportScopeKeysCount: 0,
    duplicateSettingsScopeKeysCount: 0,
  });

  assert.equal(plan.databaseName, DATABASE);
  assert.equal(plan.backfillReports, true);
  assert.equal(plan.backfillSettings, true);
  assert.equal(plan.indexesToCreate.length, 5);
  assert.deepEqual(plan.indexesToDrop, [
    { collection: 'work_reports', name: LEGACY_REPORTS_UNIQUE_INDEX },
    {
      collection: 'work_report_settings',
      name: LEGACY_SETTINGS_UNIQUE_INDEX,
    },
  ]);
});

test('is idempotent when all target indexes exist and legacy indexes are absent', () => {
  const plan = planWorkReportGovernanceSchema({
    databaseName: DATABASE,
    reportIndexes: TARGET_INDEXES.work_reports.map((item) => ({ ...item })),
    settingsIndexes: TARGET_INDEXES.work_report_settings.map((item) => ({
      ...item,
    })),
    legacyReportsMissingScopeCount: 0,
    legacySettingsMissingScopeCount: 0,
    duplicateReportScopeKeysCount: 0,
    duplicateSettingsScopeKeysCount: 0,
  });

  assert.deepEqual(plan, {
    databaseName: DATABASE,
    legacyReportsMissingScopeCount: 0,
    legacySettingsMissingScopeCount: 0,
    backfillReports: false,
    backfillSettings: false,
    indexesToCreate: [],
    indexesToDrop: [],
  });
});

test('rejects wrong database, duplicate scope keys, or conflicting index definitions', () => {
  assert.throws(
    () =>
      planWorkReportGovernanceSchema({
        databaseName: 'continuum_iam',
      }),
    /Expected database continuum_capture/,
  );

  assert.throws(
    () =>
      planWorkReportGovernanceSchema({
        databaseName: DATABASE,
        duplicateSettingsScopeKeysCount: 1,
      }),
    /duplicate work_report_settings/,
  );

  assert.throws(
    () =>
      planWorkReportGovernanceSchema({
        databaseName: DATABASE,
        settingsIndexes: [
          {
            name: 'work_report_settings_project_scope_effective_unique',
            key: { projectId: 1 },
            unique: true,
          },
        ],
      }),
    /Index name conflict/,
  );
});

test('enforces writes-paused and shared-database confirmation guards on CLI apply', () => {
  assert.throws(
    () =>
      validateMigrationCliOptions(['--apply'], {
        MONGODB_URI: 'mongodb://127.0.0.1:27017',
      }),
    /--writes-paused/,
  );

  assert.throws(
    () =>
      validateMigrationCliOptions(['--apply', '--writes-paused'], {
        MONGODB_URI: 'mongodb+srv://user:pass@cluster0.example.mongodb.net',
      }),
    /--allow-shared-database/,
  );

  const validShared = validateMigrationCliOptions(
    ['--apply', '--writes-paused', '--allow-shared-database'],
    {
      MONGODB_URI: 'mongodb+srv://user:pass@cluster0.example.mongodb.net',
      WORK_NOTE_MIGRATION_CONFIRM_DATABASE: DATABASE,
    },
  );
  assert.equal(validShared.apply, true);
});

