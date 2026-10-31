import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runApplicationSmoke } from './application-smoke.mjs';
test('default smoke imports and returns without opening infrastructure or reading credentials', async () => {
  const previous = process.env.WORKNOTE_AGENT_APP_SMOKE;
  delete process.env.WORKNOTE_AGENT_APP_SMOKE;
  try {
    assert.deepEqual(await runApplicationSmoke(), {
      dryRun: true,
      networkCalls: 0,
      status: 'EXPLICIT_OPT_IN_REQUIRED',
    });
  } finally {
    if (previous !== undefined) process.env.WORKNOTE_AGENT_APP_SMOKE = previous;
  }
});
test('explicit production invocation fails before setup and prints no environment values', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/work-note-agent/application-smoke.mjs'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        WORKNOTE_AGENT_APP_SMOKE: 'true',
        NODE_ENV: 'production',
        XKIRO_API_KEY: 'sentinel-never-log',
      },
    },
  );
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /sentinel-never-log/);
  assert.match(result.stderr, /setup failed/);
});
