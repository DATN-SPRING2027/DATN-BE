import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDatabaseName } from './20261019-project-settings-leader-permissions.mjs';

test('uses the configured database in shared MongoDB mode', () => {
  assert.equal(
    resolveDatabaseName({
      MONGODB_ENABLED: 'true',
      INFRA_ENABLED: 'false',
      MONGODB_DATABASE: 'continuum_shared_iam',
    }),
    'continuum_shared_iam',
  );
});

test('uses the service-owned IAM database in dedicated mode', () => {
  assert.equal(
    resolveDatabaseName({
      MONGODB_ENABLED: 'false',
      INFRA_ENABLED: 'true',
      MONGODB_DATABASE: 'ignored_shared_database',
    }),
    'continuum_iam',
  );
});

test('refuses to target a database when IAM persistence is disabled', () => {
  assert.throws(
    () =>
      resolveDatabaseName({
        MONGODB_ENABLED: 'false',
        INFRA_ENABLED: 'false',
        MONGODB_DATABASE: 'ignored_shared_database',
      }),
    /IAM MongoDB persistence is disabled/,
  );
});

test('accepts valid explicit database override when infra is enabled', () => {
  assert.equal(
    resolveDatabaseName(
      {
        MONGODB_ENABLED: 'true',
        INFRA_ENABLED: 'true',
        MONGODB_DATABASE: 'continuum_shared_iam',
      },
      'continuum_iam',
    ),
    'continuum_iam',
  );
});

test('refuses arbitrary database override not matching approved targets', () => {
  assert.throws(
    () =>
      resolveDatabaseName(
        {
          MONGODB_ENABLED: 'true',
          INFRA_ENABLED: 'true',
          MONGODB_DATABASE: 'continuum_shared_iam',
        },
        'arbitrary_unapproved_database',
      ),
    /Database override 'arbitrary_unapproved_database' is not an approved IAM database/,
  );
});
