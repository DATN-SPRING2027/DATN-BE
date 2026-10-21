import assert from 'node:assert/strict';
import { test } from 'node:test';
import mongoose from 'mongoose';
import {
  buildFenceRecoveryPlan,
  snapshotHash,
  validateRecoveryUri,
  validateReviewedPlan,
} from './organization-role-fence-recovery.plan.mjs';
const id = (n) => new mongoose.Types.ObjectId(n.toString(16).padStart(24, '0'));
const row = (extra = {}) => ({
  _id: id(1),
  organizationId: id(2),
  userId: id(3),
  roleId: id(4),
  roleCode: 'ADMIN',
  assignedBy: id(3),
  createdAt: new Date('2026-10-21T00:00:00Z'),
  updatedAt: new Date('2026-10-21T00:00:00Z'),
  ...extra,
});
const target = {
  database: 'continuum_iam',
  replicaSet: 'org08-mongo8-recovery-test',
  markerId: 'org08-mongo8-fence-recovery-disposable',
};
test('plans only absent fences; preserves Organization and Project scope and existing fence values', () => {
  const rows = [
    row(),
    row({ _id: id(5), projectId: id(6), roleCode: 'TEAM_LEADER' }),
    row({ _id: id(7), mutationFence: 9 }),
  ];
  const before = snapshotHash(rows);
  const plan = buildFenceRecoveryPlan(rows, target);
  assert.equal(plan.missingCount, 2);
  assert.equal(plan.totalCount, 3);
  assert.equal(plan.clean, true);
  assert.equal(plan.beforeHash, before);
  assert.equal(snapshotHash(rows), before);
  assert.equal(
    plan.afterHash,
    snapshotHash(
      rows.map((r) =>
        Object.hasOwn(r, 'mutationFence') ? r : { ...r, mutationFence: 0 },
      ),
    ),
  );
  assert.equal(JSON.stringify(plan).includes(id(3).toHexString()), false);
});
test('rejects invalid existing fences instead of resetting them', () => {
  for (const value of [null, -1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1])
    assert.equal(
      buildFenceRecoveryPlan([row({ mutationFence: value })], target).clean,
      false,
    );
});
test('rejects invalid scope, catalog code, subject identifier and timestamp', () => {
  for (const extra of [
    { projectId: 'bad' },
    { roleCode: 'CUSTOM' },
    { userId: 'bad' },
    { updatedAt: null },
    { roleCode: 'TEAM_LEADER' },
  ])
    assert.equal(buildFenceRecoveryPlan([row(extra)], target).clean, false);
});
test('snapshot hash changes for any role, scope, unknown metadata or version change', () => {
  const original = row();
  for (const extra of [
    { roleCode: 'MEMBER' },
    { projectId: id(6) },
    { mutationFence: 1 },
    { arbitraryMetadata: 1 },
  ])
    assert.notEqual(
      snapshotHash([original]),
      snapshotHash([{ ...original, ...extra }]),
    );
});
test('reviewed plan binds target and hashes and detects alteration', () => {
  const plan = buildFenceRecoveryPlan([row()], target);
  assert.equal(validateReviewedPlan(plan, target).planHash, plan.planHash);
  assert.throws(() =>
    validateReviewedPlan({ ...plan, afterHash: '0'.repeat(64) }, target),
  );
  assert.throws(() =>
    validateReviewedPlan(plan, { ...target, replicaSet: 'other' }),
  );
  assert.throws(() =>
    validateReviewedPlan(
      buildFenceRecoveryPlan([row({ mutationFence: null })], target),
      target,
    ),
  );
});
test('URI guard accepts only explicit loopback IAM and rejects remote, SRV, insecure and wrong database', () => {
  for (const uri of [
    'mongodb://127.0.0.1:27017/continuum_iam',
    'mongodb://user:pass@localhost:27017/continuum_iam?authSource=admin',
  ])
    assert.equal(validateRecoveryUri(uri), uri);
  for (const uri of [
    undefined,
    'mongodb+srv://example.mongodb.net/continuum_iam',
    'mongodb://example.com/continuum_iam',
    'mongodb://127.0.0.1/other',
    'mongodb://127.0.0.1/continuum_iam?tlsInsecure=true',
    'mongodb://127.0.0.1,remote/continuum_iam',
  ])
    assert.throws(() => validateRecoveryUri(uri));
});
