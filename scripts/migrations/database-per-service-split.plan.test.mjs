import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDatabasePerServiceSplitReport,
  ownerForCollection,
} from './database-per-service-split.plan.mjs';

test('maps domain collections and audit collections to their owning databases', () => {
  assert.equal(ownerForCollection('projects'), 'continuum_iam');
  assert.equal(ownerForCollection('work_notes'), 'continuum_capture');
  assert.equal(ownerForCollection('jira_issues'), 'continuum_jira');
  assert.equal(ownerForCollection('audit_logs_iam'), 'continuum_audit');
});

test('reports every source document and is clean when all destinations are empty and owned', () => {
  const report = buildDatabasePerServiceSplitReport({
    sourceCollections: [
      {
        name: 'projects',
        documents: [
          { _id: 'p1', digest: 'a' },
          { _id: 'p2', digest: 'b' },
        ],
        indexes: [{ name: '_id_', key: { _id: 1 } }],
      },
      {
        name: 'audit_logs_iam',
        documents: [{ _id: 'a1', digest: 'c' }],
        indexes: [{ name: '_id_', key: { _id: 1 } }],
      },
    ],
    targetCollections: {},
  });

  assert.equal(report.clean, true);
  assert.equal(report.counts.documentsToInsert, 3);
  assert.deepEqual(
    report.documents.map((item) => item.id).sort(),
    ['a1', 'p1', 'p2'],
  );
});

test('produces the same report regardless of input collection and document order', () => {
  const sourceCollections = [
    { name: 'projects', documents: [{ _id: 'p2', digest: 'b' }, { _id: 'p1', digest: 'a' }] },
    { name: 'users', documents: [{ _id: 'u1', digest: 'c' }] },
  ];
  const targetCollections = {
    continuum_iam: {
      projects: {
        name: 'projects',
        documents: [{ _id: 'p3', digest: 'd' }],
      },
    },
  };
  const first = buildDatabasePerServiceSplitReport({
    sourceCollections,
    targetCollections,
  });
  const reversed = buildDatabasePerServiceSplitReport({
    sourceCollections: [...sourceCollections].reverse().map((collection) => ({
      ...collection,
      documents: [...collection.documents].reverse(),
    })),
    targetCollections: {
      continuum_iam: {
        projects: {
          name: 'projects',
          documents: [{ _id: 'p3', digest: 'd' }],
        },
      },
    },
  });

  assert.deepEqual(reversed, first);
});

test('allows exact reruns and blocks conflicting IDs or ownerless outbox data', () => {
  const report = buildDatabasePerServiceSplitReport({
    sourceCollections: [
      { name: 'projects', documents: [{ _id: 'p1', digest: 'same' }] },
      { name: 'outbox_events', documents: [{ _id: 'o1', digest: 'event' }] },
    ],
    targetCollections: {
      continuum_iam: {
        projects: {
          name: 'projects',
          documents: [{ _id: 'p1', digest: 'same' }],
        },
      },
    },
  });

  assert.equal(report.clean, false);
  assert.equal(report.counts.identicalExistingDocuments, 1);
  assert.equal(report.unmappedCollections[0].collection, 'outbox_events');
  assert.equal(report.unmappedCollections[0].documentIds[0], 'o1');
});

test('blocks a destination document with the same ID but different contents', () => {
  const report = buildDatabasePerServiceSplitReport({
    sourceCollections: [
      { name: 'projects', documents: [{ _id: 'p1', digest: 'source' }] },
    ],
    targetCollections: {
      continuum_iam: {
        projects: {
          name: 'projects',
          documents: [{ _id: 'p1', digest: 'different' }],
        },
      },
    },
  });

  assert.equal(report.clean, false);
  assert.equal(report.conflictingCollections[0].documentId, 'p1');
});

test('reports unique-index collisions across source and destination before copying', () => {
  const report = buildDatabasePerServiceSplitReport({
    sourceCollections: [
      {
        name: 'users',
        indexes: [
          { name: '_id_', key: { _id: 1 }, unique: true },
          { name: 'email_1', key: { email: 1 }, unique: true },
        ],
        documents: [
          { _id: 'source-user', digest: 'source', raw: { email: 'same@example.test' } },
        ],
      },
    ],
    targetCollections: {
      continuum_iam: {
        users: {
          name: 'users',
          indexes: [
            { name: '_id_', key: { _id: 1 }, unique: true },
            { name: 'email_1', key: { email: 1 }, unique: true },
          ],
          documents: [
            { _id: 'target-user', digest: 'target', raw: { email: 'same@example.test' } },
          ],
        },
      },
    },
  });

  assert.equal(report.clean, false);
  assert.equal(report.uniqueIndexConflicts.length, 1);
  assert.equal(report.uniqueIndexConflicts[0].index, 'email_1');
  assert.deepEqual(report.uniqueIndexConflicts[0].documentIds, [
    'source-user',
    'target-user',
  ]);
});

test('blocks unsupported unique-index preflight and incompatible target indexes', () => {
  const report = buildDatabasePerServiceSplitReport({
    sourceCollections: [
      {
        name: 'users',
        indexes: [
          { name: '_id_', key: { _id: 1 }, unique: true },
          {
            name: 'email_partial',
            key: { email: 1 },
            unique: true,
            partialFilterExpression: { email: { $exists: true } },
          },
        ],
        documents: [{ _id: 'u1', digest: 'source', raw: { email: 'u@example.test' } }],
      },
    ],
    targetCollections: {
      continuum_iam: {
        users: {
          name: 'users',
          indexes: [
            { name: '_id_', key: { _id: 1 }, unique: true },
            { name: 'email_partial', key: { email: 1 }, unique: true },
          ],
          documents: [],
        },
      },
    },
  });

  assert.equal(report.clean, false);
  assert.equal(report.blockingIndexDifferences.length, 1);
  assert.equal(report.unverifiableUniqueIndexes.length, 1);
});

test('treats missing and null unique keys as collisions and blocks non-simple collations', () => {
  const report = buildDatabasePerServiceSplitReport({
    sourceCollections: [
      {
        name: 'users',
        indexes: [
          { name: '_id_', key: { _id: 1 }, unique: true },
          { name: 'email_1', key: { email: 1 }, unique: true },
          {
            name: 'email_ci',
            key: { email: 1 },
            unique: true,
            collation: { locale: 'en', strength: 2 },
          },
        ],
        documents: [
          { _id: 'u1', digest: '1', raw: { _id: 'u1' } },
          { _id: 'u2', digest: '2', raw: { _id: 'u2', email: null } },
        ],
      },
    ],
    targetCollections: {},
  });

  assert.equal(report.clean, false);
  assert.ok(report.uniqueIndexConflicts.some((row) => row.index === 'email_1'));
  assert.ok(
    report.unverifiableUniqueIndexes.some((row) => row.reason.includes('collation')),
  );
});
