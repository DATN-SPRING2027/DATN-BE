import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_REMEDIATION_INDEX_SPECS,
  hashAuditRemediationPlan,
  planAuditRemediationIndexes,
} from './20261127-audit-remediation-indexes.mjs';

test('plans CREATE for all additive audit remediation indexes on empty collections', () => {
  const plan = planAuditRemediationIndexes({
    target: 'fingerprint-test',
    existingByNamespace: {},
  });
  assert.equal(plan.clean, true);
  assert.equal(plan.summary.total, AUDIT_REMEDIATION_INDEX_SPECS.length);
  assert.equal(plan.summary.create, AUDIT_REMEDIATION_INDEX_SPECS.length);
  assert.equal(plan.summary.noop, 0);
  assert.equal(plan.summary.block, 0);
  assert.match(hashAuditRemediationPlan(plan), /^[a-f0-9]{64}$/);
});

test('marks exact existing indexes (including partial & unique options) as NOOP', () => {
  const existingByNamespace = {};
  for (const spec of AUDIT_REMEDIATION_INDEX_SPECS) {
    const ns = `${spec.database}.${spec.collection}`;
    existingByNamespace[ns] ??= [{ name: '_id_', key: { _id: 1 } }];
    existingByNamespace[ns].push({
      name: spec.name,
      key: spec.key,
      ...(spec.unique ? { unique: true } : {}),
      ...(spec.sparse ? { sparse: true } : {}),
      ...(spec.partialFilterExpression
        ? { partialFilterExpression: spec.partialFilterExpression }
        : {}),
    });
  }
  const plan = planAuditRemediationIndexes({
    target: 'fingerprint-test',
    existingByNamespace,
  });
  assert.equal(plan.clean, true);
  assert.equal(plan.summary.create, 0);
  assert.equal(plan.summary.noop, AUDIT_REMEDIATION_INDEX_SPECS.length);
  assert.equal(plan.summary.block, 0);
});

test('plans CREATE cleanly alongside legacy sparse organizationId_1_projectId_1_dedupeKey_1 index (no collision)', () => {
  const plan = planAuditRemediationIndexes({
    target: 'fingerprint-test',
    existingByNamespace: {
      'continuum_capture.ai_token_usage_logs': [
        { name: '_id_', key: { _id: 1 } },
        {
          name: 'organizationId_1_projectId_1_dedupeKey_1',
          key: { organizationId: 1, projectId: 1, dedupeKey: 1 },
          unique: true,
          sparse: true,
        },
      ],
    },
  });
  assert.equal(plan.clean, true);
  assert.equal(plan.summary.block, 0);
  const dedupeEntry = plan.indexes.find(
    (entry) => entry.name === 'ai_token_usage_org_project_dedupe_unique',
  );
  assert.equal(dedupeEntry?.action, 'CREATE');
  assert.deepEqual(dedupeEntry?.key, {
    organizationId: 1,
    dedupeKey: 1,
    projectId: 1,
  });
});

test('blocks conflicting index options or mismatched same-name keys without modifying existing indexes', () => {
  const plan = planAuditRemediationIndexes({
    target: 'fingerprint-test',
    existingByNamespace: {
      'continuum_capture.ai_token_usage_logs': [
        { name: '_id_', key: { _id: 1 } },
        {
          name: 'ai_token_usage_org_project_dedupe_unique',
          key: { organizationId: 1, dedupeKey: 1, projectId: 1 },
          unique: false, // conflict: missing unique & partialFilterExpression
        },
      ],
      'continuum_iam.projects': [
        {
          name: 'iam_projects_org_status_updated_desc',
          key: { organizationId: 1 }, // conflict: wrong key under reserved name
        },
      ],
    },
  });
  assert.equal(plan.clean, false);
  assert.equal(plan.summary.block, 2);
});

test('blocks unique index creation when historical duplicate keys exist and scopes rollback to CREATE-only indexes', () => {
  const existingByNamespace = {
    'continuum_iam.projects': [
      { name: '_id_', key: { _id: 1 } },
      {
        name: 'iam_projects_org_status_updated_desc',
        key: { organizationId: 1, status: 1, updatedAt: -1 },
      },
    ],
  };
  const plan = planAuditRemediationIndexes({
    target: 'fingerprint-test',
    existingByNamespace,
    duplicatesByIndexName: {
      ai_token_usage_org_project_dedupe_unique: [{ count: 2 }],
    },
  });
  assert.equal(plan.clean, false);
  assert.equal(plan.summary.block, 1);
  const blocked = plan.indexes.find(
    (entry) => entry.name === 'ai_token_usage_org_project_dedupe_unique',
  );
  assert.equal(blocked?.action, 'BLOCK');
  assert.deepEqual(blocked?.duplicateKeyGroups, [{ count: 2 }]);
  assert.equal(
    plan.rollbackDropIndexes.some(
      (entry) => entry.name === 'iam_projects_org_status_updated_desc',
    ),
    false,
  );
  assert.equal(
    plan.rollbackDropIndexes.some(
      (entry) => entry.name === 'ai_token_usage_org_project_dedupe_unique',
    ),
    false,
  );
  assert.equal(plan.rollbackDropIndexes.length, plan.summary.create);
});
