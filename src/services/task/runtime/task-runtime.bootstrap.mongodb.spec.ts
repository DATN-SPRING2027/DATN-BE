import { createServer } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection, ConnectionStates } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { listenTaskRuntime } from '../main';
import { createTaskRuntimeConfig } from './task-runtime.config';
import { TaskRuntimeModule } from './task-runtime.module';

const testMongoUri = process.env.TASK_MONGODB_TEST_URI;
const describeWithMongo = testMongoUri ? describe : describe.skip;

describeWithMongo('Task runtime MongoDB shutdown integration', () => {
  it('serves internal health over HTTP with the authenticated Task connection', async () => {
    const config = createTaskRuntimeConfig({
      NODE_ENV: 'test',
      TASK_RUNTIME_ENABLED: 'true',
      TASK_MONGODB_URI: testMongoUri,
      TASK_SERVICE_PORT: '3909',
    });
    const app = await NestFactory.create(TaskRuntimeModule.register(config), {
      logger: false,
    });
    app.setGlobalPrefix('internal');

    try {
      await app.init();
      const connection = app.get<Connection>(getConnectionToken());
      expect(connection.readyState).toBe(ConnectionStates.connected);

      await listenTaskRuntime(app, 0);
      const httpServer = app.getHttpServer() as App;

      await request(httpServer)
        .get('/internal/health/live')
        .expect(200)
        .expect({ status: 'live' });
      await request(httpServer)
        .get('/internal/health/ready')
        .expect(200)
        .expect({ status: 'ready' });

      await request(httpServer)
        .get('/internal/api/v1/projects/abcdef0123456789abcdef01/tasks')
        .expect(404);
      await request(httpServer)
        .get(
          '/internal/api/v1/projects/abcdef0123456789abcdef01/tasks/fedcba9876543210fedcba98',
        )
        .expect(404);
      await request(httpServer)
        .post('/internal/api/v1/projects/abcdef0123456789abcdef01/tasks')
        .send({ title: 'Must remain unreachable' })
        .expect(404);
    } finally {
      await app.close();
    }
  }, 45_000);

  it('keeps liveness while reporting not-ready after the Mongo connection closes', async () => {
    const config = createTaskRuntimeConfig({
      NODE_ENV: 'test',
      TASK_RUNTIME_ENABLED: 'true',
      TASK_MONGODB_URI: testMongoUri,
      TASK_SERVICE_PORT: '3909',
    });
    const app = await NestFactory.create(TaskRuntimeModule.register(config), {
      logger: false,
    });
    app.setGlobalPrefix('internal');

    try {
      await app.init();
      const connection = app.get<Connection>(getConnectionToken());
      expect(connection.readyState).toBe(ConnectionStates.connected);

      await listenTaskRuntime(app, 0);
      const httpServer = app.getHttpServer() as App;
      await request(httpServer)
        .get('/internal/health/ready')
        .expect(200)
        .expect({ status: 'ready' });

      await connection.close();
      expect(connection.readyState).toBe(ConnectionStates.disconnected);

      await request(httpServer)
        .get('/internal/health/live')
        .expect(200)
        .expect({ status: 'live' });
      await request(httpServer)
        .get('/internal/health/ready')
        .expect(503)
        .expect({ status: 'not_ready' });
    } finally {
      await app.close();
    }
  }, 45_000);

  it('closes an authenticated replica-set connection after HTTP bind fails', async () => {
    const parsedUri = new URL(testMongoUri!);
    expect(parsedUri.protocol).toBe('mongodb:');
    expect(parsedUri.username).not.toBe('');
    expect(parsedUri.password).not.toBe('');
    expect(parsedUri.hostname).toMatch(/^(127\.0\.0\.1|localhost|\[::1\])$/);
    expect(parsedUri.pathname).toBe('/continuum_task');
    expect(parsedUri.searchParams.get('replicaSet')).toBeTruthy();
    expect(parsedUri.searchParams.get('authSource')).toBeTruthy();

    const occupiedServer = createServer();
    await new Promise<void>((resolve, reject) => {
      occupiedServer.once('error', reject);
      occupiedServer.listen(0, '127.0.0.1', resolve);
    });

    const address = occupiedServer.address();
    if (!address || typeof address === 'string') {
      await new Promise<void>((resolve) =>
        occupiedServer.close(() => resolve()),
      );
      throw new Error('Test server did not bind to a TCP port');
    }

    let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
    try {
      const config = createTaskRuntimeConfig({
        NODE_ENV: 'test',
        TASK_RUNTIME_ENABLED: 'true',
        TASK_MONGODB_URI: testMongoUri,
        TASK_SERVICE_PORT: '3909',
      });
      app = await NestFactory.create(TaskRuntimeModule.register(config), {
        logger: false,
      });
      await app.init();

      const connection = app.get<Connection>(getConnectionToken());
      expect(connection.readyState).toBe(ConnectionStates.connected);
      const connectionClosed = new Promise<void>((resolve) => {
        connection.once('close', () => resolve());
      });

      await expect(listenTaskRuntime(app, address.port)).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
      await connectionClosed;

      expect(connection.readyState).toBe(ConnectionStates.disconnected);
    } finally {
      await app?.close().catch(() => undefined);
      await new Promise<void>((resolve) => {
        occupiedServer.close(() => resolve());
      });
    }
  }, 45_000);
});
