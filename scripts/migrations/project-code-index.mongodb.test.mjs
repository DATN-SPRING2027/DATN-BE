import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import mongoose from 'mongoose';
import { inspectProjectCodeIndex } from './project-code-index.inspect.mjs';

const integration = process.env.MONGODB_INTEGRATION === 'true' ? test : test.skip;

integration('duplicate dry-run blocks apply; simple unique index enforces organization/code', async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI is required');
  const databaseName = `pf_idx_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  let collectionCreated = false;
  const connection = mongoose.createConnection(process.env.MONGODB_URI, {
    dbName: databaseName,
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await connection.asPromise();
    const db = connection.db;
    assert.equal(db.databaseName, databaseName);
    await db.createCollection('projects', { collation: { locale: 'en', strength: 2 } });
    collectionCreated = true;
    const collection = db.collection('projects');
    const first = { organizationId: 'org-a', code: 'P1' };
    const duplicate = await collection.insertMany([{ ...first }, { ...first }]);
    const blocked = await inspectProjectCodeIndex({ db, targetFingerprint: 'test-only' });
    assert.equal(blocked.action, 'BLOCKED');
    assert.deepEqual(blocked.duplicatePairs, [{ organizationId: 'org-a', code: 'P1', count: 2 }]);
    assert.deepEqual((await collection.indexes()).map((item) => item.name), ['_id_']);

    await collection.deleteOne({ _id: duplicate.insertedIds[1] });
    const lowerCase = await collection.insertOne({ organizationId: 'org-a', code: 'p1' });
    const normalizedDuplicate = await inspectProjectCodeIndex({ db, targetFingerprint: 'test-only' });
    assert.equal(normalizedDuplicate.action, 'BLOCKED');
    assert.deepEqual(normalizedDuplicate.duplicatePairs, [
      { organizationId: 'org-a', code: 'P1', count: 2 },
    ]);
    assert.deepEqual(normalizedDuplicate.nonCanonicalProjectCodes, [{
      projectId: lowerCase.insertedId,
      organizationId: 'org-a',
      code: 'p1',
      normalizedCode: 'P1',
    }]);
    assert.deepEqual((await collection.indexes()).map((item) => item.name), ['_id_']);

    await collection.deleteOne({ _id: lowerCase.insertedId });
    const nonCanonical = await collection.insertOne({ organizationId: 'org-a', code: ' P2 ' });
    const nonCanonicalReport = await inspectProjectCodeIndex({ db, targetFingerprint: 'test-only' });
    assert.equal(nonCanonicalReport.action, 'BLOCKED');
    assert.deepEqual(nonCanonicalReport.duplicatePairs, []);
    assert.deepEqual(nonCanonicalReport.nonCanonicalProjectCodes, [{
      projectId: nonCanonical.insertedId,
      organizationId: 'org-a',
      code: ' P2 ',
      normalizedCode: 'P2',
    }]);
    assert.deepEqual((await collection.indexes()).map((item) => item.name), ['_id_']);

    await collection.deleteOne({ _id: nonCanonical.insertedId });
    const ready = await inspectProjectCodeIndex({ db, targetFingerprint: 'test-only' });
    assert.equal(ready.action, 'CREATE_UNIQUE_INDEX');
    assert.deepEqual(ready.duplicatePairs, []);
    assert.deepEqual(ready.nonCanonicalProjectCodes, []);
    await collection.createIndex(ready.desiredIndex.key, {
      name: ready.desiredIndex.name,
      unique: true,
      collation: { locale: 'simple' },
    });
    const verified = await inspectProjectCodeIndex({ db, targetFingerprint: 'test-only' });
    assert.equal(verified.action, 'NOOP');
    await assert.rejects(collection.insertOne(first), (error) => error.code === 11000);
    await collection.insertOne({ organizationId: 'org-b', code: 'P1' });
    await db.createCollection('projects_view', { viewOn: 'projects', pipeline: [] });
    const viewPlan = await inspectProjectCodeIndex({
      db, collectionName: 'projects_view', targetFingerprint: 'test-only',
    });
    assert.equal(viewPlan.action, 'BLOCKED');
    assert.equal(viewPlan.conflictingObjectType, 'view');
  } catch (error) {
    process.stderr.write(`Integration assertion failed: ${error.stack ?? error}\n`);
    throw error;
  } finally {
    if (collectionCreated && connection.readyState === 1 && connection.db.databaseName === databaseName)
      await connection.db.dropDatabase();
    await connection.close();
  }
});
