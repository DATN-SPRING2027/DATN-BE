import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planProjectSettingsLeaderPermissions,
  hashLeaderPermissionsReport,
  createLeaderPermissionsApplyReceipt,
  getLeaderPermissionsRollbackAdditions,
} from './project-settings-leader-permissions.plan.mjs';

const receiptKey = 'test-receipt-key-with-at-least-32-bytes';

const baseContext = {
  databaseName: 'continuum_iam',
  targetFingerprint: 'target-hash-123',
  collectionExists: true,
  objectType: 'collection',
};

test('plans adding both permissions when TEAM_LEADER exists and is missing both', () => {
  const plan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: ['project.read', 'project.members.list'],
      },
    ],
  });

  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'ADD_MISSING_PERMISSIONS');
  assert.deepEqual(plan.role.missingPermissions, [
    'project.visibility.manage',
    'project.update',
  ]);
  assert.deepEqual(plan.role.existingPermissions, [
    'project.read',
    'project.members.list',
  ]);
  assert.deepEqual(plan.role.expectedPermissions, [
    'project.read',
    'project.members.list',
    'project.visibility.manage',
    'project.update',
  ]);
});

test('plans adding only the missing permission when TEAM_LEADER is missing 1', () => {
  const plan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: [
          'project.read',
          'project.members.list',
          'project.visibility.manage',
        ],
      },
    ],
  });

  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'ADD_MISSING_PERMISSIONS');
  assert.deepEqual(plan.role.missingPermissions, ['project.update']);
  assert.deepEqual(plan.role.existingPermissions, [
    'project.read',
    'project.members.list',
    'project.visibility.manage',
  ]);
});

test('plans NOOP when TEAM_LEADER already has both approved permissions', () => {
  const plan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: [
          'project.read',
          'project.members.list',
          'project.visibility.manage',
          'project.update',
        ],
      },
    ],
  });

  assert.equal(plan.clean, true);
  assert.equal(plan.action, 'NOOP');
  assert.deepEqual(plan.role.missingPermissions, []);
  assert.deepEqual(plan.role.expectedPermissions, [
    'project.read',
    'project.members.list',
    'project.visibility.manage',
    'project.update',
  ]);
});

test('preserves existing permissions without overwriting them', () => {
  const customPermissions = [
    'project.read',
    'project.custom.view',
    'project.members.list',
  ];
  const plan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: customPermissions,
      },
    ],
  });

  assert.equal(plan.clean, true);
  assert.deepEqual(plan.role.existingPermissions, customPermissions);
  assert.deepEqual(plan.role.permissionsUnchanged, customPermissions);
  assert.ok(plan.role.expectedPermissions.includes('project.custom.view'));
});

test('blocks when TEAM_LEADER role is missing or duplicate', () => {
  const missing = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [],
  });
  assert.equal(missing.clean, false);
  assert.deepEqual(missing.issues, ['ROLE_MISSING:TEAM_LEADER']);
  assert.equal(missing.action, 'BLOCKED');

  const duplicate = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: [],
      },
      {
        _id: 'e0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: [],
      },
    ],
  });
  assert.equal(duplicate.clean, false);
  assert.ok(duplicate.issues.includes('ROLE_DUPLICATE:TEAM_LEADER'));
  assert.equal(duplicate.action, 'BLOCKED');
});

test('blocks when TEAM_LEADER is not a system role', () => {
  const plan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: false,
        permissions: [],
      },
    ],
  });
  assert.equal(plan.clean, false);
  assert.ok(plan.issues.includes('ROLE_NOT_SYSTEM:TEAM_LEADER'));
  assert.equal(plan.action, 'BLOCKED');
});

test('blocks when permissions field is malformed or contains duplicates', () => {
  const notArray = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: 'project.read',
      },
    ],
  });
  assert.equal(notArray.clean, false);
  assert.ok(notArray.issues.includes('PERMISSIONS_NOT_ARRAY:TEAM_LEADER'));

  const duplicated = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: ['project.read', 'project.read'],
      },
    ],
  });
  assert.equal(duplicated.clean, false);
  assert.ok(duplicated.issues.includes('PERMISSIONS_DUPLICATED:TEAM_LEADER'));
});

function createApplyReport(preApplyPlan, afterApplyPlan) {
  const reportSha256 = hashLeaderPermissionsReport(preApplyPlan);
  const applyReceipt = createLeaderPermissionsApplyReceipt(
    preApplyPlan,
    afterApplyPlan,
    preApplyPlan.role.missingPermissions,
    receiptKey,
  );
  return {
    ...preApplyPlan,
    reportSha256,
    result: {
      action: 'APPLIED',
      addedPermissions: applyReceipt.role.addedPermissions.length,
      verified: true,
      applyReceipt,
    },
  };
}

