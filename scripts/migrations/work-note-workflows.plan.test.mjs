import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkNoteWorkflowIndexes } from './20261024-work-note-workflows.mjs';
import {
  buildWorkNoteWorkflowIndexPlan,
  validateWorkNoteDatabaseName,
} from './work-note-workflows.plan.mjs';

test('plans only the Capture-owned Work Note workflow indexes', () => {
  const plan = buildWorkNoteWorkflowIndexPlan('continuum_capture');
  assert.equal(plan.length, 10);
  assert.ok(plan.every((item) => item.databaseName === 'continuum_capture'));
  assert.equal(
    plan.some(
      (item) => item.collection === 'project_documents' && 'taskId' in item.key,
    ),
    false,
  );
  assert.ok(
    plan.some(
      (item) =>
        item.collection === 'work_reports' &&
        item.unique &&
        JSON.stringify(item.key) ===
          JSON.stringify({ projectId: 1, memberUserId: 1, periodStart: 1 }),
    ),
  );
});

test('refuses any database other than continuum_capture', () => {
  assert.throws(
    () => validateWorkNoteDatabaseName('continuum_iam'),
    /only target continuum_capture/,
  );
});

test('preflights unique keys and applies indexes without changing records', async () => {
  const calls = [];
  const db = {
    databaseName: 'continuum_capture',
    collection(name) {
      return {
        aggregate() {
          return { toArray: async () => [] };
        },
        async createIndex(key, options) {
          calls.push({ collection: name, key, options });
          return options.name;
        },
      };
    },
  };

  const result = await applyWorkNoteWorkflowIndexes(db);
  assert.equal(result.length, calls.length);
  assert.ok(result.every((item) => item.name));
  assert.equal(calls.filter((item) => item.options.unique).length, 3);
  assert.equal(
    calls.some((item) => item.collection === 'work_notes'),
    true,
  );
});

test('groups duplicate preflight rows by stored field values', async () => {
  const pipelines = [];
  const db = {
    databaseName: 'continuum_capture',
    collection(name) {
      return {
        aggregate(pipeline) {
          pipelines.push({ collection: name, pipeline });
          const groupFields = Object.values(pipeline[0].$group._id);
          const groupsByStoredValues = groupFields.every(
            (value) => typeof value === 'string' && value.startsWith('$'),
          );
          return {
            toArray: async () =>
              groupsByStoredValues ? [] : [{ _id: {}, count: 2 }],
          };
        },
        async createIndex(_key, options) {
          return options.name;
        },
      };
    },
  };

  await applyWorkNoteWorkflowIndexes(db);

  const reportCheck = pipelines.find(
    (item) => item.collection === 'work_reports',
  );
  assert.deepEqual(reportCheck.pipeline[0].$group._id, {
    projectId: '$projectId',
    memberUserId: '$memberUserId',
    periodStart: '$periodStart',
  });
});

test('does not create any index when existing report periods duplicate', async () => {
  let createIndexCalls = 0;
  const db = {
    databaseName: 'continuum_capture',
    collection(name) {
      return {
        aggregate() {
          return {
            toArray: async () =>
              name === 'work_reports' ? [{ _id: {}, count: 2 }] : [],
          };
        },
        async createIndex() {
          createIndexCalls += 1;
          return 'unexpected';
        },
      };
    },
  };

  await assert.rejects(
    applyWorkNoteWorkflowIndexes(db),
    /duplicate keys exist in work_reports/,
  );
  assert.equal(createIndexCalls, 0);
});
