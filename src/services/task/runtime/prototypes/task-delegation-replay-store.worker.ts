import mongoose from 'mongoose';
import { TaskInboundContextVerificationError } from '../task-inbound-context';
import { TaskDelegationAssertionPrototypeVerifier } from './task-delegation-assertion.prototype';
import { ConsumingTaskDelegationAssertionPrototypeVerifier } from './task-delegation-replay-consumer.prototype';
import { MongoTaskDelegationReplayStore } from './task-delegation-replay-store.prototype';

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

  const connection = mongoose.createConnection(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 10_000,
  });
  try {
    await connection.asPromise();
    const store = await MongoTaskDelegationReplayStore.create(connection);
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
    await connection.close().catch(() => undefined);
  }
}

void main();
