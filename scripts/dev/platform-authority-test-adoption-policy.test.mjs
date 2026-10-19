import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertFixedDatabaseNames,
  parseTestAdoptionArguments,
  validateTestAdoptionEnvironment,
} from './platform-authority-test-adoption-policy.mjs';

const allowedUri =
  'mongodb+srv://test-user:test-password@kimthang.mh3rrz2.mongodb.net/?retryWrites=true&w=majority&appName=authority-test';

const allowedEnvironment = {
  NODE_ENV: 'development',
  DATN_DB_ENV: 'development',
  DATN_TEST_PLATFORM_AUTHORITY_ADOPTION: 'TEST_ONLY_ATLAS_DEV',
  MONGODB_URI: allowedUri,
};

test('accepts only the explicitly allowlisted development Atlas endpoint', () => {
  assert.doesNotThrow(() =>
    validateTestAdoptionEnvironment(allowedEnvironment),
  );
});

test('rejects arbitrary remote MongoDB hosts, even with development labels', () => {
  assert.throws(
    () =>
      validateTestAdoptionEnvironment({
        ...allowedEnvironment,
        MONGODB_URI: allowedUri.replace(
          'kimthang.mh3rrz2.mongodb.net',
          'other-cluster.mongodb.net',
        ),
      }),
    { code: 'UNAPPROVED_MONGODB_HOST' },
  );
});

test('rejects production and mismatched environment labels', () => {
  assert.throws(
    () =>
      validateTestAdoptionEnvironment({
        ...allowedEnvironment,
        NODE_ENV: 'production',
      }),
    { code: 'UNSAFE_ENVIRONMENT' },
  );
  assert.throws(
    () =>
      validateTestAdoptionEnvironment({
        ...allowedEnvironment,
        DATN_DB_ENV: 'test',
      }),
    { code: 'UNSAFE_ENVIRONMENT' },
  );
});

test('requires exact Atlas URI shape and rejects database paths or unsafe options', () => {
  assert.throws(
    () =>
      validateTestAdoptionEnvironment({
        ...allowedEnvironment,
        MONGODB_URI: allowedUri.replace('.net/?', '.net/production?'),
      }),
    { code: 'MONGODB_DATABASE_PATH_PROHIBITED' },
  );
  assert.throws(
    () =>
      validateTestAdoptionEnvironment({
        ...allowedEnvironment,
        MONGODB_URI: `${allowedUri}&tls=false`,
      }),
    { code: 'UNSAFE_MONGODB_OPTIONS' },
  );
  assert.throws(
    () =>
      validateTestAdoptionEnvironment({
        ...allowedEnvironment,
        MONGODB_URI: `${allowedUri}&w=0`,
      }),
    { code: 'UNSAFE_MONGODB_OPTIONS' },
  );
  assert.throws(
    () =>
      validateTestAdoptionEnvironment({
        ...allowedEnvironment,
        MONGODB_URI: `${allowedUri}&RetryWrites=false`,
      }),
    { code: 'UNSAFE_MONGODB_OPTIONS' },
  );
  assert.throws(
    () =>
      validateTestAdoptionEnvironment({
        ...allowedEnvironment,
        MONGODB_URI: `${allowedUri}&tls=true&tls=false`,
      }),
    { code: 'UNSAFE_MONGODB_OPTIONS' },
  );
});

test('rejects wrong database names and requires the fixed TEST_ONLY marker', () => {
  assert.throws(
    () => assertFixedDatabaseNames('continuum_db', 'continuum_audit'),
    { code: 'UNAPPROVED_DATABASE' },
  );
  assert.throws(
    () => assertFixedDatabaseNames('continuum_iam', 'other_audit'),
    { code: 'UNAPPROVED_DATABASE' },
  );
  assert.throws(
    () =>
      validateTestAdoptionEnvironment({
        ...allowedEnvironment,
        DATN_TEST_PLATFORM_AUTHORITY_ADOPTION: undefined,
      }),
    { code: 'TEST_ONLY_MARKER_REQUIRED' },
  );
  assert.throws(
    () =>
      validateTestAdoptionEnvironment({
        ...allowedEnvironment,
        DOTENV_CONFIG_PATH: '.env',
      }),
    { code: 'DOTENV_CONTROL_PROHIBITED' },
  );
});

test('requires explicit exact target and rejects arbitrary permissions or mutation flags', () => {
  assert.deepEqual(
    parseTestAdoptionArguments([
      '--target-email',
      'operator@continuum.test',
    ]),
    { targetEmail: 'operator@continuum.test', apply: false },
  );
  assert.deepEqual(
    parseTestAdoptionArguments([
      '--target-email',
      'operator@continuum.test',
      '--apply-test-only',
    ]),
    { targetEmail: 'operator@continuum.test', apply: true },
  );
  assert.throws(
    () => parseTestAdoptionArguments(['--apply-test-only']),
    { code: 'EXPLICIT_TARGET_REQUIRED' },
  );
  assert.throws(
    () =>
      parseTestAdoptionArguments([
        '--target-email',
        'someone@example.com',
      ]),
    { code: 'UNAPPROVED_TARGET' },
  );
  assert.throws(
    () =>
      parseTestAdoptionArguments([
        '--target-email',
        'operator@continuum.test',
        '--permissions',
        'platform.users.account.manage',
      ]),
    { code: 'UNSUPPORTED_ARGUMENT' },
  );
});
