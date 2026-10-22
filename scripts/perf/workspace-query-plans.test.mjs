import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('./workspace-query-plans.mjs', import.meta.url),
);

function run(uri) {
  return spawnSync(
    process.execPath,
    [script, '--uri', uri, '--iterations', '1'],
    {
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
}

test('refuses mongodb+srv URIs before connecting', () => {
  const result = run('mongodb+srv://user:pass@cluster.example.net/');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Only mongodb:\/\/ URIs are allowed/);
});

test('refuses non-loopback mongodb:// hosts before connecting', () => {
  const result = run('mongodb://db.example.net:27017/');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing non-loopback host: db\.example\.net/);
});
