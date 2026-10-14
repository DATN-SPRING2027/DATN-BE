import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PASSWORD_RESET_OUTBOX_INDEXES,
  hashPasswordResetOutboxReport,
  planPasswordResetOutboxIndexes,
} from './password-reset-outbox.plan.mjs';

const base = {
  targetFingerprint: 'target-fingerprint',
  collectionExists: false,
  objectType: null,
  documentCount: 0,
  malformedDocumentCount: 0,
  duplicateUserScopeGroups: 0,
  duplicateTokenHashGroups: 0,
  indexes: [],
};

test('plans collection and indexes when the outbox collection is absent', () => {
  const report = planPasswordResetOutboxIndexes(base);

  assert.equal(report.clean, true);
  assert.equal(report.action, 'CREATE_COLLECTION_AND_INDEXES');
  assert.equal(
    report.desiredIndexes.length,
    PASSWORD_RESET_OUTBOX_INDEXES.length,
  );
  assert.ok(report.desiredIndexes.every((index) => index.action === 'CREATE'));
});

test('reports no-op when every desired index already exists exactly', () => {
  const indexes = [
    { name: '_id_', key: { _id: 1 } },
    ...PASSWORD_RESET_OUTBOX_INDEXES.map((index) => ({
      ...index,
      key: { ...index.key },
    })),
  ];
  const report = planPasswordResetOutboxIndexes({
    ...base,
    collectionExists: true,
    objectType: 'collection',
    indexes,
  });

  assert.equal(report.clean, true);
  assert.equal(report.action, 'NOOP');
  assert.ok(report.desiredIndexes.every((index) => index.action === 'NOOP'));
});

test('blocks a compound index with fields in the wrong order', () => {
  const desired = PASSWORD_RESET_OUTBOX_INDEXES.find(
    (index) => index.name === 'password_reset_pending_jobs',
  );
  const wrongOrder = {
    ...desired,
    key: Object.fromEntries(Object.entries(desired.key).reverse()),
  };
  const report = planPasswordResetOutboxIndexes({
    ...base,
    collectionExists: true,
    objectType: 'collection',
    indexes: [wrongOrder],
  });

  assert.equal(report.clean, false);
  assert.equal(report.action, 'BLOCKED');
  assert.equal(
    report.desiredIndexes.find(
      (index) => index.name === 'password_reset_pending_jobs',
    ).action,
    'CONFLICT',
  );
});

test('blocks a hidden index that cannot enforce or serve the outbox contract', () => {
  const desired = PASSWORD_RESET_OUTBOX_INDEXES.find(
    (index) => index.name === 'password_reset_token_hash',
  );
  const hidden = { ...desired, hidden: true };
  const report = planPasswordResetOutboxIndexes({
    ...base,
    collectionExists: true,
    objectType: 'collection',
    indexes: [hidden],
  });

  assert.equal(report.clean, false);
  assert.equal(report.action, 'BLOCKED');
  assert.equal(
    report.desiredIndexes.find(
      (index) => index.name === 'password_reset_token_hash',
    ).action,
    'CONFLICT',
  );
});

test('blocks unsafe data and conflicting indexes before any write', () => {
  const report = planPasswordResetOutboxIndexes({
    ...base,
    collectionExists: true,
    objectType: 'collection',
    documentCount: 3,
    malformedDocumentCount: 1,
    duplicateUserScopeGroups: 1,
    indexes: [
      {
        name: 'password_reset_token_hash',
        key: { tokenHash: 1 },
        unique: false,
      },
    ],
  });

  assert.equal(report.clean, false);
  assert.equal(report.action, 'BLOCKED');
  assert.equal(
    report.desiredIndexes.find(
      (index) => index.name === 'password_reset_token_hash',
    ).action,
    'CONFLICT',
  );
});

test('hashes the reviewed migration report deterministically', () => {
  const report = planPasswordResetOutboxIndexes(base);
  assert.equal(
    hashPasswordResetOutboxReport(report),
    hashPasswordResetOutboxReport(report),
  );
  assert.notEqual(
    hashPasswordResetOutboxReport(report),
    hashPasswordResetOutboxReport({
      ...report,
      targetFingerprint: 'another-target',
    }),
  );
});
