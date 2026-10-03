import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertSafeDevelopmentRuntimeEndpoints,
  createAppAfterDevelopmentEndpointValidation,
  redactRuntimeError,
} from './smoke-service-owned-runtime.mjs';

const localEnvironment = () => ({
  DATN_DB_ENV: 'development',
  NODE_ENV: 'development',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/?replicaSet=rs0',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
});

test('allows an explicitly labeled Atlas and remote Redis development configuration', async () => {
  await assertSafeDevelopmentRuntimeEndpoints({
    ...localEnvironment(),
    MONGODB_URI:
      'mongodb+srv://dev-user:dev%40password@cluster0.example.mongodb.net/?retryWrites=true&w=majority',
    REDIS_HOST: 'redis.development.example.test',
    REDIS_PORT: '6380',
  });
});

test('allows direct loopback MongoDB and standalone Redis endpoints', async () => {
  await assertSafeDevelopmentRuntimeEndpoints(localEnvironment());
});

test('allows IPv6 loopback endpoints', async () => {
  await assertSafeDevelopmentRuntimeEndpoints({
    ...localEnvironment(),
    MONGODB_URI: 'mongodb://[::1]:27017/?replicaSet=rs0',
    REDIS_HOST: '::1',
    REDIS_PORT: '6379',
  });
});

test('allows localhost only when every resolved address is loopback', async () => {
  const environment = {
    ...localEnvironment(),
    MONGODB_URI: 'mongodb://localhost:27017/?replicaSet=rs0',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
  };
  const lookupHost = async () => [
    { address: '127.0.0.1', family: 4 },
    { address: '::1', family: 6 },
  ];

  await assertSafeDevelopmentRuntimeEndpoints(environment, { lookupHost });
});

test('rejects localhost when any resolved address is not loopback', async () => {
  const environment = {
    ...localEnvironment(),
    REDIS_HOST: 'localhost',
  };

  await assert.rejects(
    assertSafeDevelopmentRuntimeEndpoints(environment, {
      lookupHost: async () => [
        { address: '127.0.0.1', family: 4 },
        { address: '192.0.2.10', family: 4 },
      ],
    }),
    /localhost endpoint could not be verified as loopback/,
  );
});

test('rejects malformed Atlas URIs and database overrides', async (t) => {
  const cases = [
    'mongodb+srv://dev-user:dev-password@cluster.example.test/continuum_db',
    'mongodb+srv://dev-user:dev-password@cluster.example.test/?tls=false',
    'mongodb+srv://cluster.example.test/',
    'mongodb://127.0.0.1:27017,cluster.example.test:27017/',
    'mongodb://0.0.0.0:27017/',
  ];

  for (const MONGODB_URI of cases) {
    await t.test('invalid development MongoDB URI is rejected', async () => {
      await assert.rejects(
        assertSafeDevelopmentRuntimeEndpoints({
          ...localEnvironment(),
          MONGODB_URI,
        }),
        /MONGODB_URI|Atlas development/,
      );
    });
  }
});

test('rejects malformed development Redis endpoints', async (t) => {
  const cases = [
    { REDIS_HOST: 'redis host' },
    { REDIS_PORT: '70000' },
    {
      REDIS_MODE: 'cluster',
      REDIS_CLUSTER_NODES: '127.0.0.1:6379,redis host:6380',
    },
  ];

  for (const redis of cases) {
    await t.test('malformed Redis endpoint is rejected', async () => {
      await assert.rejects(
        assertSafeDevelopmentRuntimeEndpoints({
          ...localEnvironment(),
          ...redis,
        }),
        /valid Redis|host\[:port\]/,
      );
    });
  }
});

test('non-development environment labels cannot reach bootstrap or write callbacks', async (t) => {
  const cases = [
    {
      name: 'missing development label',
      env: {
        ...localEnvironment(),
        DATN_DB_ENV: undefined,
        MONGODB_URI:
          'mongodb+srv://dev-user:dev-password@cluster0.example.mongodb.net/',
        REDIS_HOST: 'redis.development.example.test',
      },
    },
    {
      name: 'production label',
      env: {
        ...localEnvironment(),
        DATN_DB_ENV: 'production',
        MONGODB_URI: 'mongodb://mongo.example.test:27017/',
      },
    },
    {
      name: 'staging label',
      env: {
        ...localEnvironment(),
        DATN_DB_ENV: 'staging',
        REDIS_HOST: 'redis.example.test',
      },
    },
    {
      name: 'production NODE_ENV despite development marker',
      env: { ...localEnvironment(), NODE_ENV: 'production' },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      let appModuleImported = false;
      let appBootstrapped = false;
      let writeAttempted = false;

      await assert.rejects(
        createAppAfterDevelopmentEndpointValidation({
          env: item.env,
          validateConfiguration: () => {},
          importAppModule: async () => {
            appModuleImported = true;
          },
          createApp: async () => {
            appBootstrapped = true;
            writeAttempted = true;
          },
        }),
      );

      assert.equal(appModuleImported, false);
      assert.equal(appBootstrapped, false);
      assert.equal(writeAttempted, false);
    });
  }
});

