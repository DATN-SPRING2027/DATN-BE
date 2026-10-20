import test from 'node:test';
import assert from 'node:assert/strict';
import { targetFingerprint } from './organization-membership-backfill.plan.mjs';
import { runProjectSettingsLeaderPermissions } from './20261019-project-settings-leader-permissions.mjs';
import {
  hashLeaderPermissionsReport,
  planProjectSettingsLeaderPermissions,
} from './project-settings-leader-permissions.plan.mjs';

const databaseName = 'continuum_iam';
const uri = 'mongodb://127.0.0.1:27017';
const receiptKey = 'test-receipt-key-with-at-least-32-bytes';
const env = {
  MONGODB_ENABLED: 'false',
  INFRA_ENABLED: 'true',
  PROJECT_SETTINGS_RECEIPT_KEY: receiptKey,
};
const roleId = 'd0e4a4b1835649a8f2867257';
const originalPermissions = ['project.read', 'project.members.list'];

function makeRole(permissions, name = 'Team Leader') {
  return {
    _id: roleId,
    code: 'TEAM_LEADER',
    name,
    isSystem: true,
    permissions: [...permissions],
  };
}

function makePlan(role) {
  return planProjectSettingsLeaderPermissions({
    databaseName,
    targetFingerprint: targetFingerprint(uri, databaseName),
    collectionExists: true,
    objectType: 'collection',
    roles: [role],
  });
}

function makeDatabase(role) {
  let updateCalls = 0;
  let beforeNextUpdate = null;
  const collection = {
    find: () => ({
      sort() {
        return this;
      },
      async toArray() {
        return [structuredClone(role)];
      },
    }),
    async updateOne(filter, update) {
      updateCalls += 1;
      beforeNextUpdate?.();
      beforeNextUpdate = null;
      if (
        role.code !== filter.code ||
        role.name !== filter.name ||
        role.isSystem !== filter.isSystem ||
        String(role._id) !== String(filter._id) ||
        JSON.stringify(role.permissions) !== JSON.stringify(filter.permissions)
      ) {
        return { matchedCount: 0 };
      }
      if (update.$addToSet) {
        for (const permission of update.$addToSet.permissions.$each) {
          if (!role.permissions.includes(permission))
            role.permissions.push(permission);
        }
      }
      if (update.$pullAll) {
        role.permissions = role.permissions.filter(
          (permission) => !update.$pullAll.permissions.includes(permission),
        );
      }
      return { matchedCount: 1 };
    },
  };
  const db = {
    databaseName,
    listCollections: () => ({
      async toArray() {
        return [{ name: 'roles', type: 'collection' }];
      },
    }),
    collection: () => collection,
  };

  return {
    db,
    get updateCalls() {
      return updateCalls;
    },
    get permissions() {
      return [...role.permissions];
    },
    get name() {
      return role.name;
    },
    grantPermission(permission) {
      role.permissions.push(permission);
    },
    renameRole(name) {
      role.name = name;
    },
    renameRoleBeforeNextUpdate(name) {
      beforeNextUpdate = () => {
        role.name = name;
      };
    },
  };
}

function connectionFactory(db) {
  return () => ({
    asPromise: async () => ({ db, close: async () => {} }),
  });
}

async function applyPermissions() {
  const database = makeDatabase(makeRole(originalPermissions));
  const beforePlan = makePlan(makeRole(originalPermissions));
  const applied = await runProjectSettingsLeaderPermissions({
    env,
    uri,
    databaseName,
    mode: 'apply',
    expectedReportSha256: hashLeaderPermissionsReport(beforePlan),
    connectionFactory: connectionFactory(database.db),
  });

  return { database, applied };
}

test('verified apply output carries an apply receipt and rollback preserves earlier permissions', async () => {
  const { database, applied } = await applyPermissions();
  const applyReceipt = applied.result.applyReceipt;
  assert.deepEqual(applyReceipt.role.addedPermissions, [
    'project.visibility.manage',
    'project.update',
  ]);

  const currentPlan = makePlan(makeRole(database.permissions));
  const rolledBack = await runProjectSettingsLeaderPermissions({
    env,
    uri,
    databaseName,
    mode: 'rollback',
    expectedReportSha256: hashLeaderPermissionsReport(currentPlan),
    expectedApplyReceiptHmac: applyReceipt.receiptHmac,
    rollbackReport: applied,
    connectionFactory: connectionFactory(database.db),
  });

  assert.equal(rolledBack.result.action, 'ROLLED_BACK');
  assert.equal(rolledBack.result.removedPermissions, 2);
  assert.deepEqual(database.permissions, originalPermissions);
});

