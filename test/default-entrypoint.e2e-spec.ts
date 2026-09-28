import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';

describe('default AppModule HTTP entrypoint', () => {
  let app: INestApplication;
  const previousSecret = process.env.JWT_SECRET;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'unit-test-secret-at-least-32-characters';
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  it('mounts Auth and User routes with shared HTTP middleware', async () => {
    const server = app.getHttpServer() as App;
    const me = await request(server).get('/api/v1/auth/me').expect(401);
    const users = await request(server).get('/api/v1/iam/users').expect(401);
    await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'invalid', password: '' })
      .expect(422);
    expect(me.headers['x-request-id']).toBeDefined();
    expect(users.headers['x-content-type-options']).toBe('nosniff');
  });
});
