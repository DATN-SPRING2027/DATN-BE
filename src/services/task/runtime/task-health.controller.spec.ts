import { ServiceUnavailableException } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, ConnectionStates } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { TaskHealthController } from './task-health.controller';

describe('TaskHealthController', () => {
  it('keeps liveness independent from MongoDB state', () => {
    const connection = {
      readyState: ConnectionStates.disconnected,
    } as Connection;
    const controller = new TaskHealthController(connection);

    expect(controller.getLiveness()).toEqual({ status: 'live' });
  });

  it('reports readiness only while the Task connection is connected', () => {
    const connected = { readyState: ConnectionStates.connected } as Connection;
    const readyController = new TaskHealthController(connected);
    expect(readyController.getReadiness()).toEqual({ status: 'ready' });

    const disconnected = {
      readyState: ConnectionStates.disconnected,
    } as Connection;
    const unavailableController = new TaskHealthController(disconnected);

    try {
      unavailableController.getReadiness();
      throw new Error('Expected readiness failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getStatus()).toBe(503);
      expect((error as ServiceUnavailableException).getResponse()).toEqual({
        status: 'not_ready',
      });
    }
  });

  it('serves liveness and readiness through the internal HTTP routes', async () => {
    const connection: { readyState: number } = {
      readyState: ConnectionStates.disconnected,
    };
    const module = await Test.createTestingModule({
      controllers: [TaskHealthController],
      providers: [
        {
          provide: getConnectionToken(),
          useValue: connection,
        },
      ],
    }).compile();
    const app = module.createNestApplication();
    app.setGlobalPrefix('internal');

    try {
      await app.init();
      const httpServer = app.getHttpServer() as App;

      await request(httpServer)
        .get('/internal/health/live')
        .expect(200)
        .expect({ status: 'live' });
      await request(httpServer)
        .get('/internal/health/ready')
        .expect(503)
        .expect({ status: 'not_ready' });

      connection.readyState = ConnectionStates.connected;
      await request(httpServer)
        .get('/internal/health/ready')
        .expect(200)
        .expect({ status: 'ready' });
    } finally {
      await app.close();
    }
  });
});
