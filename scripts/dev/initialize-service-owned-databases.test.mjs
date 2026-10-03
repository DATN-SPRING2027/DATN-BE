import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import {
  buildInitializationPlan,
  initializeServiceOwnedDatabases,
  seedDevelopmentDataset,
  validateLocalDevelopmentEnvironment,
} from './initialize-service-owned-databases.mjs';

const targetUri = 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const approvedEnvironment = {
  NODE_ENV: 'development',
  INFRA_ENABLED: 'true',
  DATN_DEV_DB_INITIALIZATION: 'service-owned-local-only',
  MONGODB_URI: targetUri,
};

function indexName(key) {
  return Object.entries(key)
    .map(([field, direction]) => `${field}_${direction}`)
    .join('_');
}

function sameValue(left, right) {
  if (left instanceof mongoose.Types.ObjectId) return left.equals(right);
  if (right instanceof mongoose.Types.ObjectId) return right.equals(left);
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, i) => sameValue(value, right[i]))
    );
  }
  return Object.is(left, right);
}

function matches(document, filter) {
  return Object.entries(filter).every(([field, expected]) =>
    sameValue(document[field], expected),
  );
}

class FakeCollection {
  constructor(name) {
    this.name = name;
    this.documents = [];
    this.indexDefinitions = [{ name: '_id_', key: { _id: 1 }, unique: true }];
  }

  async indexes() {
    return this.indexDefinitions;
  }

  aggregate() {
    return { toArray: async () => [] };
  }

  async createIndex(key, options) {
    const name = options.name ?? indexName(key);
    this.indexDefinitions.push({ name, key: { ...key }, ...options });
    return name;
  }

  async findOne(filter) {
    return this.documents.find((document) => matches(document, filter)) ?? null;
  }

  async updateOne(filter, update, options) {
    const existing = await this.findOne(filter);
    if (existing) return { matchedCount: 1, upsertedCount: 0 };
    if (!options?.upsert) return { matchedCount: 0, upsertedCount: 0 };
    this.documents.push(update.$setOnInsert);
    return { matchedCount: 0, upsertedCount: 1 };
  }
}

class FakeDatabase {
  constructor(databaseName) {
    this.databaseName = databaseName;
    this.collections = new Map();
  }

  listCollections(filter = {}) {
    const names = [...this.collections.keys()].filter(
      (name) => !filter.name || name === filter.name,
    );
    return { toArray: async () => names.map((name) => ({ name })) };
  }

  async createCollection(name) {
    if (this.collections.has(name)) {
      const error = new Error('already exists');
      error.code = 48;
      throw error;
    }
    this.collections.set(name, new FakeCollection(name));
    return this.collections.get(name);
  }

  collection(name) {
    if (!this.collections.has(name))
      this.collections.set(name, new FakeCollection(name));
    return this.collections.get(name);
  }
}

class FakeConnection {
  constructor() {
    this.databases = new Map();
  }

  useDb(databaseName) {
    if (!this.databases.has(databaseName)) {
      this.databases.set(databaseName, new FakeDatabase(databaseName));
    }
    return { db: this.databases.get(databaseName) };
  }
}

test('requires explicit development-only loopback Mongo target and never echoes URI', () => {
  assert.equal(
    validateLocalDevelopmentEnvironment(approvedEnvironment),
    targetUri,
  );
  assert.throws(
    () =>
      validateLocalDevelopmentEnvironment({
        ...approvedEnvironment,
        MONGODB_URI: 'mongodb://local-user:secret@shared.example.test/db',
      }),
    (error) => !error.message.includes('secret'),
  );
  assert.throws(() =>
    validateLocalDevelopmentEnvironment({
      ...approvedEnvironment,
      MONGODB_URI: 'mongodb://127.0.0.1:27017/continuum_iam',
    }),
  );
  assert.throws(() =>
    validateLocalDevelopmentEnvironment({
      ...approvedEnvironment,
      DATN_DEV_DB_INITIALIZATION: undefined,
    }),
  );
  assert.throws(() =>
    validateLocalDevelopmentEnvironment({
      ...approvedEnvironment,
      NODE_ENV: 'production',
    }),
  );
});

test('derives all service collections and indexes from current Mongoose schemas', () => {
  const plan = buildInitializationPlan();
  assert.deepEqual(
    plan.map(({ databaseName }) => databaseName).sort(),
    [
      'continuum_iam',
      'continuum_capture',
      'continuum_jira',
      'continuum_lifecycle',
      'continuum_chat',
      'continuum_handover',
      'continuum_ingestion',
      'continuum_notification',
      'continuum_audit',
    ].sort(),
  );
  assert.equal(
    plan.some(({ databaseName }) => databaseName === 'continuum_db'),
    false,
  );

  const captureDrafts = plan
    .find(({ databaseName }) => databaseName === 'continuum_capture')
    .collections.find(({ name }) => name === 'capture_drafts');
  assert.deepEqual(
    captureDrafts.indexes.map(({ key, options }) => ({ key, options })),
    [
      { key: { userId: 1, contextKey: 1 }, options: { unique: true } },
      { key: { lastSavedAt: 1 }, options: { expireAfterSeconds: 2_592_000 } },
    ],
  );

  const auditCollection = plan
    .find(({ databaseName }) => databaseName === 'continuum_audit')
    .collections.find(({ name }) => name === 'audit_logs_iam');
  assert.deepEqual(auditCollection.indexes, []);
});

test('creates missing schemas/indexes idempotently without replacing existing data', async () => {
  const connection = new FakeConnection();
  const plan = buildInitializationPlan();
  const first = await initializeServiceOwnedDatabases(connection, plan);
  const indexCount = [...connection.databases.values()].reduce(
    (total, database) =>
      total +
      [...database.collections.values()].reduce(
        (count, collection) => count + collection.indexDefinitions.length - 1,
        0,
      ),
    0,
  );
  const second = await initializeServiceOwnedDatabases(connection, plan);
  assert.equal(first.databases, 9);
  assert.equal(first.createdCollections, first.collections);
  assert.equal(first.createdIndexes, indexCount);
  assert.equal(second.createdCollections, 0);
  assert.equal(second.createdIndexes, 0);
});

test('creates only fresh deterministic synthetic IAM data and reruns without overwrites', async () => {
  const connection = new FakeConnection();
  const password = 'test-only password not shown in output';
  const first = await seedDevelopmentDataset(connection, password);
  const iam = connection.useDb('continuum_iam').db;
  const originalPasswordHash =
    iam.collection('users').documents[0].passwordHash;
  const second = await seedDevelopmentDataset(connection, password);

  assert.equal(first.syntheticAccountCount, 3);
  assert.deepEqual(first.created, {
    organizations: 1,
    users: 3,
    memberships: 3,
    roles: 3,
    roleAssignments: 5,
    projects: 1,
    projectMemberships: 2,
  });
  assert.deepEqual(second.created, {
    organizations: 0,
    users: 0,
    memberships: 0,
    roles: 0,
    roleAssignments: 0,
    projects: 0,
    projectMemberships: 0,
  });
  assert.equal(iam.collection('users').documents.length, 3);
  assert.equal(
    iam.collection('users').documents[0].passwordHash,
    originalPasswordHash,
  );
  assert.equal(connection.databases.has('continuum_audit'), false);
});
