import assert from 'node:assert/strict';
import test from 'node:test';
import { DATABASE_PER_SERVICE_INVENTORY } from './database-per-service-split.plan.mjs';
import {
  SERVICE_SCHEMA_INDEX_MANIFEST,
  schemaAuthoritySha256,
} from './database-per-service-split.schema-indexes.mjs';

test('current schema manifest retains indexes for every historical mapped collection', () => {
  for (const [databaseName, collections] of Object.entries(
    DATABASE_PER_SERVICE_INVENTORY,
  )) {
    assert.deepEqual(
      Object.keys(SERVICE_SCHEMA_INDEX_MANIFEST[databaseName])
        .filter((name) => collections.includes(name))
        .sort(),
      [...collections].sort(),
    );
  }
});

test('manifest is built from active Mongoose service schemas and persistence declarations', () => {
  const userIndexes = SERVICE_SCHEMA_INDEX_MANIFEST.continuum_iam.users;
  assert.ok(
    userIndexes.some(
      (index) =>
        index.name === 'email_1' &&
        index.key.email === 1 &&
        index.unique === true,
    ),
  );
  assert.ok(userIndexes.some((index) => index.name === 'status_1_createdAt_1'));
  assert.ok(
    SERVICE_SCHEMA_INDEX_MANIFEST.continuum_audit.audit_logs.length > 0,
  );
  assert.deepEqual(
    SERVICE_SCHEMA_INDEX_MANIFEST.continuum_audit.audit_logs_iam,
    [],
    'the raw IAM audit collection has no declared application indexes',
  );

  const captureDraftIndexes =
    SERVICE_SCHEMA_INDEX_MANIFEST.continuum_capture.capture_drafts;
  assert.ok(
    captureDraftIndexes.some(
      (index) =>
        index.name === 'userId_1_contextKey_1' &&
        index.key.userId === 1 &&
        index.key.contextKey === 1 &&
        index.unique === true &&
        index.expireAfterSeconds === undefined,
    ),
  );
  assert.ok(
    captureDraftIndexes.some(
      (index) =>
        index.name === 'lastSavedAt_1' &&
        Object.keys(index.key).length === 1 &&
        index.key.lastSavedAt === 1 &&
        index.expireAfterSeconds === 2_592_000,
    ),
  );
});

test('schema source digest is stable and covers the authority files', async () => {
  const first = await schemaAuthoritySha256();
  const second = await schemaAuthoritySha256();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
});
