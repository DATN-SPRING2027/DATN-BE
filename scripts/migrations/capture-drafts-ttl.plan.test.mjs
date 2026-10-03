import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCaptureDraftsTtlReport,
  CAPTURE_DRAFTS_RETENTION_SECONDS,
  isCaptureDraftTtlEligible,
  validateCaptureDraftsDatabaseName,
} from './capture-drafts-ttl.plan.mjs';

const asOf = new Date('2026-10-03T00:00:00.000Z');
const base = {
  databaseName: 'continuum_db',
  targetFingerprint: 'fixture-fingerprint',
  collectionExists: true,
  documentCount: 0,
  lastSavedAtTypeCounts: [],
  malformedExamples: [],
  alreadyExpiredCount: 0,
  alreadyExpiredExamples: [],
  duplicatePairs: [],
  indexes: [{ name: '_id_', key: { _id: 1 } }],
  dataFingerprint: 'fixture-data-fingerprint',
  asOf,
};

test('plans replacement of the invalid compound index and creation of TTL index', () => {
  const report = buildCaptureDraftsTtlReport({
    ...base,
    indexes: [
      ...base.indexes,
      {
        name: 'userId_1_contextKey_1',
        key: { userId: 1, contextKey: 1 },
        expireAfterSeconds: 0,
      },
    ],
  });

  assert.equal(report.clean, true);
  assert.equal(report.retentionSeconds, 2_592_000);
  assert.equal(report.indexActions.uniqueUserContext, 'REPLACE_LEGACY');
  assert.deepEqual(report.indexActions.legacyUserContextIndexesToDrop, [
    'userId_1_contextKey_1',
  ]);
  assert.equal(report.indexActions.lastSavedAtTtl, 'CREATE');
});

test('reports missing and non-Date values separately and blocks the TTL change', () => {
  const report = buildCaptureDraftsTtlReport({
    ...base,
    documentCount: 3,
    lastSavedAtTypeCounts: [
      { type: 'date', count: 1 },
      { type: 'missing', count: 1 },
      { type: 'string', count: 1 },
    ],
    malformedExamples: [
      { id: 'draft-missing', lastSavedAtType: 'missing' },
      { id: 'draft-string', lastSavedAtType: 'string' },
    ],
  });

  assert.equal(report.clean, false);
  assert.equal(report.counts.missingLastSavedAt, 1);
  assert.equal(report.counts.nonDateLastSavedAt, 1);
  assert.deepEqual(report.problems, [
    'DRAFTS_MISSING_LAST_SAVED_AT',
    'DRAFTS_NON_DATE_LAST_SAVED_AT',
  ]);
  assert.equal(report.malformedExamples.length, 2);
});

test('duplicate user and context pairs block unique-index creation', () => {
  const report = buildCaptureDraftsTtlReport({
    ...base,
    duplicatePairs: [
      { userId: 'user-1', contextKey: 'project-1', count: 2, ids: ['a', 'b'] },
    ],
  });

  assert.equal(report.clean, false);
  assert.ok(report.problems.includes('DUPLICATE_USER_CONTEXT_PAIRS'));
});

test('ambiguous unique-pair collation blocks automatic index replacement', () => {
  const report = buildCaptureDraftsTtlReport({
    ...base,
    indexes: [
      ...base.indexes,
      {
        name: 'userId_1_contextKey_1',
        key: { userId: 1, contextKey: 1 },
        unique: true,
        collation: { locale: 'en', strength: 2 },
      },
    ],
  });

  assert.equal(report.clean, false);
  assert.ok(report.problems.includes('INCOMPATIBLE_INDEXES'));
  assert.deepEqual(report.indexActions.legacyUserContextIndexesToDrop, []);
});

test('hidden or non-simple lastSavedAt indexes do not satisfy the TTL target', () => {
  for (const option of [{ collation: { locale: 'en' } }, { hidden: true }]) {
    const report = buildCaptureDraftsTtlReport({
      ...base,
      indexes: [
        ...base.indexes,
        {
          name: 'lastSavedAt_1',
          key: { lastSavedAt: 1 },
          expireAfterSeconds: CAPTURE_DRAFTS_RETENTION_SECONDS,
          ...option,
        },
      ],
    });

    assert.equal(report.clean, false);
    assert.ok(report.problems.includes('INCOMPATIBLE_INDEXES'));
    assert.equal(report.indexActions.lastSavedAtTtl, 'CREATE');
  }
});

test('an already-correct pair and TTL index are a no-op', () => {
  const report = buildCaptureDraftsTtlReport({
    ...base,
    indexes: [
      ...base.indexes,
      {
        name: 'userId_1_contextKey_1',
        key: { userId: 1, contextKey: 1 },
        unique: true,
      },
      {
        name: 'lastSavedAt_1',
        key: { lastSavedAt: 1 },
        expireAfterSeconds: CAPTURE_DRAFTS_RETENTION_SECONDS,
      },
    ],
  });

  assert.equal(report.clean, true);
  assert.equal(report.indexActions.uniqueUserContext, 'PRESENT');
  assert.equal(report.indexActions.lastSavedAtTtl, 'PRESENT');
});

test('retention uses the current Date value and missing or non-Date values are not eligible', () => {
  const expired = new Date(
    asOf.getTime() - CAPTURE_DRAFTS_RETENTION_SECONDS * 1000 - 1,
  );
  const justWithinRetention = new Date(
    asOf.getTime() - CAPTURE_DRAFTS_RETENTION_SECONDS * 1000 + 1,
  );

  assert.equal(isCaptureDraftTtlEligible(expired, asOf), true);
  assert.equal(isCaptureDraftTtlEligible(justWithinRetention, asOf), false);
  assert.equal(isCaptureDraftTtlEligible(new Date(asOf), asOf), false);
  assert.equal(isCaptureDraftTtlEligible(undefined, asOf), false);
  assert.equal(isCaptureDraftTtlEligible('2026-01-01', asOf), false);
  assert.equal(isCaptureDraftTtlEligible(null, asOf), false);
});

test('migration target is restricted to the legacy source or capture owner database', () => {
  assert.equal(
    validateCaptureDraftsDatabaseName('continuum_db'),
    'continuum_db',
  );
  assert.equal(
    validateCaptureDraftsDatabaseName('continuum_capture'),
    'continuum_capture',
  );
  assert.throws(() => validateCaptureDraftsDatabaseName('continuum_iam'));
});