test('rollback rejects a later permission grant without mutating the role', async () => {
  const { database, applied } = await applyPermissions();
  database.grantPermission('organization.memberships.read');
  const currentPlan = makePlan(makeRole(database.permissions));
  const updateCallsBeforeRollback = database.updateCalls;

  await assert.rejects(
    () =>
      runProjectSettingsLeaderPermissions({
        env,
        uri,
        databaseName,
        mode: 'rollback',
        expectedReportSha256: hashLeaderPermissionsReport(currentPlan),
        expectedApplyReceiptHmac: applied.result.applyReceipt.receiptHmac,
        rollbackReport: applied,
        connectionFactory: connectionFactory(database.db),
      }),
    /Role permissions changed since the verified apply/,
  );

  assert.equal(database.updateCalls, updateCallsBeforeRollback);
  assert.deepEqual(database.permissions, [
    ...originalPermissions,
    'project.visibility.manage',
    'project.update',
    'organization.memberships.read',
  ]);
});

test('rollback rejects a self-consistent forged report before writing', async () => {
  const database = makeDatabase(
    makeRole(['project.read', 'project.visibility.manage']),
  );
  const beforePlan = makePlan(
    makeRole(['project.read', 'project.visibility.manage']),
  );
  const applied = await runProjectSettingsLeaderPermissions({
    env,
    uri,
    databaseName,
    mode: 'apply',
    expectedReportSha256: hashLeaderPermissionsReport(beforePlan),
    connectionFactory: connectionFactory(database.db),
  });
  const currentPlan = makePlan(makeRole(database.permissions));
  const forgedPlan = makePlan(makeRole(['project.read', 'project.update']));
  const reportSha256 = hashLeaderPermissionsReport(forgedPlan);
  const receiptPayload = {
    migration: forgedPlan.migration,
    databaseName: forgedPlan.databaseName,
    targetFingerprint: forgedPlan.targetFingerprint,
    sourceReportSha256: reportSha256,
    role: {
      code: forgedPlan.role.code,
      name: forgedPlan.role.name,
      id: forgedPlan.role.id,
      isSystem: forgedPlan.role.isSystem,
      addedPermissions: [...forgedPlan.role.missingPermissions],
      permissionsAfter: [...currentPlan.role.existingPermissions],
    },
  };
  const forgedReport = {
    ...forgedPlan,
    reportSha256,
    result: {
      action: 'APPLIED',
      addedPermissions: receiptPayload.role.addedPermissions.length,
      verified: true,
      applyReceipt: {
        ...receiptPayload,
        receiptHmac: hashLeaderPermissionsReport(receiptPayload),
      },
    },
  };
  const updatesBeforeRollback = database.updateCalls;

  await assert.rejects(
    () =>
      runProjectSettingsLeaderPermissions({
        env,
        uri,
        databaseName,
        mode: 'rollback',
        expectedReportSha256: hashLeaderPermissionsReport(currentPlan),
        expectedApplyReceiptHmac: forgedReport.result.applyReceipt.receiptHmac,
        rollbackReport: forgedReport,
        connectionFactory: connectionFactory(database.db),
      }),
    /apply receipt authentication failed/,
  );

  assert.equal(database.updateCalls, updatesBeforeRollback);
  assert.deepEqual(database.permissions, [
    'project.read',
    'project.visibility.manage',
    'project.update',
  ]);
  assert.equal(applied.result.action, 'APPLIED');
});

test('rollback rejects a renamed Role before writing', async () => {
  const { database, applied } = await applyPermissions();
  database.renameRole('Renamed Leader');
  const renamedPlan = makePlan(makeRole(database.permissions, database.name));
  const updatesBeforeRollback = database.updateCalls;

  await assert.rejects(
    () =>
      runProjectSettingsLeaderPermissions({
        env,
        uri,
        databaseName,
        mode: 'rollback',
        expectedReportSha256: hashLeaderPermissionsReport(renamedPlan),
        expectedApplyReceiptHmac: applied.result.applyReceipt.receiptHmac,
        rollbackReport: applied,
        connectionFactory: connectionFactory(database.db),
      }),
    /Role identity changed since the verified apply/,
  );

  assert.equal(database.updateCalls, updatesBeforeRollback);
});

test('apply requires a receipt key before connecting', async () => {
  let connected = false;

  await assert.rejects(
    () =>
      runProjectSettingsLeaderPermissions({
        env: { ...env, PROJECT_SETTINGS_RECEIPT_KEY: undefined },
        uri,
        databaseName,
        mode: 'apply',
        expectedReportSha256: 'reviewed-report-hash',
        connectionFactory: () => {
          connected = true;
          throw new Error('should not connect');
        },
      }),
    /PROJECT_SETTINGS_RECEIPT_KEY must contain at least 32 bytes/,
  );

  assert.equal(connected, false);
});

test('apply compare-and-set includes the Role name', async () => {
  const database = makeDatabase(makeRole(originalPermissions));
  database.renameRoleBeforeNextUpdate('Renamed during apply');
  const beforePlan = makePlan(makeRole(originalPermissions));

  await assert.rejects(
    () =>
      runProjectSettingsLeaderPermissions({
        env,
        uri,
        databaseName,
        mode: 'apply',
        expectedReportSha256: hashLeaderPermissionsReport(beforePlan),
        connectionFactory: connectionFactory(database.db),
      }),
    /Role changed after preflight/,
  );

  assert.deepEqual(database.permissions, originalPermissions);
  assert.equal(database.updateCalls, 1);
});
