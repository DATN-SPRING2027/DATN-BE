import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  DATABASE,
  LEGACY_SETTINGS_UNIQUE_INDEX,
  LEGACY_SETTINGS_UNIQUE_KEY,
  migrateWorkReportGovernanceSchema,
} from './20261030-work-report-governance-schema.mjs';

test(
  'backfills legacy settings & reports, upgrades scoped indexes, and allows MEMBER + LEADER settings at the same effectiveAt',
  { timeout: 120_000 },
  async () => {
    const replicaSet = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: { count: 1 },
    });
    const connection = mongoose.createConnection(replicaSet.getUri(), {
      dbName: DATABASE,
      autoIndex: false,
    });
    try {
      await connection.asPromise();
      const reports = connection.db.collection('work_reports');
      const settings = connection.db.collection('work_report_settings');

      await settings.createIndex(LEGACY_SETTINGS_UNIQUE_KEY, {
        unique: true,
        name: LEGACY_SETTINGS_UNIQUE_INDEX,
      });

      const organizationId = new Types.ObjectId();
      const projectId = new Types.ObjectId();
      const userId = new Types.ObjectId();
      const effectiveAt = new Date('2026-10-26T00:00:00.000Z');

      await settings.insertOne({
        organizationId,
        projectId,
        frequency: 'EVERY_3_DAYS',
        effectiveAt,
        createdByUserId: userId,
        leaderFrequency: 'WEEKLY',
        leaderEffectiveAt: effectiveAt,
        leaderUpdatedByUserId: userId,
      });

      await reports.insertOne({
        organizationId,
        projectId,
        memberUserId: userId,
        frequency: 'EVERY_3_DAYS',
        periodStart: effectiveAt,
        periodEnd: new Date('2026-10-29T00:00:00.000Z'),
        dueAt: new Date('2026-10-29T00:00:00.000Z'),
        status: 'DRAFT',
      });

      const dryRun = await migrateWorkReportGovernanceSchema(
        connection.db,
        false,
      );
      assert.equal(dryRun.applied, false);
      assert.equal(dryRun.backfillReports, true);
      assert.equal(dryRun.backfillSettings, true);
      assert.equal(dryRun.indexesToDrop.length, 1);

      const applied = await migrateWorkReportGovernanceSchema(
        connection.db,
        true,
      );
      assert.equal(applied.applied, true);

      const migratedSetting = await settings.findOne({ projectId });
      assert.equal(migratedSetting.reportScope, 'MEMBER');
      assert.equal(
        String(migratedSetting.updatedByUserId),
        String(userId),
      );

      const migratedReport = await reports.findOne({ projectId });
      assert.equal(migratedReport.reportScope, 'MEMBER');

      // Now LEADER scope can coexist at the exact same (projectId, effectiveAt)
      await settings.insertOne({
        organizationId,
        projectId,
        reportScope: 'LEADER',
        frequency: 'EVERY_2_DAYS',
        effectiveAt,
        createdByUserId: userId,
        updatedByUserId: userId,
      });
      assert.equal(await settings.countDocuments({ projectId }), 2);

      // Duplicate within the same scope is strictly rejected
      await assert.rejects(
        settings.insertOne({
          organizationId,
          projectId,
          reportScope: 'LEADER',
          frequency: 'DAILY',
          effectiveAt,
          createdByUserId: userId,
        }),
        { code: 11000 },
      );

      // Legacy unscoped unique index must be gone
      const finalSettingsIndexes = await settings.indexes();
      assert.equal(
        finalSettingsIndexes.some(
          (idx) => idx.name === LEGACY_SETTINGS_UNIQUE_INDEX,
        ),
        false,
      );
      assert.equal(
        finalSettingsIndexes.some(
          (idx) =>
            idx.name === 'work_report_settings_project_scope_effective_unique',
        ),
        true,
      );

      // Re-running is a complete no-op
      const secondDryRun = await migrateWorkReportGovernanceSchema(
        connection.db,
        false,
      );
      assert.equal(secondDryRun.backfillReports, false);
      assert.equal(secondDryRun.backfillSettings, false);
      assert.deepEqual(secondDryRun.indexesToCreate, []);
      assert.deepEqual(secondDryRun.indexesToDrop, []);
    } finally {
      await connection.close();
      await replicaSet.stop();
    }
  },
);

