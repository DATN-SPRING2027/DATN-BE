import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProjectCodeIndexPlan } from './project-code-index.plan.mjs';

const base = () => ({
  databaseName: 'continuum_db',
  targetFingerprint: 'target',
  collectionExists: true,
  objectType: 'collection',
  projectCount: 0,
  indexes: [{ name: '_id_', key: { _id: 1 }, unique: true }],
  duplicatePairs: [],
  nonCanonicalProjectCodes: [],
});

test('clean missing index proposes one non-destructive create', () => {
  const plan = buildProjectCodeIndexPlan(base());
  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'CREATE_UNIQUE_INDEX');
});

test('rerun with matching unique index is a no-op', () => {
  const input = base();
  input.indexes.push({ name: 'organizationId_1_code_1', key: { organizationId: 1, code: 1 }, unique: true });
  const plan = buildProjectCodeIndexPlan(input);
  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'NOOP');
});

test('explicit simple collation is accepted as unrestricted uniqueness', () => {
  const input = base();
  input.indexes.push({ name: 'organizationId_1_code_1', key: { organizationId: 1, code: 1 },
    unique: true, collation: { locale: 'simple' } });
  assert.equal(buildProjectCodeIndexPlan(input).action, 'NOOP');
});

test('duplicate organization/code pair blocks index creation', () => {
  const input = base();
  input.duplicatePairs.push({ organizationId: 'org-a', code: 'P1', count: 2 });
  const plan = buildProjectCodeIndexPlan(input);
  assert.equal(plan.clean, false);
  assert.equal(plan.action, 'BLOCKED');
});

test('non-canonical project codes block index creation for manual remediation', () => {
  const input = base();
  input.nonCanonicalProjectCodes.push({
    projectId: 'project-a',
    organizationId: 'org-a',
    code: ' p1 ',
    normalizedCode: 'P1',
  });
  const plan = buildProjectCodeIndexPlan(input);
  assert.equal(plan.clean, false);
  assert.equal(plan.action, 'BLOCKED');
  assert.deepEqual(plan.nonCanonicalProjectCodes, input.nonCanonicalProjectCodes);
});

test('non-unique matching index and missing collection block migration', () => {
  const input = base();
  input.indexes.push({ name: 'organizationId_1_code_1', key: { organizationId: 1, code: 1 }, unique: false });
  assert.equal(buildProjectCodeIndexPlan(input).action, 'BLOCKED');
  input.indexes = [];
  input.collectionExists = false;
  input.objectType = null;
  assert.equal(buildProjectCodeIndexPlan(input).action, 'BLOCKED');
});

test('same-named Project view is a blocked object-type conflict', () => {
  const input = base();
  input.collectionExists = false;
  input.objectType = 'view';
  input.indexes = [];
  const plan = buildProjectCodeIndexPlan(input);
  assert.equal(plan.action, 'BLOCKED');
  assert.equal(plan.conflictingObjectType, 'view');
});

for (const [label, options] of [
  ['sparse', { sparse: true }],
  ['partial', { partialFilterExpression: { status: 'ACTIVE' } }],
  ['different collation', { collation: { locale: 'en', strength: 2 } }],
]) test(`${label} unique index does not satisfy unrestricted uniqueness`, () => {
  const input = base();
  input.indexes.push({
    name: 'organizationId_1_code_1',
    key: { organizationId: 1, code: 1 },
    unique: true,
    ...options,
  });
  const plan = buildProjectCodeIndexPlan(input);
  assert.equal(plan.action, 'BLOCKED');
  assert.equal(plan.conflictingIndexes.length, 1);
});
