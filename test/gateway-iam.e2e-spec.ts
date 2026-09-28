import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../src/bootstrap';
import { GatewayModule } from '../src/gateway/gateway.module';

describe('microservice gateway IAM routes', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [GatewayModule],
    })
      .overrideProvider(ConfigService)
      .useValue({
        getOrThrow: (name: string) =>
          name === 'IAM_SERVICE_URL' ? 'http://iam.test:3001' : 5000,
      })
      .compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => jest.restoreAllMocks());

  it('forwards login and each Set-Cookie through the public route', async () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', 'continuum_access=abc; HttpOnly; Path=/');
    headers.append('set-cookie', 'other=xyz; HttpOnly; Path=/');
    const backend = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ user: { id: 'user-1' } }), {
        status: 200,
        headers,
      }),
    );

    const response = await request(app.getHttpServer() as App)
      .post('/api/v1/auth/login')
      .send({ email: 'person@example.test', password: 'password' })
      .expect(200);

    expect(backend).toHaveBeenCalledWith(
      'http://iam.test:3001/internal/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          email: 'person@example.test',
          password: 'password',
        }),
      }),
    );
    expect(response.headers['set-cookie']).toHaveLength(2);
    expect(response.body).toEqual({ user: { id: 'user-1' } });
    const loginHeaders = backend.mock.calls[0][1]?.headers as Record<
      string,
      string
    >;
    expect(typeof loginHeaders['x-iam-source-ip']).toBe('string');
  });

  it('replaces an untrusted source header before forwarding login', async () => {
    const backend = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 'ORGANIZATION_SELECTION_REQUIRED',
          details: {
            organizations: [{ id: 'org-a', name: 'Alpha' }],
          },
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    );
    const response = await request(app.getHttpServer() as App)
      .post('/api/v1/auth/login')
      .set('x-iam-source-ip', '203.0.113.200')
      .send({ email: 'person@example.test', password: 'password' })
      .expect(409);
    const headers = backend.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['x-iam-source-ip']).not.toBe('203.0.113.200');
    const body: unknown = response.body;
    expect(body).toMatchObject({
      details: {
        organizations: [{ id: 'org-a', name: 'Alpha' }],
      },
    });
  });

  it('forwards protected user requests and IAM authorization errors', async () => {
    const backend = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'AUTHENTICATION_FAILED' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await request(app.getHttpServer() as App)
      .get('/api/v1/iam/users?page=2&pageSize=20')
      .set('Cookie', 'continuum_access=abc')
      .expect(401);

    expect(backend).toHaveBeenCalledWith(
      'http://iam.test:3001/internal/iam/users?page=2&pageSize=20',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(backend.mock.calls[0][1]?.headers).toEqual({
      cookie: 'continuum_access=abc',
    });
    expect(response.body).toEqual({ code: 'AUTHENTICATION_FAILED' });
  });

  it('mounts the remaining Auth and User routes at the gateway', async () => {
    const backend = jest.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const server = app.getHttpServer() as App;

    await request(server).get('/api/v1/auth/me').expect(200);
    await request(server).post('/api/v1/auth/logout').expect(200);
    await request(server).get('/api/v1/iam/users/user-1').expect(200);
    await request(server)
      .patch('/api/v1/iam/users/user-1')
      .send({ fullName: 'Updated' })
      .expect(200);

    expect(backend.mock.calls.map(([url]) => url)).toEqual([
      'http://iam.test:3001/internal/auth/me',
      'http://iam.test:3001/internal/auth/logout',
      'http://iam.test:3001/internal/iam/users/user-1',
      'http://iam.test:3001/internal/iam/users/user-1',
    ]);
    expect(backend.mock.calls[3][1]).toEqual(
      expect.objectContaining({
        method: 'PATCH',
        body: '{"fullName":"Updated"}',
      }),
    );
  });
});
