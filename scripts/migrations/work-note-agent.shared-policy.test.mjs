import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharedTarget } from './work-note-agent.shared-policy.mjs';
import { runSharedMigration } from './20261028-work-note-agent-shared.mjs';
import { runSharedEditorMigration } from './20261028-work-note-editor-shared.mjs';
const env = {
  WORKNOTE_MIGRATION_URI:
    'mongodb+srv://fixture:fixture@review-cluster.mongodb.net/continuum_capture',
  WORKNOTE_MIGRATION_EXPECTED_HOST: 'review-cluster.mongodb.net',
};
test('requires explicit URI and exact independently supplied host/database', () => {
  assert.throws(() => sharedTarget({}), /explicit/i);
  assert.throws(
    () =>
      sharedTarget({
        ...env,
        WORKNOTE_MIGRATION_EXPECTED_HOST: 'other.mongodb.net',
      }),
    /target/i,
  );
  assert.throws(
    () =>
      sharedTarget({
        ...env,
        WORKNOTE_MIGRATION_URI: env.WORKNOTE_MIGRATION_URI.replace(
          'continuum_capture',
          'continuum_iam',
        ),
      }),
    /target/i,
  );
  assert.equal(sharedTarget(env).database, 'continuum_capture');
});
test('refuses insecure TLS, loopback, multiple hosts, fragments and implicit DB', () => {
  for (const uri of [
    env.WORKNOTE_MIGRATION_URI + '?tls=false',
    env.WORKNOTE_MIGRATION_URI + '?tlsInsecure=true',
    env.WORKNOTE_MIGRATION_URI + '?ssl=false',
    env.WORKNOTE_MIGRATION_URI + '?tlsAllowInvalidCertificates=true',
    env.WORKNOTE_MIGRATION_URI + '#fragment',
    'mongodb://localhost/continuum_capture',
    'mongodb+srv://a.mongodb.net,b.mongodb.net/continuum_capture',
    'mongodb+srv://review-cluster.mongodb.net/',
  ])
    assert.throws(() => sharedTarget({ ...env, WORKNOTE_MIGRATION_URI: uri }));
});
test('apply requires explicit target confirmation and operator backup reference', () => {
  assert.throws(() => sharedTarget(env, true), /confirmation/i);
  assert.throws(
    () =>
      sharedTarget(
        {
          ...env,
          WORKNOTE_MIGRATION_CONFIRM_TARGET:
            'review-cluster.mongodb.net/continuum_capture',
        },
        true,
      ),
    /backup/i,
  );
  assert.equal(
    sharedTarget(
      {
        ...env,
        WORKNOTE_MIGRATION_CONFIRM_TARGET:
          'review-cluster.mongodb.net/continuum_capture',
        WORKNOTE_MIGRATION_BACKUP_REFERENCE: 'operator-attested-snapshot-001',
      },
      true,
    ).database,
    'continuum_capture',
  );
});
test('default dry run does not read a URI or call a connector; invalid target fails before connect', async () => {
  let calls = 0;
  const connect = async () => {
    calls++;
    throw Error('must not connect');
  };
  assert.equal((await runSharedMigration([], {}, connect)).networkCalls, 0);
  await assert.rejects(runSharedMigration(['--apply'], env, connect));
  await assert.rejects(runSharedMigration(['--unknown'], env, connect));
  await assert.rejects(runSharedMigration(['--backfill'], env, connect));
  await assert.rejects(
    runSharedMigration(['--inspect', '--apply'], env, connect),
  );
  assert.equal(calls, 0);
});
test('shared editor defaults to no network and rejects unsafe or ambiguous modes before connect', async () => {
  let calls = 0;
  const connect = async () => {
    calls++;
    throw Error('must not connect');
  };
  assert.equal(
    (await runSharedEditorMigration([], {}, connect)).networkCalls,
    0,
  );
  for (const args of [
    ['--backfill'],
    ['--inspect', '--apply'],
    ['--apply'],
    ['--unknown'],
  ])
    await assert.rejects(runSharedEditorMigration(args, env, connect));
  assert.equal(calls, 0);
});
