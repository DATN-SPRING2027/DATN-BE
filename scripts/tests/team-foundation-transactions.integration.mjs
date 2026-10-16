import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const jest = resolve('node_modules/jest/bin/jest.js');
const suite =
  'src/services/iam/infrastructure/mongodb/team-foundation.repository.mongodb.spec.ts';
const result = spawnSync(
  process.execPath,
  [jest, '--runInBand', '--runTestsByPath', suite],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TEAM_FOUNDATION_MONGODB_INTEGRATION: 'true',
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