test('rollback requires the verified apply receipt and unchanged post-apply role', () => {
  const preApplyPlan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: ['project.read', 'project.members.list'],
      },
    ],
  });

  const afterApplyPlan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: preApplyPlan.role.expectedPermissions,
      },
    ],
  });
  const applyReport = createApplyReport(preApplyPlan, afterApplyPlan);

  const rollback = getLeaderPermissionsRollbackAdditions(
    applyReport,
    afterApplyPlan,
    applyReport.result.applyReceipt.receiptHmac,
    receiptKey,
  );
  assert.equal(rollback.id, 'd0e4a4b1835649a8f2867257');
  assert.deepEqual(rollback.permissions, [
    'project.visibility.manage',
    'project.update',
  ]);
});

test('rollback rejects a saved pre-apply dry-run report without apply provenance', () => {
  const preApplyPlan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: ['project.read'],
      },
    ],
  });

  const report = {
    ...preApplyPlan,
    reportSha256: hashLeaderPermissionsReport(preApplyPlan),
  };

  assert.throws(
    () => getLeaderPermissionsRollbackAdditions(report, preApplyPlan, 'hash'),
    /verified apply report and its receipt/,
  );
});

test('rollback rejects a changed role and a mismatched apply receipt HMAC', () => {
  const preApplyPlan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: ['project.read'],
      },
    ],
  });
  const afterApplyPlan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: preApplyPlan.role.expectedPermissions,
      },
    ],
  });
  const applyReport = createApplyReport(preApplyPlan, afterApplyPlan);
  const laterGrantPlan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        isSystem: true,
        permissions: [
          ...afterApplyPlan.role.existingPermissions,
          'organization.memberships.read',
        ],
      },
    ],
  });

  assert.throws(
    () =>
      getLeaderPermissionsRollbackAdditions(
        applyReport,
        laterGrantPlan,
        applyReport.result.applyReceipt.receiptHmac,
        receiptKey,
      ),
    /Role permissions changed since the verified apply/,
  );
  assert.throws(
    () =>
      getLeaderPermissionsRollbackAdditions(
        applyReport,
        afterApplyPlan,
        'incorrect-receipt-hash',
        receiptKey,
      ),
    /apply receipt authentication failed/,
  );
});

test('rollback rejects a self-consistent forged apply report without the receipt key', () => {
  const preApplyPlan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        name: 'Team Leader',
        isSystem: true,
        permissions: ['project.read', 'project.update'],
      },
    ],
  });
  const currentPlan = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        name: 'Team Leader',
        isSystem: true,
        permissions: [
          'project.read',
          'project.update',
          'project.visibility.manage',
        ],
      },
    ],
  });
  const reportSha256 = hashLeaderPermissionsReport(preApplyPlan);
  const receiptPayload = {
    migration: preApplyPlan.migration,
    databaseName: preApplyPlan.databaseName,
    targetFingerprint: preApplyPlan.targetFingerprint,
    sourceReportSha256: reportSha256,
    role: {
      code: preApplyPlan.role.code,
      name: preApplyPlan.role.name,
      id: preApplyPlan.role.id,
      isSystem: preApplyPlan.role.isSystem,
      addedPermissions: [...preApplyPlan.role.missingPermissions],
      permissionsAfter: [...currentPlan.role.existingPermissions],
    },
  };
  const forgedReport = {
    ...preApplyPlan,
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

  assert.throws(
    () =>
      getLeaderPermissionsRollbackAdditions(
        forgedReport,
        currentPlan,
        forgedReport.result.applyReceipt.receiptHmac,
        receiptKey,
      ),
    /apply receipt authentication failed/,
  );
});

test('rollback rejects a Role rename after apply', () => {
  const before = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        name: 'Team Leader',
        isSystem: true,
        permissions: ['project.read'],
      },
    ],
  });
  const after = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        name: 'Team Leader',
        isSystem: true,
        permissions: before.role.expectedPermissions,
      },
    ],
  });
  const renamed = planProjectSettingsLeaderPermissions({
    ...baseContext,
    roles: [
      {
        _id: 'd0e4a4b1835649a8f2867257',
        code: 'TEAM_LEADER',
        name: 'Renamed Leader',
        isSystem: true,
        permissions: after.role.existingPermissions,
      },
    ],
  });
  const applyReport = createApplyReport(before, after);

  assert.throws(
    () =>
      getLeaderPermissionsRollbackAdditions(
        applyReport,
        renamed,
        applyReport.result.applyReceipt.receiptHmac,
        receiptKey,
      ),
    /Role identity changed since the verified apply/,
  );
});
