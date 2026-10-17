import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('IAM startup configuration', () => {
  it('fails startup before serving requests when JWT_SECRET is missing', () => {
    const projectRoot = resolve(__dirname, '..');
    const childEnvironment = { ...process.env };
    delete childEnvironment.JWT_SECRET;
    delete childEnvironment.DOTENV_CONFIG_PATH;
    childEnvironment.INFRA_ENABLED = 'false';

    const code = [
      `const { NestFactory } = require(${JSON.stringify(require.resolve('@nestjs/core'))})`,
      `const { IamModule } = require(${JSON.stringify(resolve(projectRoot, 'src/services/iam/iam.module.ts'))})`,
      '(async () => {',
      '  const app = await NestFactory.createApplicationContext(IamModule, { logger: false })',
      '  await app.close()',
      '})().catch(error => { process.stderr.write(error.message); process.exitCode = 1 })',
    ].join(';');

    const child = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register', '-e', code],
      {
        cwd: resolve(__dirname, 'fixtures'),
        env: childEnvironment,
        encoding: 'utf8',
        timeout: 30000,
      },
    );

    expect(child.status).toBe(1);
    expect(child.stderr).toContain('JWT_SECRET_REQUIRED');
  }, 35_000);
});
