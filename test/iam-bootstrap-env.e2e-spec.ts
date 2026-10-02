import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('IAM runtime environment bootstrap', () => {
  it('loads the configured env file before Nest evaluates the IAM module', () => {
    const childEnvironment = { ...process.env };
    delete childEnvironment.MONGODB_URI;
    delete childEnvironment.JWT_SECRET;
    childEnvironment.DOTENV_CONFIG_PATH = resolve(
      __dirname,
      'fixtures/iam-runtime.fixture',
    );
    childEnvironment.INFRA_ENABLED = 'false';

    const code = [
      "require('reflect-metadata')",
      "const { NestFactory } = require('@nestjs/core')",
      "const { ConfigService } = require('@nestjs/config')",
      "const { IamModule } = require('./src/services/iam/iam.module')",
      '(async () => {',
      '  const app = await NestFactory.createApplicationContext(IamModule, { logger: false })',
      "  process.stdout.write(app.get(ConfigService).getOrThrow('MONGODB_URI'))",
      '  await app.close()',
      '})().catch(error => { process.stderr.write(error.name); process.exitCode = 1 })',
    ].join(';');
    const child = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register', '-e', code],
      {
        cwd: resolve(__dirname, '..'),
        env: childEnvironment,
        encoding: 'utf8',
        timeout: 15000,
      },
    );

    expect(child.status).toBe(0);
    expect(child.stdout).toBe('mongodb://fixture-host.invalid:27017');
  });
});
