import type { Connection } from 'mongoose';
import {
  createMarkedReplayStore,
  validateReplayWorkerUri,
} from './task-delegation-replay-store.worker';

const safeDatabaseName = `datn96replay_${'a'.repeat(32)}`;
const safeUri = `mongodb://test-user:test-password@127.0.0.1:27017/${safeDatabaseName}?replicaSet=rs0&authSource=admin`;
const testEnvironment = {
  NODE_ENV: 'test',
  MONGODB_INTEGRATION: 'true',
} as NodeJS.ProcessEnv;

describe('Task delegation replay worker database safety', () => {
  it('accepts only an authenticated, loopback, disposable replica-set URI in integration tests', () => {
    expect(validateReplayWorkerUri(safeUri, testEnvironment).pathname).toBe(
      `/${safeDatabaseName}`,
    );
  });

  it.each([
    ['production environment', { ...testEnvironment, NODE_ENV: 'production' }],
    [
      'integration disabled',
      { ...testEnvironment, MONGODB_INTEGRATION: 'false' },
    ],
    ['remote host', testEnvironment],
    ['SRV URI', testEnvironment],
    ['wrong database', testEnvironment],
    ['missing credentials', testEnvironment],
    ['missing replica set', testEnvironment],
    ['missing auth source', testEnvironment],
    ['multiple hosts', testEnvironment],
  ] as const)('rejects %s without exposing the URI', (label, environment) => {
    const uriByCase: Record<string, string> = {
      'remote host': safeUri.replace('127.0.0.1', 'mongo.example.test'),
      'SRV URI': safeUri.replace('mongodb://', 'mongodb+srv://'),
      'wrong database': safeUri.replace(safeDatabaseName, 'continuum_task'),
      'missing credentials': safeUri.replace('test-user:test-password@', ''),
      'missing replica set': safeUri.replace('?replicaSet=rs0&', '?'),
      'missing auth source': safeUri.replace('&authSource=admin', ''),
      'multiple hosts': safeUri.replace(
        '127.0.0.1:27017',
        '127.0.0.1:27017,localhost:27018',
      ),
    };
    const uri = uriByCase[label] ?? safeUri;

    const validate = () => validateReplayWorkerUri(uri, environment);
    expect(validate).toThrow();
    try {
      validate();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(uri);
    }
  });

  it('rejects an unsafe URI before opening a MongoDB connection', async () => {
    const createConnection = jest.fn();

    await expect(
      createMarkedReplayStore(
        safeUri.replace('127.0.0.1', 'db.example.test'),
        testEnvironment,
        {
          createConnection,
        },
      ),
    ).rejects.toThrow();

    expect(createConnection).not.toHaveBeenCalled();
  });

  it('does not create the replay store until the connected database marker is verified', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const findOne = jest.fn().mockResolvedValue(null);
    const command = jest
      .fn()
      .mockResolvedValueOnce({ setName: 'rs0' })
      .mockResolvedValueOnce({ version: '7.0.0' });
    const connection = {
      asPromise: jest.fn().mockResolvedValue(undefined),
      close,
      db: {
        admin: () => ({ command }),
        client: {
          db: () => ({ collection: () => ({ findOne }) }),
        },
      },
    } as unknown as Connection;
    const createConnection = jest.fn(() => connection);
    const createStore = jest.fn();

    await expect(
      createMarkedReplayStore(safeUri, testEnvironment, {
        createConnection,
        createStore,
      }),
    ).rejects.toThrow();

    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(createStore).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
