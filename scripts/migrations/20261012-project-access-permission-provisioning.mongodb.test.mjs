import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { runProjectAccessPermissionProvisioning } from './20261012-project-access-permission-provisioning.mjs';

const { MongoClient, ObjectId } = mongoose.mongo;

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? test : test.skip;
const requiredTargetMarker =
  'datn-project-access-permission-provisioning-mongo7-disposable';
const databaseName = 'continuum_iam_project_access_provisioning_integration';
const rolesCollectionName = 'roles';

function assertDisposableReplicaSetTarget() {
  assert.equal(
    process.env.MONGODB_INTEGRATION_TARGET,
    requiredTargetMarker,
    `Set MONGODB_INTEGRATION_TARGET=${requiredTargetMarker} only for the dedicated disposable MongoDB 7 fixture`,
  );
  assert.ok(
    process.env.MONGODB_URI,
    'MONGODB_URI must point to the disposable local replica set',
  );
  const uri = new URL(process.env.MONGODB_URI);
  assert.ok(['mongodb:', 'mongodb+srv:'].includes(uri.protocol));
  assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(uri.hostname));
  assert.ok(['27017', '27019'].includes(uri.port));
  assert.equal(uri.port, process.env.MONGODB_INTEGRATION_PORT ?? '27019');
  assert.equal(uri.username, '');
  assert.equal(uri.password, '');
  assert.equal(uri.searchParams.get('replicaSet'), 'rs0');
}

function toPermissionMap(roles) {
  return Object.fromEntries(
    roles.map((role) => [role.code, [...role.permissions].sort()]),
  );
}