test('allows a configured remote Redis cluster in development', async () => {
  await assertSafeDevelopmentRuntimeEndpoints({
    ...localEnvironment(),
    REDIS_MODE: 'cluster',
    REDIS_CLUSTER_NODES:
      'redis-a.development.example.test:6379,redis-b.development.example.test:6380',
  });
});

test('rejects an alternate dotenv path before importing AppModule', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'datn-smoke-dotenv-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dotenvPath = path.join(directory, 'remote.env');
  writeFileSync(
    dotenvPath,
    'MONGODB_URI=mongodb+srv://cluster.example.test/db\n',
  );

  let appModuleImported = false;
  let appBootstrapped = false;
  let writeAttempted = false;
  const env = {
    ...localEnvironment(),
    DOTENV_CONFIG_PATH: dotenvPath,
  };

  await assert.rejects(
    createAppAfterDevelopmentEndpointValidation({
      env,
      validateConfiguration: () => {},
      importAppModule: async () => {
        appModuleImported = true;
      },
      createApp: async () => {
        appBootstrapped = true;
        writeAttempted = true;
      },
    }),
    /Dotenv override controls are not allowed/,
  );
  assert.equal(appModuleImported, false);
  assert.equal(appBootstrapped, false);
  assert.equal(writeAttempted, false);
});

test('rejects dotenv override even when its file would replace a safe preset URI', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'datn-smoke-override-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dotenvPath = path.join(directory, 'remote.env');
  writeFileSync(
    dotenvPath,
    'MONGODB_URI=mongodb+srv://cluster.example.test/db\n',
  );

  const env = {
    ...localEnvironment(),
    DOTENV_CONFIG_PATH: dotenvPath,
    DOTENV_CONFIG_OVERRIDE: 'true',
  };
  let appModuleImported = false;
  let appBootstrapped = false;

  await assert.rejects(
    createAppAfterDevelopmentEndpointValidation({
      env,
      validateConfiguration: () => {},
      importAppModule: async () => {
        appModuleImported = true;
      },
      createApp: async () => {
        appBootstrapped = true;
      },
    }),
    /Dotenv override controls are not allowed/,
  );
  assert.equal(env.MONGODB_URI, localEnvironment().MONGODB_URI);
  assert.equal(appModuleImported, false);
  assert.equal(appBootstrapped, false);
});

test('revalidates effective endpoints after AppModule import and before bootstrap', async () => {
  const env = localEnvironment();
  let appModuleImported = false;
  let appBootstrapped = false;
  let writeAttempted = false;

  await assert.rejects(
    createAppAfterDevelopmentEndpointValidation({
      env,
      validateConfiguration: () => {},
      importAppModule: async () => {
        appModuleImported = true;
        env.DATN_DB_ENV = 'production';
        return {};
      },
      createApp: async () => {
        appBootstrapped = true;
        writeAttempted = true;
      },
    }),
    /DATN_DB_ENV and NODE_ENV/,
  );

  assert.equal(appModuleImported, true);
  assert.equal(appBootstrapped, false);
  assert.equal(writeAttempted, false);
});

test('does not include MongoDB credentials or full URI in validation errors', async () => {
  const secretUri =
    'mongodb+srv://test-user:test-password@cluster.example.test/?tls=false';
  await assert.rejects(
    assertSafeDevelopmentRuntimeEndpoints({
      ...localEnvironment(),
      MONGODB_URI: secretUri,
    }),
    (error) => {
      assert.doesNotMatch(
        error.message,
        /test-user|test-password|cluster\.example\.test/,
      );
      return true;
    },
  );
  const runtimeError = redactRuntimeError(new Error(secretUri), {
    MONGODB_URI: secretUri,
    REDIS_PASSWORD: 'redis-secret',
    DATN_DEV_SEED_PASSWORD: 'seed-secret',
    JWT_SECRET: 'jwt-secret',
  });
  assert.doesNotMatch(
    runtimeError,
    /test-user|test-password|cluster\.example\.test|redis-secret|seed-secret|jwt-secret/,
  );
});
