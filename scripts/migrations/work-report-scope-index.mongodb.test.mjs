import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  DATABASE,
  NEW_INDEX,
  OLD_INDEX,
  migrateWorkReportScopeIndex,
} from './20261025-work-report-scope-index.mjs';

test(
  'backfills legacy reports and permits one report per scope',
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
      const key = {
        projectId: 'project',
        memberUserId: 'leader',
        periodStart: new Date('2026-10-25T00:00:00Z'),
      };
      await reports.createIndex(
        { projectId: 1, memberUserId: 1, periodStart: 1 },
        { unique: true, name: OLD_INDEX },
      );
      await reports.insertOne({ ...key, status: 'APPROVED' });
      const dryRun = await migrateWorkReportScopeIndex(connection.db);
      assert.equal(dryRun.backfill, true);
      assert.equal(dryRun.create, true);
      assert.equal(dryRun.drop, true);
      await migrateWorkReportScopeIndex(connection.db, true);
      assert.equal((await reports.findOne(key)).reportScope, 'MEMBER');
      await reports.insertOne({
        ...key,
        reportScope: 'LEADER',
        status: 'DRAFT',
      });
      assert.equal(await reports.countDocuments(key), 2);
      await assert.rejects(
        reports.insertOne({ ...key, reportScope: 'LEADER' }),
        { code: 11000 },
      );
      assert.ok(
        (await reports.indexes()).some((index) => index.name === NEW_INDEX),
      );
      assert.equal(
        (await migrateWorkReportScopeIndex(connection.db)).create,
        false,
      );
    } finally {
      await connection.close();
      await replicaSet.stop();
    }
  },
);
