import mongoose from 'mongoose';
import type { Connection } from 'mongoose';
import { TASK_DISPOSABLE_FIXTURE_MARKER } from '../../infrastructure/mongodb/initialize-task-disposable-database';
import { TaskInboundContextVerificationError } from '../task-inbound-context';
import { TaskDelegationAssertionPrototypeVerifier } from './task-delegation-assertion.prototype';
import { ConsumingTaskDelegationAssertionPrototypeVerifier } from './task-delegation-replay-consumer.prototype';
import { MongoTaskDelegationReplayStore } from './task-delegation-replay-store.prototype';

const SAFE_REPLAY_FIXTURE_MESSAGE =
  'Replay worker requires an authenticated, marked MongoDB 7 loopback replica-set fixture';

type ReplayWorkerDependencies = {
  createConnection?: typeof mongoose.createConnection;
  createStore?: typeof MongoTaskDelegationReplayStore.create;
};

export function validateReplayWorkerUri(
  value: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): URL {
  if (
    environment.NODE_ENV !== 'test' ||
    environment.MONGODB_INTEGRATION !== 'true'
  ) {
    throw new Error(SAFE_REPLAY_FIXTURE_MESSAGE);
  }

  let uri: URL;
  try {
    if (!value) throw new Error('missing URI');
    uri = new URL(value);
  } catch {
    throw new Error(SAFE_REPLAY_FIXTURE_MESSAGE);
  }

  const hostname = uri.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  const databaseName = uri.pathname.slice(1);
  if (
    uri.protocol !== 'mongodb:' ||
    !loopbackHosts.has(hostname) ||
    !uri.username ||
    !uri.password ||
    !/^datn96replay_[a-f\d]{32}$/i.test(databaseName) ||
    !uri.searchParams.get('replicaSet') ||
    !uri.searchParams.get('authSource') ||
    uri.hash
  ) {
    throw new Error(SAFE_REPLAY_FIXTURE_MESSAGE);
  }

  return uri;
}

export async function createMarkedReplayStore(
  value: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: ReplayWorkerDependencies = {},
): Promise<{ connection: Connection; store: MongoTaskDelegationReplayStore }> {
  const uri = validateReplayWorkerUri(value, environment);
  const createConnection =
    dependencies.createConnection ?? mongoose.createConnection.bind(mongoose);
  const createStore =
    dependencies.createStore ??
    ((connection: Connection) =>
      MongoTaskDelegationReplayStore.create(connection));
  const connection = createConnection(uri.toString(), {
    autoIndex: false,
    serverSelectionTimeoutMS: 10_000,
  });

  try {
    await connection.asPromise();
    const database = connection.db;
    if (!database) throw new Error(SAFE_REPLAY_FIXTURE_MESSAGE);

    const hello = await database.admin().command({ hello: 1 });
    const build = await database.admin().command({ buildInfo: 1 });
    const marker = await database.client
      .db('admin')
      .collection<{ _id: string }>('datn_migration_test_fixture')
      .findOne({ _id: TASK_DISPOSABLE_FIXTURE_MARKER });
    if (!hello.setName || !String(build.version).startsWith('7.') || !marker) {
      throw new Error(SAFE_REPLAY_FIXTURE_MESSAGE);
    }

    const store = await createStore(connection);
    return { connection, store };
  } catch {
    await connection.close().catch(() => undefined);
    throw new Error(SAFE_REPLAY_FIXTURE_MESSAGE);
  }
}

async function main(): Promise<void> {
  const uri = process.env.TASK_REPLAY_TEST_URI;
  const issuer = process.env.TASK_REPLAY_TEST_ISSUER;
  const audience = process.env.TASK_REPLAY_TEST_AUDIENCE;
  const gatewayServiceId = process.env.TASK_REPLAY_TEST_GATEWAY_ID;
  const expectedClientId = process.env.TASK_REPLAY_TEST_CLIENT_ID;
  const keyId = process.env.TASK_REPLAY_TEST_KEY_ID;
  const publicKey = process.env.TASK_REPLAY_TEST_PUBLIC_KEY;
  const token = process.env.TASK_REPLAY_TEST_TOKEN;
  const encodedBinding = process.env.TASK_REPLAY_TEST_BINDING;
  if (
    !uri ||
    !issuer ||
    !audience ||
    !gatewayServiceId ||
    !expectedClientId ||
    !keyId ||
    !publicKey ||
    !token ||
    !encodedBinding
  ) {
    process.exitCode = 2;
    return;
  }

  let connection: Connection | undefined;
  try {
    const fixture = await createMarkedReplayStore(uri);
    connection = fixture.connection;
    const store = fixture.store;
    const verifier = new TaskDelegationAssertionPrototypeVerifier({
      issuer,
      audience,
      gatewayServiceId,
      expectedClientId,
      signatureAlgorithm: 'EdDSA',
      tokenType: 'task-delegation+jwt',
      keyProvider: {
        getPublicKey: (requestedKeyId) =>
          new Map([[keyId, publicKey]]).get(requestedKeyId),
      },
    });
    const consuming = new ConsumingTaskDelegationAssertionPrototypeVerifier(
      verifier,
      store,
    );
    let binding: unknown;
    try {
      binding = JSON.parse(encodedBinding) as unknown;
    } catch {
      process.exitCode = 2;
      return;
    }

    try {
      await consuming.verify(token, binding);
      process.stdout.write('{"accepted":true}');
    } catch (error) {
      if (!(error instanceof TaskInboundContextVerificationError)) {
        process.exitCode = 2;
        return;
      }
      process.stdout.write(
        JSON.stringify({ accepted: false, reason: error.reason }),
      );
    }
  } catch {
    process.exitCode = 2;
  } finally {
    await connection?.close().catch(() => undefined);
  }
}

if (require.main === module) {
  void main();
}
