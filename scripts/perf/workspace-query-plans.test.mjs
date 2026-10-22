import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = [
  './workspace-query-plans.mjs',
  './workspace-org-queries.mjs',
].map((name) => fileURLToPath(new URL(name, import.meta.url)));

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
