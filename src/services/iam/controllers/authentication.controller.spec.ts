import {
  ConflictException,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { NextFunction, Request, Response } from 'express';
import {
  AuthenticationApplicationService,
  RefreshCsrfError,
} from '../application/authentication/authentication.application.service';
import { AuthenticationController } from './authentication.controller';
import { configureApplication } from '../../../bootstrap';
import { signGatewaySource } from '../../../common/http/gateway-source';

const gatewaySecret = 'test-gateway-secret-at-least-32-characters';

describe('AuthenticationController', () => {
  let app: INestApplication;
  let service: {
    login: jest.Mock;
    getCurrentIdentity: jest.Mock;
    logout: jest.Mock;
    refresh: jest.Mock;
  };

  beforeAll(async () => {
    service = {
      login: jest.fn().mockResolvedValue({
        accessToken: 'private.jwt.value',
        refreshToken: 'initial-refresh',
        csrfToken: 'initial-csrf',
        user: {
          id: '651a2b3c4d5e6f7a8b9c0d1e',
          email: 'person@example.com',
          name: 'Test Person',
          organizationId: '651a2b3c4d5e6f7a8b9c0d1f',
          roles: ['MEMBER'],
        },
      }),
      getCurrentIdentity: jest
        .fn()
        .mockImplementation((authorization, cookie) => {
          if (!authorization && !cookie) {
            return Promise.reject(
              new UnauthorizedException({
                code: 'AUTHENTICATION_FAILED',
                message: 'Authentication failed.',
              }),
            );
          }
          return Promise.resolve({
            id: '651a2b3c4d5e6f7a8b9c0d1e',
            email: 'person@example.com',
            name: 'Test Person',
            organizationId: '651a2b3c4d5e6f7a8b9c0d1f',
            roles: ['MEMBER'],
          });
        }),
      logout: jest.fn().mockResolvedValue(undefined),
      refresh: jest.fn(),
    };
    const module = await Test.createTestingModule({
      controllers: [AuthenticationController],
      providers: [
        { provide: AuthenticationApplicationService, useValue: service },
        {
          provide: ConfigService,
          useValue: {
            get: (name: string) =>
              name === 'IAM_GATEWAY_SECRET' ? gatewaySecret : undefined,
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service.login.mockResolvedValue({
      accessToken: 'private.jwt.value',
      refreshToken: 'initial-refresh',
      csrfToken: 'initial-csrf',
      user: {
        id: '651a2b3c4d5e6f7a8b9c0d1e',
        email: 'person@example.com',
        name: 'Test Person',
        organizationId: '651a2b3c4d5e6f7a8b9c0d1f',
        roles: ['MEMBER'],
      },
    });
    service.refresh.mockResolvedValue({
      accessToken: 'replacement.access.value',
      refreshToken: 'replacement-refresh-value',
    });
  });

  it('POST /api/v1/auth/login sets an HttpOnly cookie and never returns the token body', async () => {
    const response = await request(app.getHttpServer() as App)
      .post('/api/v1/auth/login')
      .send({ email: 'person@example.com', password: 'password' })
      .expect(200);

    const responseBody: unknown = response.body;
    expect(responseBody).toMatchObject({
      user: {
        email: 'person@example.com',
        organizationId: '651a2b3c4d5e6f7a8b9c0d1f',
        roles: ['MEMBER'],
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('private.jwt.value');
    expect(response.headers['set-cookie'][0]).toContain('continuum_access=');
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(response.headers['set-cookie'][0]).toContain('Path=/');
    expect(response.headers['set-cookie']).toHaveLength(3);
    expect(response.headers['set-cookie'][0]).toContain('SameSite=Lax');
    expect(response.headers['set-cookie'][1]).toContain('__Secure-refresh=');
    expect(response.headers['set-cookie'][1]).toContain(
      'Path=/api/v1/auth/refresh',
    );
    expect(response.headers['set-cookie'][1]).toContain('Secure');
    expect(response.headers['set-cookie'][2]).toContain('__Host-csrf=');
    expect(response.headers['set-cookie'][2]).toContain('Path=/');
    expect(response.headers['set-cookie'][2]).toContain('Secure');
    expect(response.headers['set-cookie'][2]).toContain('SameSite=Lax');
    expect(response.headers['set-cookie'][2]).not.toContain('HttpOnly');
    expect(response.headers['set-cookie'][2]).not.toContain('Domain=');
    expect(response.headers['cache-control']).toBe('no-store');
    const loginCalls = service.login.mock.calls as unknown[][];
    const loginInput = loginCalls[0]?.[0] as {
      email: string;
      sourceIp: string;
    };
    expect(loginInput.email).toBe('person@example.com');
    expect(typeof loginInput.sourceIp).toBe('string');
  });

  it('accepts a signed source on the internal route and rejects an unsigned one', async () => {
    const module = await Test.createTestingModule({
      controllers: [AuthenticationController],
      providers: [
        { provide: AuthenticationApplicationService, useValue: service },
        { provide: ConfigService, useValue: { get: () => gatewaySecret } },
      ],
    }).compile();
    const internalApp = module.createNestApplication();
    internalApp.setGlobalPrefix('internal');
    let observedPeer = '';
    internalApp.use((req: Request, _res: Response, next: NextFunction) => {
      Object.defineProperty(req.socket, 'remoteAddress', {
        configurable: true,
        value: '10.1.2.3',
      });
      observedPeer = req.socket.remoteAddress ?? '';
      next();
    });
    await internalApp.init();
    try {
      const server = internalApp.getHttpServer() as App;
      const body = { email: 'person@example.com', password: 'password' };
      await request(server).post('/internal/auth/login').send(body).expect(401);
      expect(service.login).not.toHaveBeenCalled();

      const proof = signGatewaySource('203.0.113.7', gatewaySecret);
      await request(server)
        .post('/internal/auth/login')
        .set(proof)
        .send(body)
        .expect(200);
      const loginCalls = service.login.mock.calls as unknown[][];
      const loginInput = loginCalls[0][0] as { sourceIp: string };
      expect(observedPeer).toBe('10.1.2.3');
      expect(loginInput.sourceIp).toBe('203.0.113.7');

      await request(server)
        .post('/internal/auth/login')
        .set({ ...proof, 'x-iam-source-ip': '203.0.113.8' })
        .send(body)
        .expect(401);
      expect(service.login).toHaveBeenCalledTimes(1);
    } finally {
      await internalApp.close();
    }
  });

  it('returns 422 for malformed payloads and does not call login', async () => {
    await request(app.getHttpServer() as App)
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: '', unexpected: true })
      .expect(422);
    expect(service.login).not.toHaveBeenCalled();
  });

  it('returns 409 when organization selection is required', async () => {
    service.login.mockRejectedValue(
      new ConflictException({
        code: 'ORGANIZATION_SELECTION_REQUIRED',
        message: 'Select an organization to continue.',
        details: {
          organizations: [{ id: '651a2b3c4d5e6f7a8b9c0d1f', name: 'Alpha' }],
        },
      }),
    );
    const response = await request(app.getHttpServer() as App)
      .post('/api/v1/auth/login')
      .send({ email: 'person@example.com', password: 'password' })
      .expect(409);
    expect(response.body).toMatchObject({
      code: 'ORGANIZATION_SELECTION_REQUIRED',
      details: {
        organizations: [{ id: '651a2b3c4d5e6f7a8b9c0d1f', name: 'Alpha' }],
      },
    });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('GET /api/v1/auth/me supports Bearer and HttpOnly-cookie request context', async () => {
    const server = app.getHttpServer() as App;
    await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer access-token')
      .expect(200);
    expect(service.getCurrentIdentity).toHaveBeenCalledWith(
      'Bearer access-token',
      undefined,
    );

    await request(server)
      .get('/api/v1/auth/me')
      .set('Cookie', 'continuum_access=cookie-token')
      .expect(200);
    expect(service.getCurrentIdentity).toHaveBeenLastCalledWith(
      undefined,
      'continuum_access=cookie-token',
    );
  });

  it('GET /api/v1/auth/me returns 401 when unauthenticated', async () => {
    await request(app.getHttpServer() as App)
      .get('/api/v1/auth/me')
      .expect(401);
  });

  it('POST /api/v1/auth/logout is idempotent and clears the known access-cookie path', async () => {
    const response = await request(app.getHttpServer() as App)
      .post('/api/v1/auth/logout')
      .set('Cookie', 'continuum_refresh=opaque-refresh')
      .expect(200)
      .expect({ status: 'logged_out' });

    expect(service.logout).toHaveBeenCalledWith(
      undefined,
      'continuum_refresh=opaque-refresh',
    );
    expect(response.headers['set-cookie'][0]).toContain('continuum_access=');
    expect(response.headers['set-cookie'][0]).toContain('Path=/');
    expect(response.headers['set-cookie'][0]).toContain('Max-Age=0');
    expect(response.headers['set-cookie'][0]).not.toContain(
      'continuum_refresh=',
    );
  });

  it('POST /api/v1/auth/refresh returns 200 with two separate replacement cookies and no JSON tokens', async () => {
    const response = await request(app.getHttpServer() as App)
      .post('/api/v1/auth/refresh')
      .set('Cookie', '__Host-csrf=csrf-value; __Secure-refresh=presented')
      .set('X-CSRF-Token', 'csrf-value')
      .expect(200);
    expect(response.body).toEqual({ status: 'refreshed' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toHaveLength(2);
    expect(response.headers['set-cookie'][0]).toMatch(/^continuum_access=/);
    expect(response.headers['set-cookie'][0]).toContain('Path=/;');
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(response.headers['set-cookie'][0]).toContain('SameSite=Lax');
    expect(response.headers['set-cookie'][0]).toContain('Max-Age=900');
    expect(response.headers['set-cookie'][1]).toMatch(/^__Secure-refresh=/);
    expect(response.headers['set-cookie'][1]).toContain(
      'Path=/api/v1/auth/refresh',
    );
    expect(response.headers['set-cookie'][1]).toContain('Secure');
    expect(response.headers['set-cookie'][1]).toContain('HttpOnly');
    expect(response.headers['set-cookie'][1]).toContain('SameSite=Lax');
    expect(response.headers['set-cookie'][1]).toContain('Max-Age=604800');
    expect(response.headers['set-cookie'][1]).not.toContain('Domain=');
    expect(service.refresh.mock.calls).toContainEqual([
      'presented',
      'csrf-value',
      'csrf-value',
    ]);
  });

  it('marks the refreshed access cookie Secure in production', async () => {
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const response = await request(app.getHttpServer() as App)
        .post('/api/v1/auth/refresh')
        .set('Cookie', '__Host-csrf=csrf-value; __Secure-refresh=presented')
        .set('X-CSRF-Token', 'csrf-value')
        .expect(200);
      expect(response.headers['set-cookie'][0]).toContain('Secure');
    } finally {
      process.env.NODE_ENV = priorNodeEnv;
    }
  });

  it.each([
    ['missing', '__Host-csrf=csrf-value'],
    ['malformed', '__Host-csrf=csrf-value; __Secure-refresh=bad'],
    ['unknown', '__Host-csrf=csrf-value; __Secure-refresh=unknown'],
    ['expired', '__Host-csrf=csrf-value; __Secure-refresh=expired'],
    ['revoked', '__Host-csrf=csrf-value; __Secure-refresh=revoked'],
    ['replayed', '__Host-csrf=csrf-value; __Secure-refresh=replayed'],
  ])(
    'maps %s refresh credential to generic 401 without replacement cookies',
    async (_case, cookie) => {
      service.refresh.mockRejectedValue(new UnauthorizedException());
      const response = await request(app.getHttpServer() as App)
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', 'csrf-value')
        .expect(401);
      expect(response.body).toMatchObject({ code: 'AUTH_REFRESH_INVALID' });
      expect(response.headers['set-cookie']).toBeUndefined();
    },
  );

  it.each([
    ['missing', '__Host-csrf=csrf-value', undefined],
    ['mismatch', '__Host-csrf=csrf-value; __Secure-refresh=presented', 'other'],
  ])(
    'maps %s CSRF to 403 with no replacement cookies',
    async (_case, cookie, header) => {
      service.refresh.mockRejectedValue(new RefreshCsrfError());
      let requestBuilder = request(app.getHttpServer() as App)
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie);
      if (header) requestBuilder = requestBuilder.set('X-CSRF-Token', header);
      const response = await requestBuilder.expect(403);
      expect(response.body).toMatchObject({ code: 'AUTH_CSRF_INVALID' });
      expect(response.headers['set-cookie']).toBeUndefined();
    },
  );

  it('maps transaction errors to generic 500 without replacement cookies', async () => {
    service.refresh.mockRejectedValue(new Error('database private detail'));
    const response = await request(app.getHttpServer() as App)
      .post('/api/v1/auth/refresh')
      .set('Cookie', '__Host-csrf=csrf-value; __Secure-refresh=presented')
      .set('X-CSRF-Token', 'csrf-value')
      .expect(500);
    expect(response.body).toMatchObject({ code: 'AUTH_REFRESH_FAILED' });
    expect(JSON.stringify(response.body)).not.toContain(
      'database private detail',
    );
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
