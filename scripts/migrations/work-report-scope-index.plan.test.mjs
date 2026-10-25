import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATABASE,
  NEW_INDEX,
  NEW_KEY,
  OLD_INDEX,
  OLD_KEY,
  planWorkReportScopeIndex,
} from './20261025-work-report-scope-index.mjs';

test('plans backfill, new unique index, and removal of the old index', () => {
  assert.deepEqual(
    planWorkReportScopeIndex({
      databaseName: DATABASE,
      indexes: [{ name: OLD_INDEX, key: OLD_KEY, unique: true }],
      legacyCount: 3,
    }),
    {
      databaseName: DATABASE,
      legacyCount: 3,
      backfill: true,
      create: true,
      drop: true,
    },
  );
});

test('is idempotent and rejects a conflicting index', () => {
  assert.deepEqual(
    planWorkReportScopeIndex({
      databaseName: DATABASE,
      indexes: [{ name: NEW_INDEX, key: NEW_KEY, unique: true }],
      legacyCount: 0,
    }),
    {
      databaseName: DATABASE,
      legacyCount: 0,
      backfill: false,
      create: false,
      drop: false,
    },
  );
  assert.throws(() =>
    planWorkReportScopeIndex({
      databaseName: DATABASE,
      indexes: [{ name: NEW_INDEX, key: { projectId: 1 }, unique: true }],
      legacyCount: 0,
    }),
  );
  assert.throws(() =>
    planWorkReportScopeIndex({
      databaseName: DATABASE,
      indexes: [{ name: OLD_INDEX, key: { projectId: 1 }, unique: true }],
      legacyCount: 0,
    }),
  );
});
