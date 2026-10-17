import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const suite =
  'src/services/iam/infrastructure/mongodb/project-audit-atomicity.mongodb.spec.ts';
const replicaSet = await MongoMemoryReplSet.create({
  binary: { version: '7.0.45' },
});
console.log('Started disposable MongoDB replica set for audit atomicity test.');

try {
  const result = spawnSync(
    process.execPath,
    [
      resolve('node_modules/jest/bin/jest.js'),
      '--runInBand',
      '--runTestsByPath',
      suite,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PROJECT_AUDIT_ATOMICITY_INTEGRATION: 'true',
        MONGODB_URI: replicaSet.getUri(),
      },
      stdio: 'inherit',
    },
  );

  if (result.error) {
    console.error(result.error);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
} finally {
  await replicaSet.stop();
}
