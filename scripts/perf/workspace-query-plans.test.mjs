import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  cleanupScratchDatabase as cleanupPlanDb,
  createUniqueScratchDbName as createPlanDbName,
} from './workspace-query-plans.mjs';
import {
  cleanupScratchDatabase as cleanupOrgDb,
  createUniqueScratchDbName as createOrgDbName,
} from './workspace-org-queries.mjs';

const scripts = [
  './workspace-query-plans.mjs',
  './workspace-org-queries.mjs',
].map((name) => fileURLToPath(new URL(name, import.meta.url)));

const openapiPath = fileURLToPath(
  new URL('../../docs/workspace/04-api-inventory.yaml', import.meta.url),
);

function run(script, uri) {
  return spawnSync(
    process.execPath,
    [script, '--uri', uri, '--iterations', '1'],
    {
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
}

for (const script of scripts) {
  const label = script.split(/[\\/]/).pop();

  test(`${label} refuses mongodb+srv URIs before connecting`, () => {
    const result = run(script, 'mongodb+srv://user:pass@cluster.example.net/');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Only mongodb:\/\/ URIs are allowed/);
  });

  test(`${label} refuses non-loopback mongodb:// hosts before connecting`, () => {
    const result = run(script, 'mongodb://db.example.net:27017/');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing non-loopback host: db\.example\.net/);
  });
}

test('createUniqueScratchDbName produces distinct per-run database names', () => {
  const a = createPlanDbName();
  const b = createPlanDbName();
  const c = createOrgDbName();
  assert.notEqual(a, b);
  assert.match(a, /^datn_ws_perf_\d+_\d+_[0-9a-f]{8}$/);
  assert.match(c, /^datn_ws_org_perf_\d+_\d+_[0-9a-f]{8}$/);
});

test('cleanupScratchDatabase propagates dropDatabase errors while still closing the client', async () => {
  for (const cleanup of [cleanupPlanDb, cleanupOrgDb]) {
    let closed = false;
    const fakeClient = {
      db: () => ({
        dropDatabase: async () => {
          throw new Error('dropDatabase failed: disk full');
        },
      }),
      close: async () => {
        closed = true;
      },
    };
    await assert.rejects(
      () => cleanup(fakeClient, 'datn_ws_perf_test', true),
      /dropDatabase failed: disk full/,
    );
    assert.equal(closed, true);
  }
});

function validateAgainstOpenApiSchema(spec, schemaOrRef, value, path = '$') {
  if (schemaOrRef.$ref) {
    const refName = schemaOrRef.$ref.replace('#/components/schemas/', '');
    const target = spec.components?.schemas?.[refName];
    assert.ok(target, `Missing $ref target ${schemaOrRef.$ref} at ${path}`);
    return validateAgainstOpenApiSchema(spec, target, value, path);
  }
  if (schemaOrRef.allOf) {
    for (const sub of schemaOrRef.allOf) {
      validateAgainstOpenApiSchema(spec, sub, value, path);
    }
    return;
  }
  if (schemaOrRef.oneOf) {
    const matched = schemaOrRef.oneOf.some((sub) => {
      try {
        validateAgainstOpenApiSchema(spec, sub, value, path);
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(matched, `Value at ${path} did not match any oneOf branch`);
    return;
  }

  const allowedTypes = Array.isArray(schemaOrRef.type)
    ? schemaOrRef.type
    : [schemaOrRef.type];
  if (value === null) {
    assert.ok(
      allowedTypes.includes('null'),
      `Null not allowed at ${path} (expected ${allowedTypes.join('|')})`,
    );
    return;
  }

  if (allowedTypes.includes('object')) {
    assert.equal(typeof value, 'object', `Expected object at ${path}`);
    assert.ok(!Array.isArray(value), `Expected object, got array at ${path}`);
    for (const req of schemaOrRef.required ?? []) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(value, req),
        `Missing required property '${req}' at ${path}`,
      );
    }
    const props = schemaOrRef.properties ?? {};
    if (schemaOrRef.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(props, key),
          `Additional property '${key}' is not allowed at ${path}`,
        );
      }
    }
    for (const [key, propVal] of Object.entries(value)) {
      if (props[key]) {
        validateAgainstOpenApiSchema(
          spec,
          props[key],
          propVal,
          `${path}.${key}`,
        );
      }
    }
    return;
  }

  if (allowedTypes.includes('array')) {
    assert.ok(Array.isArray(value), `Expected array at ${path}`);
    if (schemaOrRef.maxItems !== undefined) {
      assert.ok(value.length <= schemaOrRef.maxItems, `maxItems at ${path}`);
    }
    for (let i = 0; i < value.length; i += 1) {
      validateAgainstOpenApiSchema(
        spec,
        schemaOrRef.items,
        value[i],
        `${path}[${i}]`,
      );
    }
    return;
  }

  if (allowedTypes.includes('string')) {
    assert.equal(typeof value, 'string', `Expected string at ${path}`);
    if (schemaOrRef.enum) {
      assert.ok(
        schemaOrRef.enum.includes(value),
        `Value '${value}' not in enum at ${path}`,
      );
    }
    if (schemaOrRef.pattern) {
      assert.match(
        value,
        new RegExp(schemaOrRef.pattern),
        `Pattern at ${path}`,
      );
    }
    return;
  }

  if (allowedTypes.includes('integer')) {
    assert.ok(Number.isInteger(value), `Expected integer at ${path}`);
    if (schemaOrRef.minimum !== undefined) {
      assert.ok(value >= schemaOrRef.minimum, `Minimum at ${path}`);
    }
    return;
  }

  if (allowedTypes.includes('boolean')) {
    assert.equal(typeof value, 'boolean', `Expected boolean at ${path}`);
  }
}

