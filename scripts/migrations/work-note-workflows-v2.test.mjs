import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkNoteWorkflowIndexesV2 } from './20261024-work-note-workflows-v2.mjs';

function database({
  duplicateCollection,
  existingWorkNotesIndex = false,
  conflictingWorkNotesIndex = false,
} = {}) {
  const indexes = new Map();
  if (existingWorkNotesIndex)
    indexes.set('work_notes', [
      { name: '_id_', key: { _id: 1 } },
      {
        name: 'generated_key_name',
        key: { organizationId: 1, projectId: 1, taskId: 1, createdAt: -1 },
      },
    ]);
  if (conflictingWorkNotesIndex)
    indexes.set('work_notes', [
      { name: '_id_', key: { _id: 1 } },
      {
        name: 'filtered_work_notes',
        key: { organizationId: 1, projectId: 1, taskId: 1, createdAt: -1 },
        partialFilterExpression: { status: 'CONFIRMED' },
      },
    ]);
  const calls = [];
  return {
    databaseName: 'continuum_capture',
    calls,
    listCollections() {
      return { hasNext: async () => true };
    },
    collection(name) {
      if (!indexes.has(name))
        indexes.set(name, [{ name: '_id_', key: { _id: 1 } }]);
      return {
        listIndexes() {
          return { toArray: async () => indexes.get(name) };
        },
        aggregate() {
          return {
            toArray: async () =>
              name === duplicateCollection ? [{ count: 2 }] : [],
          };
        },
        async createIndex(key, options) {
          calls.push({ name, key, options });
          indexes.get(name).push({ key, ...options });
          return options.name;
        },
      };
    },
  };
}

test('skips equivalent keys with a different index name and remains repeatable', async () => {
  const db = database({ existingWorkNotesIndex: true });
  const first = await applyWorkNoteWorkflowIndexesV2(db);
  assert.equal(first.filter((item) => item.action === 'created').length, 9);
  assert.equal(
    first.find((item) => item.collection === 'work_notes')?.name,
    'generated_key_name',
  );
  const second = await applyWorkNoteWorkflowIndexesV2(db);
  assert.equal(second.filter((item) => item.action === 'skipped').length, 10);
  assert.equal(db.calls.length, 9);
});

test('preflights every unique key before creating any index', async () => {
  const db = database({ duplicateCollection: 'work_reports' });
  await assert.rejects(
    applyWorkNoteWorkflowIndexesV2(db),
    /Duplicate keys in work_reports/,
  );
  assert.equal(db.calls.length, 0);
});

test('does not accept matching keys with different index filtering options', async () => {
  const db = database({ conflictingWorkNotesIndex: true });
  await assert.rejects(
    applyWorkNoteWorkflowIndexesV2(db),
    /Index options conflict in work_notes/,
  );
  assert.equal(db.calls.length, 0);
});
