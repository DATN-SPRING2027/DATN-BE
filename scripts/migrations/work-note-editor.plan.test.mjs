import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportBackfill } from './work-note-editor.plan.mjs';
test('labels legacy report fields without inferring outcomes and leaves empty obligations unupgraded', () => {
  const row = {
    periodStart: new Date('2026-10-26'),
    accomplishments: 'Chưa test.\r\n  giữ log',
    approach: 'Đọc log.',
    reason: 'Chưa biết.',
  };
  const plan = reportBackfill(row);
  assert.match(plan.contentMarkdown, /Chưa test\.\r\n  giữ log/);
  assert.equal(plan.contentSchemaVersion, 2);
  assert.equal(
    reportBackfill({
      ...row,
      contentSchemaVersion: 2,
      contentMarkdown: 'Canonical',
    }),
    null,
  );
  assert.equal(reportBackfill({ periodStart: row.periodStart }), null);
  assert.throws(() =>
    reportBackfill({ ...row, accomplishments: 'x'.repeat(30001) }),
  );
});
