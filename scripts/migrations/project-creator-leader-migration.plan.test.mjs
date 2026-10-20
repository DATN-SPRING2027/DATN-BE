import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPromotionsAtomically,
  resolveDatabaseName,
  runProjectCreatorLeader,
} from './20261019-project-creator-leader.mjs';

test('uses the canonical shared MongoDB database name', () => {
  assert.equal(
    resolveDatabaseName({
      MONGODB_ENABLED: 'true',
      INFRA_ENABLED: 'false',
      MONGODB_DATABASE: 'continuum_shared_test',
      MONGODB_IAM_DATABASE: 'wrong_legacy_override',
    }),
    'continuum_shared_test',
  );
});

test('uses continuum_iam for the dedicated IAM database', () => {
  assert.equal(
    resolveDatabaseName({
      MONGODB_ENABLED: 'false',
      INFRA_ENABLED: 'true',
      MONGODB_DATABASE: 'unused_shared_name',
    }),
    'continuum_iam',
  );
});

test('refuses to run when IAM persistence is disabled or shared database is unnamed', () => {
  assert.throws(
    () =>
      resolveDatabaseName({
        MONGODB_ENABLED: 'false',
        INFRA_ENABLED: 'false',
      }),
    /IAM MongoDB persistence is disabled/,
  );
  assert.throws(
    () =>
      resolveDatabaseName({
        MONGODB_ENABLED: 'true',
        INFRA_ENABLED: 'false',
      }),
    /MONGODB_DATABASE is required/,
  );
});

test('requires the reviewed dry-run hash before opening a connection for apply', async () => {
  for (const expectedReportSha256 of [undefined, '']) {
    await assert.rejects(
      runProjectCreatorLeader({
        uri: 'mongodb://127.0.0.1:27017/test',
        databaseName: 'continuum_iam',
        mode: 'apply',
        expectedReportSha256,
      }),
      /Apply requires the reviewed dry-run report SHA-256/,
    );
  }
});

test('applies all planned role changes inside one session transaction', async () => {
  let transactionCalls = 0;
  const session = {
    withTransaction: async (operation) => {
      transactionCalls += 1;
      return operation();
    },
    endSession: async () => undefined,
  };
  const updateCalls = [];
  const updateOne = async (...args) => {
    updateCalls.push(args);
    return { matchedCount: 1, modifiedCount: 1 };
  };
  const collection = { updateOne };
  const db = { collection: () => collection };
  const connection = { startSession: async () => session };
  const plan = {
    plannedPromotions: [
      {
        assignmentId: '6ad5ce7f4e98d4b07f5fc401',
        organizationId: '02f962598527ec6f886ddac0',
        projectId: '6ad5ce7f4e98d4b07f5fc201',
        creatorId: '850dbf46d92a708bd0c55194',
        fromRoleId: '6ad5ce7f4e98d4b07f5fc002',
        toRoleId: '6ad5ce7f4e98d4b07f5fc001',
      },
    ],
  };

  assert.equal(await applyPromotionsAtomically(connection, db, plan), 1);
  assert.equal(transactionCalls, 1);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0][2].session, session);
  assert.equal(updateCalls[0][0].roleCode, 'MEMBER');
});

test('aborts the transaction and closes the session when an assignment changed', async () => {
  let transactionCalls = 0;
  let endSessionCalls = 0;
  const session = {
    withTransaction: async (operation) => {
      transactionCalls += 1;
      return operation();
    },
    endSession: async () => {
      endSessionCalls += 1;
    },
  };
  let updates = 0;
  const collection = {
    updateOne: async () => {
      updates += 1;
      return { matchedCount: updates === 1 ? 1 : 0, modifiedCount: 1 };
    },
  };
  const db = { collection: () => collection };
  const connection = { startSession: async () => session };
  const promotion = {
    assignmentId: '6ad5ce7f4e98d4b07f5fc401',
    organizationId: '02f962598527ec6f886ddac0',
    projectId: '6ad5ce7f4e98d4b07f5fc201',
    creatorId: '850dbf46d92a708bd0c55194',
    fromRoleId: '6ad5ce7f4e98d4b07f5fc002',
    toRoleId: '6ad5ce7f4e98d4b07f5fc001',
  };

  await assert.rejects(
    applyPromotionsAtomically(connection, db, {
      plannedPromotions: [
        promotion,
        { ...promotion, assignmentId: '6ad5ce7f4e98d4b07f5fc402' },
      ],
    }),
    /record changed during migration/,
  );
  assert.equal(transactionCalls, 1);
  assert.equal(endSessionCalls, 1);
});
