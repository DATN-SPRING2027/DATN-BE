jest.mock('@nestjs/core', () => ({
  NestFactory: {
    create: jest.fn(),
  },
}));

import { NestFactory } from '@nestjs/core';
import {
  Module,
  type DynamicModule,
  type INestApplication,
} from '@nestjs/common';
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:net';
import { bootstrapTaskRuntime } from '../main';
import { TaskRuntimeModule } from './task-runtime.module';

const mockedCore = jest.requireMock('@nestjs/core') as unknown as {
  NestFactory: {
    create: jest.MockedFunction<typeof NestFactory.create>;
  };
};
const createNestApplication = mockedCore.NestFactory.create;
const actualNestFactory =
  jest.requireActual<typeof import('@nestjs/core')>('@nestjs/core').NestFactory;

let connectionIsOpen = true;

class ConnectionResource {
  onApplicationShutdown(): void {
    connectionIsOpen = false;
  }
}

@Module({ providers: [ConnectionResource] })
class ConnectionResourceModule {}

describe('bootstrapTaskRuntime', () => {
  beforeEach(() => {
    createNestApplication.mockReset();
  });

  it('rejects invalid config before creating an HTTP listener', async () => {
    await expect(
      bootstrapTaskRuntime({
        NODE_ENV: 'production',
        TASK_RUNTIME_ENABLED: 'true',
      }),
    ).rejects.toThrow('Task runtime is restricted to development and test');

    expect(createNestApplication).not.toHaveBeenCalled();
  });

  it('creates only the dormant local application on loopback', async () => {
    const app = {
      setGlobalPrefix: jest.fn(),
      enableShutdownHooks: jest.fn(),
      listen: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    createNestApplication.mockResolvedValue(app as never);

    await bootstrapTaskRuntime({
      NODE_ENV: 'test',
      TASK_RUNTIME_ENABLED: 'true',
      TASK_MONGODB_URI: 'mongodb://127.0.0.1:27017/continuum_task',
      TASK_SERVICE_PORT: '3909',
    });

    const [runtimeModule, appOptions] = createNestApplication.mock
      .calls[0] as unknown as [DynamicModule, { logger: false; rawBody: true }];
    expect(runtimeModule.module).toBe(TaskRuntimeModule);
    expect(appOptions).toEqual({ logger: false, rawBody: true });
    expect(app.setGlobalPrefix).toHaveBeenCalledWith('internal');
    expect(app.enableShutdownHooks).toHaveBeenCalled();
    expect(app.listen).toHaveBeenCalledWith(3909, '127.0.0.1');
    expect(app.close).not.toHaveBeenCalled();
  });

  it.each([
    ['global prefix setup', 'setGlobalPrefix'],
    ['shutdown-hook setup', 'enableShutdownHooks'],
  ] as const)(
    'closes the created Nest app when %s fails and preserves that error',
    async (_step, failingMethod) => {
      const setupError = new Error('startup setup failed');
      const app = {
        setGlobalPrefix: jest.fn(),
        enableShutdownHooks: jest.fn(),
        listen: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockRejectedValue(new Error('cleanup failed')),
      };
      app[failingMethod].mockImplementation(() => {
        throw setupError;
      });
      createNestApplication.mockResolvedValue(app as never);

      await expect(
        bootstrapTaskRuntime({
          NODE_ENV: 'test',
          TASK_RUNTIME_ENABLED: 'true',
          TASK_MONGODB_URI: 'mongodb://127.0.0.1:27017/continuum_task',
          TASK_SERVICE_PORT: '3909',
        }),
      ).rejects.toBe(setupError);

      expect(app.close).toHaveBeenCalledTimes(1);
      expect(app.listen).not.toHaveBeenCalled();
    },
  );

  it('closes Nest and its connection resources when listen rejects', async () => {
    const occupiedServer = createServer();
    await new Promise<void>((resolve, reject) => {
      occupiedServer.once('error', reject);
      occupiedServer.listen(0, '127.0.0.1', resolve);
    });

    let app: INestApplication | undefined;
    try {
      const address = occupiedServer.address();
      if (!address || typeof address === 'string') {
        throw new Error('Test server did not bind to a TCP port');
      }

      connectionIsOpen = true;
      createNestApplication.mockImplementation(async (_module, options) => {
        app = await actualNestFactory.create(ConnectionResourceModule, options);
        return app;
      });

      await expect(
        bootstrapTaskRuntime({
          NODE_ENV: 'test',
          TASK_RUNTIME_ENABLED: 'true',
          TASK_MONGODB_URI: 'mongodb://127.0.0.1:27017/continuum_task',
          TASK_SERVICE_PORT: String(address.port),
        }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });

      expect(app).toBeDefined();
      const httpServer = app?.getHttpServer() as HttpServer;
      expect(httpServer.listening).toBe(false);
      expect(connectionIsOpen).toBe(false);
    } finally {
      await new Promise<void>((resolve) => {
        occupiedServer.close(() => resolve());
      });
    }
  });

  it('preserves the listen error when Nest shutdown also rejects', async () => {
    const listenError = new Error('address already in use');
    const app = {
      setGlobalPrefix: jest.fn(),
      enableShutdownHooks: jest.fn(),
      listen: jest.fn().mockRejectedValue(listenError),
      close: jest.fn().mockRejectedValue(new Error('shutdown failed')),
    };
    createNestApplication.mockResolvedValue(app as never);

    await expect(
      bootstrapTaskRuntime({
        NODE_ENV: 'test',
        TASK_RUNTIME_ENABLED: 'true',
        TASK_MONGODB_URI: 'mongodb://127.0.0.1:27017/continuum_task',
        TASK_SERVICE_PORT: '3909',
      }),
    ).rejects.toBe(listenError);

    expect(app.close).toHaveBeenCalledTimes(1);
  });
});
