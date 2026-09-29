import assert from 'node:assert/strict';
import test from 'node:test';
import { planIamProjectAuditCollection } from './iam-project-audit-collection.plan.mjs';

const input = {
  databaseName: 'continuum_db',
  targetFingerprint: 'test',
  collectionExists: false,
  objectType: null,
  documentCount: 0,
};

test('missing audit collection plans a non-destructive create', () => {
  assert.equal(planIamProjectAuditCollection(input).action, 'CREATE_COLLECTION');
});

test('existing audit collection is a no-op regardless of document count', () => {
  const plan = planIamProjectAuditCollection({
    ...input, collectionExists: true, objectType: 'collection', documentCount: 9,
  });
  assert.equal(plan.action, 'NOOP');
  assert.equal(plan.documentCount, 9);
});

test('same-named view is reported as a conflict and cannot satisfy audit writes', () => {
  const plan = planIamProjectAuditCollection({
    ...input, collectionExists: true, objectType: 'view',
  });
  assert.equal(plan.action, 'BLOCKED_VIEW');
  assert.equal(plan.clean, false);
});

test('invalid inspection cannot be applied', () => {
  assert.throws(() => planIamProjectAuditCollection({
    ...input, documentCount: -1,
  }));
});
