import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { App } from 'supertest/types';
import { configureApplication } from '../src/bootstrap';

describe('Health (e2e)', () => {
  let app: INestApplication;
  const previousSecret = process.env.JWT_SECRET;
  const previousInfraEnabled = process.env.INFRA_ENABLED;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'unit-test-secret-at-least-32-characters';
    // This suite checks HTTP health behavior, so keep external infrastructure off.
    process.env.INFRA_ENABLED = 'false';
    const { AppModule } =
      jest.requireActual<typeof import('../src/app.module')>(
        '../src/app.module',
      );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    if (previousInfraEnabled === undefined) delete process.env.INFRA_ENABLED;
    else process.env.INFRA_ENABLED = previousInfraEnabled;
  });

  it('GET /api/v1/health', async () => {
    const server = app.getHttpServer() as App;

    const response = await request(server)
      .get('/api/v1/health')
      .set('Origin', 'http://localhost:3000')
      .expect(200)
      .expect({ status: 'ok' });

    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:3000',
    );
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('returns a structured error with the request id', async () => {
    const server = app.getHttpServer() as App;

    const response = await request(server)
      .get('/api/v1/does-not-exist')
      .set('x-request-id', 'architecture-check-1')
      .expect(404);

    expect(response.headers['x-request-id']).toBe('architecture-check-1');
    expect(response.body).toEqual({
      code: 'HTTP_404',
      message: 'Cannot GET /api/v1/does-not-exist',
      details: {},
      requestId: 'architecture-check-1',
    });
  });
});
