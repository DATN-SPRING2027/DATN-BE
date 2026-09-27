import {
  ConflictException,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import { AuthenticationController } from './authentication.controller';

describe('AuthenticationController', () => {
  let app: INestApplication;
  let service: {
    login: jest.Mock;
    getCurrentIdentity: jest.Mock;
    logout: jest.Mock;
  };

  beforeAll(async () => {
    service = {
      login: jest.fn().mockResolvedValue({
        accessToken: 'private.jwt.value',
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
    };
    const module = await Test.createTestingModule({
      controllers: [AuthenticationController],
      providers: [
        { provide: AuthenticationApplicationService, useValue: service },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service.login.mockResolvedValue({
      accessToken: 'private.jwt.value',
      user: {
        id: '651a2b3c4d5e6f7a8b9c0d1e',
        email: 'person@example.com',
        name: 'Test Person',
        organizationId: '651a2b3c4d5e6f7a8b9c0d1f',
        roles: ['MEMBER'],
      },
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
    expect(response.headers['cache-control']).toBe('no-store');
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
      }),
    );
    await request(app.getHttpServer() as App)
      .post('/api/v1/auth/login')
      .send({ email: 'person@example.com', password: 'password' })
      .expect(409);
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
      'continuum_refresh=opaque-refresh',
    );
    expect(response.headers['set-cookie'][0]).toContain('continuum_access=');
    expect(response.headers['set-cookie'][0]).toContain('Path=/');
    expect(response.headers['set-cookie'][0]).toContain('Max-Age=0');
    expect(response.headers['set-cookie'][0]).not.toContain(
      'continuum_refresh=',
    );
  });
});
