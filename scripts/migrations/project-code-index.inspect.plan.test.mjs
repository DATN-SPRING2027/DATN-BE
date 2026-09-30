import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectProjectCodeIndex } from './project-code-index.inspect.mjs';

test('inspection groups normalized codes and blocks non-canonical values', async () => {
  const aggregateCalls = [];
  const duplicatePairs = [{ organizationId: 'org-a', code: 'P1', count: 2 }];
  const nonCanonicalProjectCodes = [
    {
      projectId: 'project-b',
      organizationId: 'org-a',
      code: ' p1 ',
      normalizedCode: 'P1',
    },
  ];
  const db = {
    databaseName: 'continuum_db',
    listCollections: () => ({ toArray: async () => [{ type: 'collection' }] }),
    collection: () => ({
      indexes: async () => [{ name: '_id_', key: { _id: 1 }, unique: true }],
      aggregate: (pipeline, options) => {
        aggregateCalls.push({ pipeline, options });
        const isDuplicateQuery = pipeline.some((stage) => stage.$group);
        return {
          toArray: async () =>
            isDuplicateQuery ? duplicatePairs : nonCanonicalProjectCodes,
        };
      },
      countDocuments: async () => 2,
    }),
  };

  const plan = await inspectProjectCodeIndex({
    db,
    targetFingerprint: 'target',
  });

  assert.equal(aggregateCalls.length, 2);
  for (const { pipeline, options } of aggregateCalls) {
    assert.deepEqual(pipeline[0].$set.normalizedCode, {
      $cond: [
        { $eq: [{ $type: '$code' }, 'string'] },
        { $toUpper: { $trim: { input: '$code' } } },
        null,
      ],
    });
    assert.deepEqual(options, { collation: { locale: 'simple' } });
  }
  assert.deepEqual(aggregateCalls[0].pipeline.at(-1).$project, {
    _id: 0,
    organizationId: '$_id.organizationId',
    code: '$_id.code',
    count: 1,
  });
  assert.deepEqual(aggregateCalls[1].pipeline.at(-2).$project, {
    _id: 0,
    projectId: '$_id',
    organizationId: 1,
    code: 1,
    normalizedCode: 1,
  });
  assert.deepEqual(plan.duplicatePairs, duplicatePairs);
  assert.deepEqual(plan.nonCanonicalProjectCodes, nonCanonicalProjectCodes);
  assert.equal(plan.clean, false);
  assert.equal(plan.action, 'BLOCKED');
});
