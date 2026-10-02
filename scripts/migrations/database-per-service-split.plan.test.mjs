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
  assert.equal(report.counts.targetOnlyCollections, 0);
  assert.equal(report.counts.documentsToInsert, 3);
  assert.deepEqual(report.documents.map((item) => item.id).sort(), [
    'a1',
    'p1',
    'p2',
  ]);
});

test('produces the same report regardless of input collection and document order', () => {
  const sourceCollections = [
    {
      name: 'projects',
      documents: [
        { _id: 'p2', digest: 'b' },
        { _id: 'p1', digest: 'a' },
      ],
    },
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

test('allows an exact existing index definition to be applied idempotently', () => {
  const index = { name: 'email_1', key: { email: 1 }, unique: true };
  const report = buildDatabasePerServiceSplitReport({
    sourceCollections: [
      {
        name: 'users',
        indexes: [{ name: '_id_', key: { _id: 1 }, unique: true }, index],
        documents: [
          { _id: 'u1', digest: 'same', raw: { email: 'u@example.test' } },
        ],
      },
    ],
    targetCollections: {
      continuum_iam: {
        users: {
          name: 'users',
          indexes: [{ name: '_id_', key: { _id: 1 }, unique: true }, index],
          documents: [
            { _id: 'u1', digest: 'same', raw: { email: 'u@example.test' } },
          ],
        },
      },
    },
  });

  assert.equal(report.clean, true);
  assert.equal(report.counts.indexDifferences, 0);
});

test('blocks an equivalent target index when its name differs', () => {
  const report = buildDatabasePerServiceSplitReport({
    sourceCollections: [
      {
        name: 'users',
        indexes: [
          { name: '_id_', key: { _id: 1 }, unique: true },
          { name: 'email_1', key: { email: 1 }, unique: true },
        ],
        documents: [
          { _id: 'u1', digest: 'same', raw: { email: 'u@example.test' } },
        ],
      },
    ],
    targetCollections: {
      continuum_iam: {
        users: {
          name: 'users',
          indexes: [
            { name: '_id_', key: { _id: 1 }, unique: true },
            { name: 'legacy_email', key: { email: 1 }, unique: true },
          ],
          documents: [
            { _id: 'u1', digest: 'same', raw: { email: 'u@example.test' } },
          ],
        },
      },
    },
  });

  assert.equal(report.clean, false);
  assert.equal(report.blockingIndexDifferences.length, 1);
  assert.deepEqual(report.blockingIndexDifferences[0], {
    databaseName: 'continuum_iam',
    collection: 'users',
    index: 'email_1',
    targetIndex: 'legacy_email',
    status: 'EQUIVALENT_TARGET_INDEX_DIFFERENT_NAME',
    source: { name: 'email_1', key: { email: 1 }, unique: true },
    target: { name: 'legacy_email', key: { email: 1 }, unique: true },
  });
});

test('allows same-key indexes with distinct collations and flags same-name option conflicts', () => {
  const report = buildDatabasePerServiceSplitReport({
    sourceCollections: [
      {
        name: 'users',
        indexes: [
          { name: '_id_', key: { _id: 1 }, unique: true },
          {
            name: 'email_case_insensitive',
            key: { email: 1 },
            collation: { locale: 'en', strength: 2 },
          },
          { name: 'status_1', key: { status: 1 }, expireAfterSeconds: 60 },
        ],
        documents: [
          { _id: 'u1', digest: 'same', raw: { email: 'u@example.test' } },
        ],
      },
    ],
    targetCollections: {
      continuum_iam: {
        users: {
          name: 'users',
          indexes: [
            { name: '_id_', key: { _id: 1 }, unique: true },
            { name: 'email_simple', key: { email: 1 } },
            { name: 'status_1', key: { status: 1 }, expireAfterSeconds: 120 },
          ],
          documents: [
            { _id: 'u1', digest: 'same', raw: { email: 'u@example.test' } },
          ],
        },
      },
    },
  });

  assert.equal(report.clean, false);
  assert.ok(
    report.indexDifferences.some(
      (difference) =>
        difference.index === 'email_case_insensitive' &&
        difference.status === 'MISSING_TARGET_INDEX',
    ),
  );
  assert.ok(
    report.indexDifferences.some(
      (difference) =>
        difference.index === 'email_simple' &&
        difference.status === 'EXTRA_TARGET_INDEX_PRESERVED',
    ),
  );
  assert.ok(
    report.blockingIndexDifferences.some(
      (difference) =>
        difference.index === 'status_1' &&
        difference.status === 'INCOMPATIBLE_TARGET_INDEX',
    ),
  );
});

test('blocks MongoDB-incompatible TTL options under a different index name', () => {
  const report = buildDatabasePerServiceSplitReport({
    sourceCollections: [
      {
        name: 'users',
        indexes: [
          { name: '_id_', key: { _id: 1 }, unique: true },
          {
            name: 'expiresAt_1',
            key: { expiresAt: 1 },
            expireAfterSeconds: 60,
          },
        ],
        documents: [
          { _id: 'u1', digest: 'same', raw: { expiresAt: new Date() } },
        ],
      },
    ],
    targetCollections: {
      continuum_iam: {
        users: {
          name: 'users',
          indexes: [
            { name: '_id_', key: { _id: 1 }, unique: true },
            {
              name: 'legacy_expiry',
              key: { expiresAt: 1 },
              expireAfterSeconds: 120,
            },
          ],
          documents: [
            { _id: 'u1', digest: 'same', raw: { expiresAt: new Date() } },
          ],
        },
      },
    },
  });

  assert.equal(report.clean, false);
  assert.deepEqual(
    report.blockingIndexDifferences.map(({ status, index, targetIndex }) => ({
      status,
      index,
      targetIndex,
    })),
    [
      {
        status: 'INCOMPATIBLE_TARGET_INDEX_OPTIONS',
        index: 'expiresAt_1',
        targetIndex: 'legacy_expiry',
      },
    ],
  );
  assert.match(report.blockingIndexDifferences[0].reason, /expireAfterSeconds/);
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
          {
            _id: 'source-user',
            digest: 'source',
            raw: { email: 'same@example.test' },
          },
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
            {
              _id: 'target-user',
              digest: 'target',
              raw: { email: 'same@example.test' },
            },
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
        documents: [
          { _id: 'u1', digest: 'source', raw: { email: 'u@example.test' } },
        ],
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
    report.unverifiableUniqueIndexes.some((row) =>
      row.reason.includes('collation'),
    ),
  );
});

test('uses collection collation for inherited unique indexes and index override for explicit collation', () => {
  const report = buildDatabasePerServiceSplitReport({
    sourceCollections: [
      {
        name: 'users',
        options: { collation: { locale: 'en', strength: 2 } },
        indexes: [
          { name: '_id_', key: { _id: 1 }, unique: true },
          { name: 'email_inherited', key: { email: 1 }, unique: true },
          {
            name: 'external_id_simple',
            key: { externalId: 1 },
            unique: true,
            collation: { locale: 'simple' },
          },
        ],
        documents: [
          {
            _id: 'source',
            digest: 'source',
            raw: { email: 'Person@example.test', externalId: 'same' },
          },
        ],
      },
    ],
    targetCollections: {
      continuum_iam: {
        users: {
          name: 'users',
          options: { collation: { locale: 'en', strength: 2 } },
          indexes: [{ name: '_id_', key: { _id: 1 }, unique: true }],
          documents: [
            {
              _id: 'target-email',
              digest: 'target-email',
              raw: { email: 'person@EXAMPLE.test' },
            },
            {
              _id: 'target-external',
              digest: 'target-external',
              raw: { externalId: 'same' },
            },
          ],
        },
      },
    },
  });

  assert.equal(report.clean, false);
  assert.ok(
    report.unverifiableUniqueIndexes.some(
      (row) =>
        row.index === 'email_inherited' &&
        row.effectiveCollation.locale === 'en',
    ),
  );
  assert.ok(
    report.uniqueIndexConflicts.some(
      (row) =>
        row.index === 'external_id_simple' &&
        row.effectiveCollation.locale === 'simple',
    ),
  );
  assert.ok(
    !report.unverifiableUniqueIndexes.some(
      (row) => row.index === 'external_id_simple',
    ),
  );
});

test('reports multiple destination-only collections across databases and preserves their documents', () => {
  const report = buildDatabasePerServiceSplitReport({
    sourceCollections: [
      { name: 'users', documents: [{ _id: 'source-user', digest: 'source' }] },
    ],
    targetCollections: {
      continuum_iam: [
        {
          name: 'users',
          documents: [{ _id: 'target-only-user', digest: 'target' }],
        },
        {
          name: 'unexpected_one',
          documents: [{ _id: 'extra-one', digest: 'one' }],
        },
      ],
      continuum_capture: [
        {
          name: 'unexpected_two',
          documents: [{ _id: 'extra-two', digest: 'two' }],
        },
      ],
    },
  });

  assert.equal(report.clean, false);
  assert.equal(report.counts.targetOnlyCollections, 2);
  assert.deepEqual(
    report.targetOnlyCollections.map((item) => item.collection),
    ['unexpected_two', 'unexpected_one'],
  );
  assert.deepEqual(
    report.targetOnlyDocuments.map((item) => item.id),
    ['extra-two', 'extra-one', 'target-only-user'],
  );
});

test('blocks inventory-listed collections absent from the mapped source set', () => {
  const report = buildDatabasePerServiceSplitReport({
    sourceCollections: [{ name: 'users', documents: [] }],
    targetCollections: {
      continuum_iam: [
        {
          name: 'users',
          documents: [{ _id: 'target-only-user', digest: 'target' }],
        },
        {
          name: 'projects',
          documents: [{ _id: 'target-only-project', digest: 'project' }],
        },
      ],
    },
  });

  assert.equal(report.clean, false);
  assert.equal(report.counts.targetOnlyCollections, 1);
  assert.deepEqual(
    report.targetOnlyCollections.map((item) => item.collection),
    ['projects'],
  );
  assert.deepEqual(
    report.targetOnlyDocuments.map((item) => item.id),
    ['target-only-project', 'target-only-user'],
  );
});
