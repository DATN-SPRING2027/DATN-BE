import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contract,
  planHandoverV2,
  validateTarget,
} from './handover-v2.plan.mjs';

test('requires explicit owning database and rejects unsafe URI targets', () => {
  assert.doesNotThrow(() =>
    validateTarget('mongodb://127.0.0.1:27017/continuum_handover'),
  );
  for (const uri of [
    'mongodb://localhost/continuum_iam',
    'https://localhost',
    'mongodb://remote/continuum_handover',
    'mongodb://localhost,remote/continuum_handover',
  ]) {
    assert.throws(() => validateTarget(uri));
  }
});

test('accepts equivalent indexes with a different name but rejects conflicting uniqueness/filters', () => {
  const index = contract.collections.handovers.indexes[0];
  const inventory = {
    handovers: {
      exists: true,
      indexes: [{ ...index, name: 'existing_equivalent' }],
    },
  };
  const equivalent = planHandoverV2({
    databaseName: 'continuum_handover',
    inventory,
  });
  assert.equal(equivalent.blockers.length, 0);
  assert.equal(
    equivalent.indexes.find((i) => i.name === index.name).action,
    'KEEP',
  );
  inventory.handovers.indexes[0].unique = false;
  assert.ok(
    planHandoverV2({
      databaseName: 'continuum_handover',
      inventory,
    }).blockers.some((b) => b.code === 'INDEX_CONFLICT'),
  );
});

test('report hash changes with inventory or target drift', () => {
  const args = {
    databaseName: 'continuum_handover',
    inventory: {},
    targetFingerprint: 'a',
  };
  const first = planHandoverV2(args).reportSha256;
  assert.equal(planHandoverV2(args).reportSha256, first);
  assert.notEqual(
    planHandoverV2({ ...args, targetFingerprint: 'b' }).reportSha256,
    first,
  );
  assert.notEqual(
    planHandoverV2({
      ...args,
      inventory: { handovers: { exists: true, legacyCount: 1, indexes: [] } },
    }).reportSha256,
    first,
  );
});

test('planner is additive, includes nullable-recipient storage, and has no backfill/drop/TTL', () => {
  const plan = planHandoverV2({
    databaseName: 'continuum_handover',
    inventory: {},
  });
  assert.equal(plan.blockers.length, 0);
  assert.ok(plan.collections.some((c) => c.name === 'handover_revisions'));
  assert.ok(plan.collections.every((c) => c.action === 'CREATE'));
  assert.ok(plan.indexes.every((i) => i.expireAfterSeconds === undefined));
  assert.equal(plan.rewriteDocuments, false);
  assert.throws(() =>
    planHandoverV2({ databaseName: 'continuum_iam', inventory: {} }),
  );
});

test('invalid rows, duplicate active handovers and conflicting validators block all writes', () => {
  const inventory = {
    handovers: {
      exists: true,
      invalidCount: 1,
      duplicateIndexes: ['handover_v2_open_unique'],
      indexes: [],
      validator: { unknown: true },
    },
  };
  const plan = planHandoverV2({
    databaseName: 'continuum_handover',
    inventory,
  });
  assert.ok(plan.blockers.some((b) => b.code === 'INVALID_DOCUMENTS'));
  assert.ok(plan.blockers.some((b) => b.code === 'DUPLICATE_KEYS'));
  assert.ok(plan.blockers.some((b) => b.code === 'VALIDATOR_CONFLICT'));
});