integration(
  'Project Access permission provisioning on disposable MongoDB 7',
  async (t) => {
    assertDisposableReplicaSetTarget();
    const client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5_000,
    });
    await client.connect();
    let testDatabaseCreated = false;

    try {
      const admin = client.db('admin');
      const buildInfo = await admin.command({ buildInfo: 1 });
      assert.equal(buildInfo.versionArray[0], 7);
      const hello = await admin.command({ hello: 1 });
      assert.equal(hello.setName, 'rs0');
      assert.equal(hello.isWritablePrimary, true);
      const marker = await admin
        .collection('datn_migration_test_fixture')
        .findOne({ _id: requiredTargetMarker });
      assert.ok(marker, 'dedicated disposable fixture marker is missing');
      const existingDatabases = await admin
        .admin()
        .listDatabases({ nameOnly: true });
      assert.equal(
        existingDatabases.databases.some((item) => item.name === databaseName),
        false,
        `${databaseName} must not exist before this isolated integration test`,
      );

      const database = client.db(databaseName);
      testDatabaseCreated = true;
      const roles = database.collection(rolesCollectionName);
      const unrelated = database.collection(
        'project_access_permission_sentinel',
      );
      await unrelated.insertOne({ _id: 'preserve', value: 'unchanged' });
      const unrelatedBefore = await unrelated.find().toArray();

      const adminRoleId = new ObjectId();
      await roles.insertOne({
        _id: adminRoleId,
        code: 'ADMIN',
        isSystem: true,
        permissions: ['project.read', 'existing.admin.permission'],
      });

      const missingRoleReport = await runProjectAccessPermissionProvisioning({
        uri: process.env.MONGODB_URI,
        databaseName,
      });
      assert.equal(missingRoleReport.clean, false);
      assert.ok(missingRoleReport.issues.includes('ROLE_MISSING:TEAM_LEADER'));
      await assert.rejects(
        runProjectAccessPermissionProvisioning({
          uri: process.env.MONGODB_URI,
          databaseName,
          mode: 'apply',
          expectedReportSha256: missingRoleReport.reportSha256,
        }),
        /ROLE_MISSING:TEAM_LEADER/,
      );
      assert.deepEqual(
        (await roles.findOne({ code: 'ADMIN' })).permissions,
        ['project.read', 'existing.admin.permission'],
        'missing-role preflight must not partially provision ADMIN',
      );

      const teamLeaderRoleId = new ObjectId();
      await roles.insertOne({
        _id: teamLeaderRoleId,
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: ['project.read', 'existing.team.permission'],
      });
      await roles.insertOne({
        _id: new ObjectId(),
        code: 'MEMBER',
        isSystem: true,
        permissions: ['project.read'],
      });
      const beforeApply = await roles.find().sort({ code: 1 }).toArray();
      const reviewedReport = await runProjectAccessPermissionProvisioning({
        uri: process.env.MONGODB_URI,
        databaseName,
      });
      assert.equal(reviewedReport.clean, true);
      assert.equal(reviewedReport.action, 'ADD_MISSING_PERMISSIONS');
      assert.equal(reviewedReport.roles[0].missingPermissions.length, 2);
      assert.equal(reviewedReport.roles[1].missingPermissions.length, 3);

      await roles.insertOne({
        _id: new ObjectId(),
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: [],
      });
      const duplicateReport = await runProjectAccessPermissionProvisioning({
        uri: process.env.MONGODB_URI,
        databaseName,
      });
      assert.equal(duplicateReport.clean, false);
      assert.ok(duplicateReport.issues.includes('ROLE_DUPLICATE:TEAM_LEADER'));
      await assert.rejects(
        runProjectAccessPermissionProvisioning({
          uri: process.env.MONGODB_URI,
          databaseName,
          mode: 'apply',
          expectedReportSha256: duplicateReport.reportSha256,
        }),
        /ROLE_DUPLICATE:TEAM_LEADER/,
      );
      await roles.deleteOne({
        code: 'TEAM_LEADER',
        _id: { $ne: teamLeaderRoleId },
      });

      await roles.updateOne(
        { _id: adminRoleId },
        { $addToSet: { permissions: 'concurrent.admin.permission' } },
      );
      await assert.rejects(
        runProjectAccessPermissionProvisioning({
          uri: process.env.MONGODB_URI,
          databaseName,
          mode: 'apply',
          expectedReportSha256: reviewedReport.reportSha256,
        }),
        /report differs from the reviewed dry-run/,
        'a stale reviewed plan must not apply after Role data changes',
      );
      await roles.updateOne(
        { _id: adminRoleId },
        { $pull: { permissions: 'concurrent.admin.permission' } },
      );
      const freshReviewedReport = await runProjectAccessPermissionProvisioning({
        uri: process.env.MONGODB_URI,
        databaseName,
      });
      assert.equal(freshReviewedReport.action, 'ADD_MISSING_PERMISSIONS');

      const applied = await runProjectAccessPermissionProvisioning({
        uri: process.env.MONGODB_URI,
        databaseName,
        mode: 'apply',
        expectedReportSha256: freshReviewedReport.reportSha256,
      });
      assert.deepEqual(applied.result, {
        action: 'APPLIED',
        addedPermissions: 5,
        verified: true,
      });
      const afterApply = await roles.find().sort({ code: 1 }).toArray();
      assert.equal(await roles.countDocuments({ code: 'ADMIN' }), 1);
      assert.equal(await roles.countDocuments({ code: 'TEAM_LEADER' }), 1);
      assert.ok(
        afterApply.every(
          (row) => new Set(row.permissions).size === row.permissions.length,
        ),
        'permission arrays must not gain duplicates',
      );
      assert.deepEqual(toPermissionMap(afterApply), {
        ADMIN: [
          'existing.admin.permission',
          'project.leader.manage',
          'project.read',
          'project.visibility.manage',
        ],
        MEMBER: ['project.read'],
        TEAM_LEADER: [
          'existing.team.permission',
          'project.members.add',
          'project.members.list',
          'project.members.remove',
          'project.read',
        ],
      });

      const rerunReport = await runProjectAccessPermissionProvisioning({
        uri: process.env.MONGODB_URI,
        databaseName,
      });
      assert.equal(rerunReport.action, 'NOOP');
      const rerun = await runProjectAccessPermissionProvisioning({
        uri: process.env.MONGODB_URI,
        databaseName,
        mode: 'apply',
        expectedReportSha256: rerunReport.reportSha256,
      });
      assert.deepEqual(rerun.result, {
        action: 'NOOP',
        addedPermissions: 0,
        verified: true,
      });
      assert.deepEqual(
        await roles.find().sort({ code: 1 }).toArray(),
        afterApply,
      );

      const invalidRolePermissions = await roles.findOne({
        code: 'TEAM_LEADER',
      });
      await roles.updateOne(
        { _id: invalidRolePermissions._id },
        { $addToSet: { permissions: 'project.members.role.change' } },
      );
      const invalidReport = await runProjectAccessPermissionProvisioning({
        uri: process.env.MONGODB_URI,
        databaseName,
      });
      assert.equal(invalidReport.clean, false);
      assert.ok(
        invalidReport.issues.includes(
          'PROJECT_PERMISSION_MAPPING_INVALID:TEAM_LEADER',
        ),
      );
      await assert.rejects(
        runProjectAccessPermissionProvisioning({
          uri: process.env.MONGODB_URI,
          databaseName,
          mode: 'apply',
          expectedReportSha256: invalidReport.reportSha256,
        }),
        /PROJECT_PERMISSION_MAPPING_INVALID:TEAM_LEADER/,
      );
      await roles.updateOne(
        { _id: invalidRolePermissions._id },
        { $pull: { permissions: 'project.members.role.change' } },
      );

      await unrelated.updateOne(
        { _id: 'preserve' },
        { $set: { value: 'unchanged' } },
      );
      assert.deepEqual(await unrelated.find().toArray(), unrelatedBefore);
      await roles.updateOne(
        { _id: adminRoleId },
        { $pull: { permissions: 'project.visibility.manage' } },
      );
      const currentPlan = await runProjectAccessPermissionProvisioning({
        uri: process.env.MONGODB_URI,
        databaseName,
      });
      const rolledBack = await runProjectAccessPermissionProvisioning({
        uri: process.env.MONGODB_URI,
        databaseName,
        mode: 'rollback',
        expectedReportSha256: currentPlan.reportSha256,
        rollbackReport: freshReviewedReport,
      });
      assert.deepEqual(rolledBack.result, {
        action: 'ROLLED_BACK',
        removedPermissions: 4,
        verified: true,
      });
      assert.deepEqual(
        toPermissionMap(await roles.find().sort({ code: 1 }).toArray()),
        toPermissionMap(beforeApply),
        'rollback removes only permissions this migration added',
      );
      assert.deepEqual(await unrelated.find().toArray(), unrelatedBefore);

      t.diagnostic(
        `MongoDB ${buildInfo.version}: missing Role blocked before writes; exact five permission additions applied once; rerun was NOOP; disabled role-change permission blocked; rollback removed only migration additions.`,
      );
    } finally {
      if (testDatabaseCreated) await client.db(databaseName).dropDatabase();
      await client.close();
    }
  },
);
