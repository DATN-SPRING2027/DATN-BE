import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertSafeLocalRuntimeEndpoints,
  createAppAfterLocalEndpointValidation,
} from './smoke-service-owned-runtime.mjs';

const localEnvironment = () => ({
  MONGODB_URI: 'mongodb://127.0.0.1:27017/?replicaSet=rs0',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
});

test('allows direct loopback MongoDB and standalone Redis endpoints', async () => {
  await assertSafeLocalRuntimeEndpoints(localEnvironment());
});

test('allows IPv6 loopback endpoints', async () => {
  await assertSafeLocalRuntimeEndpoints({
    MONGODB_URI: 'mongodb://[::1]:27017/?replicaSet=rs0',
    REDIS_HOST: '::1',
    REDIS_PORT: '6379',
  });
});

test('allows localhost only when every resolved address is loopback', async () => {
  const environment = {
    MONGODB_URI: 'mongodb://localhost:27017/?replicaSet=rs0',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
  };
  const lookupHost = async () => [
    { address: '127.0.0.1', family: 4 },
    { address: '::1', family: 6 },
  ];

  await assertSafeLocalRuntimeEndpoints(environment, { lookupHost });
});

test('rejects localhost when any resolved address is not loopback', async () => {
  const environment = {
    ...localEnvironment(),
    REDIS_HOST: 'localhost',
  };

  await assert.rejects(
    assertSafeLocalRuntimeEndpoints(environment, {
      lookupHost: async () => [
        { address: '127.0.0.1', family: 4 },
        { address: '192.0.2.10', family: 4 },
      ],
    }),
    /localhost endpoint could not be verified as loopback/,
  );
});

test('rejects MongoDB SRV and remote MongoDB hostname or IP endpoints', async (t) => {
  const cases = [
    'mongodb+srv://cluster.example.test/database',
    'mongodb://cluster.example.test:27017/',
    'mongodb://192.0.2.10:27017/',
    'mongodb://127.0.0.1:27017,cluster.example.test:27017/',
  ];

  for (const MONGODB_URI of cases) {
    await t.test(
      'remote or multi-host MongoDB endpoint is rejected',
      async () => {
        await assert.rejects(
          assertSafeLocalRuntimeEndpoints({
            ...localEnvironment(),
            MONGODB_URI,
          }),
          /MongoDB/,
        );
      },
    );
  }
});

test('rejects remote Redis hostname, IP, and cluster nodes', async (t) => {
  const cases = [
    { REDIS_HOST: 'redis.example.test' },
    { REDIS_HOST: '192.0.2.10' },
    {
      REDIS_MODE: 'cluster',
      REDIS_CLUSTER_NODES: '127.0.0.1:6379,redis.example.test:6380',
    },
  ];

  for (const redis of cases) {
    await t.test('remote Redis endpoint is rejected', async () => {
      await assert.rejects(
        assertSafeLocalRuntimeEndpoints({ ...localEnvironment(), ...redis }),
        /loopback Redis endpoints/,
      );
    });
  }
});

test('remote MongoDB or Redis endpoints cannot reach bootstrap or write callbacks', async (t) => {
  const cases = [
    {
      name: 'remote MongoDB',
      env: {
        ...localEnvironment(),
        MONGODB_URI: 'mongodb://192.0.2.10:27017/',
      },
    },
    {
      name: 'remote Redis',
      env: { ...localEnvironment(), REDIS_HOST: 'redis.example.test' },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      let appModuleImported = false;
      let appBootstrapped = false;
      let writeAttempted = false;

      await assert.rejects(
        createAppAfterLocalEndpointValidation({
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

test('validates every local Redis cluster node', async () => {
  await assertSafeLocalRuntimeEndpoints(
    {
      ...localEnvironment(),
      REDIS_MODE: 'cluster',
      REDIS_CLUSTER_NODES: '127.0.0.1:6379,localhost:6380',
    },
    {
      lookupHost: async () => [{ address: '127.0.0.1', family: 4 }],
    },
  );
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
    createAppAfterLocalEndpointValidation({
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
    createAppAfterLocalEndpointValidation({
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
    createAppAfterLocalEndpointValidation({
      env,
      validateConfiguration: () => {},
      importAppModule: async () => {
        appModuleImported = true;
        env.MONGODB_URI = 'mongodb://192.0.2.10:27017/';
        return {};
      },
      createApp: async () => {
        appBootstrapped = true;
        writeAttempted = true;
      },
    }),
    /loopback MongoDB endpoints/,
  );

  assert.equal(appModuleImported, true);
  assert.equal(appBootstrapped, false);
  assert.equal(writeAttempted, false);
});

test('does not include MongoDB credentials or full URI in rejection errors', async () => {
  const secretUri = 'mongodb://test-user:test-password@192.0.2.10:27017/db';
  await assert.rejects(
    assertSafeLocalRuntimeEndpoints({
      ...localEnvironment(),
      MONGODB_URI: secretUri,
    }),
    (error) => {
      assert.doesNotMatch(
        error.message,
        /test-user|test-password|192\.0\.2\.10/,
      );
      return true;
    },
  );
});