test('04-api-inventory.yaml schemas accept valid TaskDetail, OrganizationTask, ProjectSprint, OrganizationTaskSummary and TaskHistoryEntry samples', () => {
  const spec = yaml.load(readFileSync(openapiPath, 'utf8'));
  const schemas = spec.components.schemas;

  const baseTaskSample = {
    id: '6717b0000000000000000001',
    projectId: '6717b0000000000000000002',
    title: 'Implement Task API contract',
    createdBy: '6717b0000000000000000003',
    createdAt: '2026-10-22T12:00:00.000Z',
    updatedAt: '2026-10-22T12:30:00.000Z',
    version: 2,
    key: 'DATN-42',
    status: 'IN_REVIEW',
    type: 'TASK',
    priority: 'HIGH',
    assigneeId: '6717b0000000000000000004',
    dueDate: '2026-10-30T00:00:00.000Z',
    startDate: '2026-10-22T00:00:00.000Z',
    parentId: null,
    sprintId: '6717b0000000000000000005',
    labels: ['backend', 'contract'],
    subtaskCounts: { total: 2, done: 1 },
  };

  validateAgainstOpenApiSchema(spec, schemas.Task, baseTaskSample, 'Task');

  const taskDetailSample = {
    ...baseTaskSample,
    description: 'Detailed description',
    steps: [{ id: 'step-1', text: 'Write OpenAPI', done: true }],
    completedAt: null,
  };
  validateAgainstOpenApiSchema(
    spec,
    schemas.TaskDetail,
    taskDetailSample,
    'TaskDetail',
  );

  const orgTaskSample = {
    ...baseTaskSample,
    projectName: 'Continuum Core',
    projectCode: 'DATN',
  };
  validateAgainstOpenApiSchema(
    spec,
    schemas.OrganizationTask,
    orgTaskSample,
    'OrganizationTask',
  );

  const sprintSample = {
    id: '6717b0000000000000000005',
    projectId: '6717b0000000000000000002',
    name: 'Sprint 1',
    goal: 'Ship Task MVP',
    status: 'ACTIVE',
    startDate: '2026-10-20T00:00:00.000Z',
    endDate: '2026-11-03T00:00:00.000Z',
    createdBy: '6717b0000000000000000003',
    createdAt: '2026-10-20T00:00:00.000Z',
    completedAt: null,
    version: 1,
    counts: {
      totalTasks: 10,
      doneTasks: 4,
      inProgressTasks: 3,
      todoTasks: 3,
    },
  };
  validateAgainstOpenApiSchema(
    spec,
    schemas.ProjectSprint,
    sprintSample,
    'ProjectSprint',
  );

  const orgSummarySample = {
    asOf: '2026-10-22T12:00:00.000Z',
    totals: { total: 120, inProgress: 35, overdue: 8 },
    projects: [
      {
        projectId: '6717b0000000000000000002',
        projectName: 'Continuum Core',
        projectCode: 'DATN',
        total: 120,
        inProgress: 35,
        overdue: 8,
        byStatus: [{ key: 'IN_PROGRESS', count: 35 }],
      },
    ],
    nextCursor: null,
  };
  validateAgainstOpenApiSchema(
    spec,
    schemas.OrganizationTaskSummary,
    orgSummarySample,
    'OrganizationTaskSummary',
  );

  const historySample = {
    id: '6717b0000000000000000099',
    type: 'TASK_UPDATED',
    actor: { id: '6717b0000000000000000003', fullName: 'Thang' },
    occurredAt: '2026-10-22T12:45:00.000Z',
    version: 3,
    reason: 'SPRINT_COMPLETED',
    changedFields: ['sprintId'],
    fromSprintId: '6717b0000000000000000005',
    toSprintId: null,
  };
  validateAgainstOpenApiSchema(
    spec,
    schemas.TaskHistoryEntry,
    historySample,
    'TaskHistoryEntry',
  );
});
