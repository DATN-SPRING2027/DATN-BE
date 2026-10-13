import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import mongoose from 'mongoose';
import * as lifecycle from './20261012-organization-membership-lifecycle.mjs';
import { lifecycleHash } from './organization-membership-lifecycle.plan.mjs';
const { ObjectId, BSON } = mongoose.mongo;

test('CLI reports its safe migration code and never echoes unknown arguments', () => {
  const secret = 'mongodb://private-user:private-password@private-host/';
  const child = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          './20261012-organization-membership-lifecycle.mjs',
          import.meta.url,
        ),
      ),
      `--unknown=${secret}`,
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(child.status, 1);
  assert.match(child.stderr, /\[INVALID_ARGUMENTS\]/);
  assert.equal(child.stderr.includes(secret), false);
  assert.equal(child.stdout, '');
});

test('post-commit verification failure is distinguishable without exposing raw errors', () => {
  const code = 'POST_APPLY_VERIFICATION_FAILED_FORWARD_RECOVERY_REQUIRED';
  assert.match(
    lifecycle.membershipLifecycleFailureMessage(new Error(code)),
    new RegExp(`\\[${code}\\]`),
  );
  for (const error of [
    new Error('mongodb://private-user:private-password@private-host/ failed'),
    new Error('ALL_CAPS_PRIVATE_PASSWORD'),
    { message: code },
  ]) {
    const message = lifecycle.membershipLifecycleFailureMessage(error);
    assert.match(message, /\[MEMBERSHIP_LIFECYCLE_MIGRATION_FAILED\]/);
    assert.equal(message.includes('private'), false);
    assert.equal(message.includes('PRIVATE_PASSWORD'), false);
  }
});

test('Invitation history actor ObjectIds are canonical across BSON and report cloning', () => {
  const row = {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    acceptedBy: new ObjectId(),
    revokedBy: new ObjectId(),
  };
  const normalized = lifecycle.normalizedRow(row);
  assert.equal(normalized.acceptedBy, row.acceptedBy.toHexString());
  assert.equal(normalized.revokedBy, row.revokedBy.toHexString());
  assert.equal(
    lifecycleHash(normalized),
    lifecycleHash(
      lifecycle.normalizedRow(BSON.deserialize(BSON.serialize(row))),
    ),
  );
  assert.equal(
    lifecycleHash(normalized),
    lifecycleHash(structuredClone(normalized)),
  );
  assert.equal(
    lifecycleHash(normalized),
    lifecycleHash(JSON.parse(JSON.stringify(normalized))),
  );
});

test('wrong BSON history-reference types become invalid markers rather than guessed User IDs', () => {
  for (const field of ['acceptedBy', 'revokedBy']) {
    assert.equal(
      lifecycle.normalizedRow({ [field]: 'a'.repeat(24) })[field],
      'INVALID_BSON_OBJECTID',
    );
    assert.equal(lifecycle.normalizedRow({ [field]: null })[field], null);
    assert.equal(Object.hasOwn(lifecycle.normalizedRow({}), field), false);
  }
});
