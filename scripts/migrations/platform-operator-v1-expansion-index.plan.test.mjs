import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_OPERATOR_V1_EXPANSION_INDEX,
  planPlatformOperatorV1ExpansionIndex,
} from './platform-operator-v1-expansion-index.plan.mjs';

const base = (overrides = {}) => ({
  databaseName: 'continuum_iam_test',
  targetFingerprint: 'reviewed-target',
  collectionExists: false,
  objectType: null,
  documentCount: 0,
  indexes: [],
  ...overrides,
});

test('plans collection and the additive provenance index without touching records', () => {
  const report = planPlatformOperatorV1ExpansionIndex(base());
  assert.equal(report.clean, true);
  assert.equal(report.action, 'CREATE_COLLECTION_AND_INDEX');
  assert.equal(report.desiredIndex.action, 'CREATE');
});

test('plans NOOP for the exact additive index', () => {
  const report = planPlatformOperatorV1ExpansionIndex(
    base({
      collectionExists: true,
      objectType: 'collection',
      indexes: [PLATFORM_OPERATOR_V1_EXPANSION_INDEX],
    }),
  );
  assert.equal(report.clean, true);
  assert.equal(report.action, 'NOOP');
  assert.equal(report.desiredIndex.action, 'NOOP');
});

test('blocks a conflicting index on the same key or an unexpected collection object', () => {
  const conflict = planPlatformOperatorV1ExpansionIndex(
    base({
      collectionExists: true,
      objectType: 'collection',
      indexes: [
        {
          ...PLATFORM_OPERATOR_V1_EXPANSION_INDEX,
          name: 'unreviewed_index',
          unique: true,
        },
      ],
    }),
  );
  assert.equal(conflict.clean, false);
  assert.equal(conflict.desiredIndex.action, 'CONFLICT');

  const view = planPlatformOperatorV1ExpansionIndex(
    base({ collectionExists: true, objectType: 'view' }),
  );
  assert.equal(view.clean, false);
  assert.equal(view.action, 'BLOCKED');
});
