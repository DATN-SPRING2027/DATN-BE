import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_SUBJECT_INDEX,
  hashGoogleIdentityIndexReport,
  planGoogleIdentityIndex,
} from './google-identity-index.plan.mjs';

const base = (overrides = {}) => ({
  databaseName: 'continuum_iam',
  targetFingerprint: 'reviewed-target',
  collectionExists: false,
  objectType: null,
  userCount: 0,
  duplicateSubjectGroups: 0,
  indexes: [],
  ...overrides,
});

test('plans the additive sparse unique subject index without rewriting User data', () => {
  const plan = planGoogleIdentityIndex(base());
  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'CREATE_COLLECTION_AND_INDEX');
  assert.equal(plan.desiredIndex.action, 'CREATE');
  assert.deepEqual(
    {
      key: plan.desiredIndex.key,
      unique: plan.desiredIndex.unique,
      sparse: plan.desiredIndex.sparse,
    },
    { key: GOOGLE_SUBJECT_INDEX.key, unique: true, sparse: true },
  );
});

test('plans NOOP for the exact existing index', () => {
  const plan = planGoogleIdentityIndex(
    base({
      collectionExists: true,
      objectType: 'collection',
      indexes: [GOOGLE_SUBJECT_INDEX],
    }),
  );
  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'NOOP');
  assert.equal(plan.desiredIndex.action, 'NOOP');
});

test('blocks duplicate subjects and incompatible indexes without exposing identities', () => {
  const duplicates = planGoogleIdentityIndex(
    base({
      collectionExists: true,
      objectType: 'collection',
      duplicateSubjectGroups: 2,
    }),
  );
  assert.equal(duplicates.clean, false);
  assert.equal(duplicates.action, 'BLOCKED');
  assert.equal('duplicateSubjects' in duplicates, false);

  const conflict = planGoogleIdentityIndex(
    base({
      collectionExists: true,
      objectType: 'collection',
      indexes: [{ key: GOOGLE_SUBJECT_INDEX.key, unique: false }],
    }),
  );
  assert.equal(conflict.clean, false);
  assert.equal(conflict.desiredIndex.action, 'CONFLICT');

  const nameConflict = planGoogleIdentityIndex(
    base({
      indexes: [
        {
          key: { email: 1 },
          name: 'googleSubject_1',
          unique: true,
        },
      ],
    }),
  );
  assert.equal(nameConflict.clean, false);
  assert.equal(nameConflict.desiredIndex.action, 'CONFLICT');
});

test('blocks a non-collection object using the users name', () => {
  const plan = planGoogleIdentityIndex(
    base({ collectionExists: true, objectType: 'view' }),
  );
  assert.equal(plan.clean, false);
  assert.equal(plan.action, 'BLOCKED');
});

test('review hash binds the complete inspected plan and target', () => {
  const report = planGoogleIdentityIndex(base());
  const sameReport = planGoogleIdentityIndex(base());
  const otherTarget = planGoogleIdentityIndex(
    base({ targetFingerprint: 'another-target' }),
  );

  assert.equal(
    hashGoogleIdentityIndexReport(report),
    hashGoogleIdentityIndexReport(sameReport),
  );
  assert.notEqual(
    hashGoogleIdentityIndexReport(report),
    hashGoogleIdentityIndexReport(otherTarget),
  );
});
