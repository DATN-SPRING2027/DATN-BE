import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
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
