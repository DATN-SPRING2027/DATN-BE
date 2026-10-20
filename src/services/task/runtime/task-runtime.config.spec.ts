import { TASK_DATABASE_NAME } from '../infrastructure/mongodb/task-contract';
import { createTaskRuntimeConfig } from './task-runtime.config';

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    TASK_RUNTIME_ENABLED: 'true',
    TASK_MONGODB_URI:
      'mongodb://task-user:fixture-secret@127.0.0.1:27017/?authSource=admin',
    TASK_SERVICE_PORT: '3909',
    ...overrides,
  };
}

describe('createTaskRuntimeConfig', () => {
  it('accepts an explicit test configuration with no database path', () => {
    expect(createTaskRuntimeConfig(environment())).toEqual({
      mongoUri:
        'mongodb://task-user:fixture-secret@127.0.0.1:27017/?authSource=admin',
      port: 3909,
      routesEnabled: false,
    });
  });

  it('keeps the Task routes disabled unless TASK_ROUTES_ENABLED is exactly true', () => {
    expect(createTaskRuntimeConfig(environment()).routesEnabled).toBe(false);
    for (const value of ['', 'false', 'TRUE', '1', 'yes', ' true']) {
      expect(
        createTaskRuntimeConfig(environment({ TASK_ROUTES_ENABLED: value }))
          .routesEnabled,
      ).toBe(false);
    }
    expect(
      createTaskRuntimeConfig(environment({ TASK_ROUTES_ENABLED: 'true' }))
        .routesEnabled,
    ).toBe(true);
  });

  it('does not let TASK_ROUTES_ENABLED bypass the runtime gates', () => {
    expect(() =>
      createTaskRuntimeConfig(
        environment({ NODE_ENV: 'production', TASK_ROUTES_ENABLED: 'true' }),
      ),
    ).toThrow('Task runtime is restricted to development and test');
    expect(() =>
      createTaskRuntimeConfig(
        environment({
          TASK_RUNTIME_ENABLED: 'false',
          TASK_ROUTES_ENABLED: 'true',
        }),
      ),
    ).toThrow('TASK_RUNTIME_ENABLED must be true');
  });

  it('accepts only the Task database path', () => {
    expect(() =>
      createTaskRuntimeConfig(
        environment({
          TASK_MONGODB_URI:
            'mongodb://task-user:fixture-secret@127.0.0.1:27017/continuum_db',
        }),
      ),
    ).toThrow('TASK_MONGODB_URI must select continuum_task only');

    expect(
      createTaskRuntimeConfig(
        environment({
          TASK_MONGODB_URI:
            'mongodb://task-user:fixture-secret@127.0.0.1:27017/continuum_task',
        }),
      ).mongoUri,
    ).toContain(TASK_DATABASE_NAME);
  });

  it('accepts loopback replica-set hosts and rejects any remote host', () => {
    expect(
      createTaskRuntimeConfig(
        environment({
          TASK_MONGODB_URI:
            'mongodb://127.0.0.1:27017,localhost:27018/continuum_task?replicaSet=rs0',
        }),
      ).mongoUri,
    ).toContain('replicaSet=rs0');

    expect(() =>
      createTaskRuntimeConfig(
        environment({
          TASK_MONGODB_URI:
            'mongodb://task-user:fixture-secret@127.0.0.1:27017,db.example.test:27017/continuum_task',
        }),
      ),
    ).toThrow('TASK_MONGODB_URI must use loopback hosts for dormant runtime');
  });

  it('does not fall back to the shared MONGODB_URI', () => {
    expect(() =>
      createTaskRuntimeConfig(
        environment({
          TASK_MONGODB_URI: undefined,
          MONGODB_URI: 'mongodb://127.0.0.1:27017/continuum_db',
        }),
      ),
    ).toThrow('TASK_MONGODB_URI is required');
  });

  it.each([
    ['production', 'true'],
    ['development', 'false'],
    ['development', undefined],
  ])(
    'fails closed for NODE_ENV=%s and TASK_RUNTIME_ENABLED=%s',
    (nodeEnv, enabled) => {
      expect(() =>
        createTaskRuntimeConfig(
          environment({
            NODE_ENV: nodeEnv,
            TASK_RUNTIME_ENABLED: enabled,
          }),
        ),
      ).toThrow();
    },
  );

  it.each(['not-a-uri', 'http://127.0.0.1:27017/continuum_task'])(
    'rejects malformed or non-MongoDB URI values without echoing them',
    (mongoUri) => {
      let error: unknown;
      try {
        createTaskRuntimeConfig(environment({ TASK_MONGODB_URI: mongoUri }));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(mongoUri);
    },
  );

  it.each([undefined, '', '0', '1023', '65536', '3.5', 'NaN'])(
    'rejects invalid port %s',
    (port) => {
      expect(() =>
        createTaskRuntimeConfig(environment({ TASK_SERVICE_PORT: port })),
      ).toThrow('TASK_SERVICE_PORT must be an integer from 1024 to 65535');
    },
  );
});
