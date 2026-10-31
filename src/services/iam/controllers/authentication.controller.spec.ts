import {
  ConflictException,
  INestApplication,
  Logger,
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
import { GoogleOAuthService } from '../application/authentication/google-oauth.service';
import {
  PasswordResetRequestUnavailableError,
  PasswordResetService,
} from '../application/authentication/password-reset.service';
import { configureApplication } from '../../../bootstrap';
import { signGatewaySource } from '../../../common/http/gateway-source';

const gatewaySecret = 'test-gateway-secret-at-least-32-characters';

type PasswordResetRequestInput = { email: string; sourceIp: string };
type PasswordResetConfirmInput = {
  token: string;
  password: string;
  sourceIp: string;
};

describe('AuthenticationController', () => {
  let app: INestApplication;
  let service: {
    login: jest.Mock;
    loginWithGoogle: jest.Mock;
    loginPlatform: jest.Mock;
    getCurrentIdentity: jest.Mock;
    getCurrentSessionIdentity: jest.Mock;
    getCurrentPlatformSessionIdentity: jest.Mock;
    listOrganizationOptions: jest.Mock;
    selectOrganization: jest.Mock;
    logout: jest.Mock;
    refresh: jest.Mock;
  };
  let googleOAuth: {
    begin: jest.Mock;
    verifyCallback: jest.Mock;
  };
  let passwordReset: {
    requestReset: jest.MockedFunction<
      (input: PasswordResetRequestInput) => Promise<{ status: 'accepted' }>
    >;
    completeReset: jest.MockedFunction<
      (input: PasswordResetConfirmInput) => Promise<void>
    >;
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
      loginPlatform: jest.fn().mockResolvedValue({
        accessToken: 'platform.private.jwt.value',
        refreshToken: 'platform-refresh',
        csrfToken: 'platform-csrf',
        user: {
          id: '651a2b3c4d5e6f7a8b9c0d1e',
          email: 'person@example.com',
          name: 'Test Person',
        },
      }),
      loginWithGoogle: jest.fn().mockResolvedValue({
        accessToken: 'google.private.jwt.value',
        refreshToken: 'google-refresh',
        csrfToken: 'google-csrf',
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
      getCurrentSessionIdentity: jest
        .fn()
        .mockImplementation((authorization, cookie) => {
          if (!authorization && !cookie)
            return Promise.reject(
              new UnauthorizedException({ code: 'AUTHENTICATION_FAILED' }),
            );
          return Promise.resolve({
            id: '651a2b3c4d5e6f7a8b9c0d1e',
            email: 'person@example.com',
            name: 'Test Person',
            context: 'ACCOUNT',
          });
        }),
      getCurrentPlatformSessionIdentity: jest.fn().mockResolvedValue({
        id: '651a2b3c4d5e6f7a8b9c0d1e',
        email: 'person@example.com',
        name: 'Test Person',
        context: 'PLATFORM',
        permissions: ['platform.health.read'],
      }),
      listOrganizationOptions: jest.fn().mockResolvedValue([]),
      selectOrganization: jest.fn().mockResolvedValue({
        accessToken: 'selected-access',
        refreshToken: 'selected-refresh',
        csrfToken: 'selected-csrf',
        user: {
          id: 'user-id',
          email: 'person@example.com',
          name: 'Person',
          organizationId: '651a2b3c4d5e6f7a8b9c0d1f',
          roles: ['ADMIN'],
        },
      }),
      logout: jest.fn().mockResolvedValue(undefined),
      refresh: jest.fn(),
    };
    googleOAuth = {
      begin: jest.fn().mockResolvedValue({
        authorizationUrl: 'https://accounts.google.com/oauth2/auth',
        stateCookie: 'encrypted-google-state',
      }),
      verifyCallback: jest.fn().mockResolvedValue({
        subject: 'google-subject-123',
        email: 'person@example.com',
        emailVerified: true,
        name: 'Test Person',
      }),
    };
    passwordReset = {
      requestReset: jest
        .fn<Promise<{ status: 'accepted' }>, [PasswordResetRequestInput]>(() =>
          Promise.resolve({ status: 'accepted' }),
        )
        .mockResolvedValue({ status: 'accepted' }),
      completeReset: jest
        .fn<Promise<void>, [PasswordResetConfirmInput]>(() =>
          Promise.resolve(undefined),
        )
        .mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({
      controllers: [AuthenticationController],
      providers: [
        { provide: AuthenticationApplicationService, useValue: service },
        { provide: GoogleOAuthService, useValue: googleOAuth },
        { provide: PasswordResetService, useValue: passwordReset },
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
    service.loginPlatform.mockResolvedValue({
      accessToken: 'platform.private.jwt.value',
      refreshToken: 'platform-refresh',
      csrfToken: 'platform-csrf',
      user: {
        id: '651a2b3c4d5e6f7a8b9c0d1e',
        email: 'person@example.com',
        name: 'Test Person',
      },
    });
    service.refresh.mockResolvedValue({
      accessToken: 'replacement.access.value',
      refreshToken: 'replacement-refresh-value',
    });
    passwordReset.requestReset.mockResolvedValue({ status: 'accepted' });
    passwordReset.completeReset.mockResolvedValue(undefined);
    service.loginWithGoogle.mockResolvedValue({
      accessToken: 'google.private.jwt.value',
      refreshToken: 'google-refresh',
      csrfToken: 'google-csrf',
      user: {
        id: '651a2b3c4d5e6f7a8b9c0d1e',
        email: 'person@example.com',
        name: 'Test Person',
        organizationId: '651a2b3c4d5e6f7a8b9c0d1f',
        roles: ['MEMBER'],
      },
    });
    googleOAuth.begin.mockResolvedValue({
      authorizationUrl: 'https://accounts.google.com/oauth2/auth',
      stateCookie: 'encrypted-google-state',
    });
    googleOAuth.verifyCallback.mockResolvedValue({
      subject: 'google-subject-123',
      email: 'person@example.com',
      emailVerified: true,
      name: 'Test Person',
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
    expect(response.headers['set-cookie'][1]).toContain('Path=/api/v1/auth');
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

  it('GET /api/v1/auth/google starts provider navigation with a browser-bound cookie', async () => {
    const response = await request(app.getHttpServer() as App)
      .get('/api/v1/auth/google?organizationId=651a2b3c4d5e6f7a8b9c0d1f')
      .expect(302);

    expect(response.headers.location).toBe(
      'https://accounts.google.com/oauth2/auth',
    );
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['set-cookie'][0]).toContain(
      '__Host-continuum-google-oauth-state=encrypted-google-state',
    );
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(response.headers['set-cookie'][0]).toContain('SameSite=Lax');
    expect(response.headers['set-cookie'][0]).toContain('Path=/');
    expect(response.headers['set-cookie'][0]).toContain('Secure');
    expect(response.headers['set-cookie'][0]).not.toContain('Domain=');
    expect(googleOAuth.begin).toHaveBeenCalledWith('651a2b3c4d5e6f7a8b9c0d1f');
  });

  it('GET /api/v1/auth/google/callback issues session cookies and opens Organization selection', async () => {
    const requestId = 'b127a512-4b27-4a62-96a3-587ae4d2e4b0';
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const response = await request(app.getHttpServer() as App)
      .get('/api/v1/auth/google/callback?code=auth-code&state=oauth-state')
      .set('X-Request-ID', requestId)
      .set(
        'Cookie',
        '__Host-continuum-google-oauth-state=encrypted-google-state',
      )
      .expect(302);

    expect(response.headers.location).toBe('/select-organization');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(googleOAuth.verifyCallback).toHaveBeenCalledWith(
      {
        code: 'auth-code',
        state: 'oauth-state',
        stateCookie: 'encrypted-google-state',
      },
      requestId,
    );
    expect(service.loginWithGoogle).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'google-subject-123' }),
      undefined,
      requestId,
    );
    expect(response.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('continuum_access=google.private.jwt.value'),
        expect.stringContaining('__Secure-refresh=google-refresh'),
        expect.stringContaining('__Host-csrf=google-csrf'),
        expect.stringContaining('__Host-continuum-google-oauth-state=;'),
      ]),
    );
    const callbackLogs = log.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('google_oauth.callback'));
    expect(callbackLogs.join('\n')).toContain('"stage":"callback_received"');
    expect(callbackLogs.join('\n')).toContain('"stage":"callback_completed"');
    expect(callbackLogs.join('\n')).not.toContain('google.private.jwt.value');
    expect(callbackLogs.join('\n')).not.toContain('google-refresh');
    log.mockRestore();
  });

  it('GET /api/v1/auth/google/callback returns organization selection to the BFF without a session', async () => {
    service.loginWithGoogle.mockRejectedValueOnce(
      new ConflictException({
        code: 'ORGANIZATION_SELECTION_REQUIRED',
        message: 'Select an organization to continue.',
        details: {
          organizations: [
            { id: '651a2b3c4d5e6f7a8b9c0d1f', name: 'Alpha' },
            { id: '651a2b3c4d5e6f7a8b9c0d20', name: 'Beta' },
          ],
        },
      }),
    );

    const response = await request(app.getHttpServer() as App)
      .get('/api/v1/auth/google/callback?code=auth-code&state=oauth-state')
      .set(
        'Cookie',
        '__Host-continuum-google-oauth-state=encrypted-google-state',
      )
      .expect(409);

    expect(response.body).toMatchObject({
      code: 'ORGANIZATION_SELECTION_REQUIRED',
    });
    expect(response.headers['set-cookie']).toContainEqual(
      expect.stringContaining('__Host-continuum-google-oauth-state=;'),
    );
    expect(response.headers['set-cookie']).not.toContainEqual(
      expect.stringContaining('continuum_access='),
    );
  });

  it('POST /api/v1/auth/platform/login sets the Platform session cookies and omits tenant identity', async () => {
    const response = await request(app.getHttpServer() as App)
      .post('/api/v1/auth/platform/login')
      .send({ email: 'person@example.com', password: 'password' })
      .expect(200);

    expect(response.body).toEqual({
      context: 'PLATFORM',
      user: {
        id: '651a2b3c4d5e6f7a8b9c0d1e',
        email: 'person@example.com',
        name: 'Test Person',
      },
    });
    expect(JSON.stringify(response.body)).not.toContain(
      'platform.private.jwt.value',
    );
    expect(response.headers['set-cookie']).toHaveLength(3);
    expect(response.headers['set-cookie'][0]).toContain('continuum_access=');
    expect(response.headers['set-cookie'][1]).toContain('__Secure-refresh=');
    expect(response.headers['set-cookie'][2]).toContain('__Host-csrf=');
    expect(response.headers['cache-control']).toBe('no-store');
    const calls = service.loginPlatform.mock.calls as unknown[][];
    expect(calls[0][0]).toMatchObject({
      email: 'person@example.com',
      password: 'password',
    });
  });

  it('rejects Organization selectors on the Platform login route', async () => {
    await request(app.getHttpServer() as App)
      .post('/api/v1/auth/platform/login')
      .send({
        email: 'person@example.com',
        password: 'password',
        organizationId: '651a2b3c4d5e6f7a8b9c0d1f',
      })
      .expect(422);
    expect(service.loginPlatform).not.toHaveBeenCalled();
  });

  it('returns a generic no-store response for a password reset request', async () => {
    await request(app.getHttpServer() as App)
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'person@example.com' })
      .expect(202)
      .expect((response) => {
        expect(response.body).toEqual({ status: 'accepted' });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['referrer-policy']).toBe('no-referrer');
      });
    const input = passwordReset.requestReset.mock.calls[0][0];
    expect(input.email).toBe('person@example.com');
    expect(typeof input.sourceIp).toBe('string');
  });

  it('returns a generic 503 when the reset request cannot be durably queued', async () => {
    passwordReset.requestReset.mockRejectedValueOnce(
      new PasswordResetRequestUnavailableError(),
    );

    await request(app.getHttpServer() as App)
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'person@example.com' })
      .expect(503)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'PASSWORD_RESET_REQUEST_UNAVAILABLE',
          message: 'Password reset is temporarily unavailable.',
        });
      });
  });

  it('validates password reset request and confirm bodies before calling the service', async () => {
    await request(app.getHttpServer() as App)
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'not-an-email', extra: true })
      .expect(422);
    await request(app.getHttpServer() as App)
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token: 'short', password: 'short' })
      .expect(422);
    expect(passwordReset.requestReset).not.toHaveBeenCalled();
    expect(passwordReset.completeReset).not.toHaveBeenCalled();
  });

  it('confirms a password reset with a one-time token and returns no body', async () => {
    await request(app.getHttpServer() as App)
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token: 'a'.repeat(43), password: 'A-long-password-123' })
      .expect(204)
      .expect((response) => {
        expect(response.text).toBe('');
        expect(response.headers['set-cookie']).toHaveLength(3);
        expect(response.headers['set-cookie'][0]).toContain('Max-Age=0');
      });

    const [input] = passwordReset.completeReset.mock.calls[0];
    expect(input.token).toBe('a'.repeat(43));
    expect(input.password).toBe('A-long-password-123');
    expect(typeof input.sourceIp).toBe('string');
  });

  it('accepts a signed source on the internal route and rejects an unsigned one', async () => {
    const module = await Test.createTestingModule({
      controllers: [AuthenticationController],
      providers: [
        { provide: AuthenticationApplicationService, useValue: service },
        { provide: GoogleOAuthService, useValue: googleOAuth },
        { provide: PasswordResetService, useValue: passwordReset },
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
    expect(service.getCurrentSessionIdentity).toHaveBeenCalledWith(
      'Bearer access-token',
      undefined,
    );

    await request(server)
      .get('/api/v1/auth/me')
      .set('Cookie', 'continuum_access=cookie-token')
      .expect(200);
    expect(service.getCurrentSessionIdentity).toHaveBeenLastCalledWith(
      undefined,
      'continuum_access=cookie-token',
    );
  });

  it('GET /api/v1/auth/me returns 401 when unauthenticated', async () => {
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    await request(app.getHttpServer() as App)
      .get('/api/v1/auth/me')
      .expect(401);
    const callbackEvents = warning.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('google_oauth.callback'));
    expect(callbackEvents).toHaveLength(0);
    warning.mockRestore();
  });

  it('GET /api/v1/auth/platform/me returns the current Platform permission projection', async () => {
    const response = await request(app.getHttpServer() as App)
      .get('/api/v1/auth/platform/me')
      .set('Cookie', '__Host-csrf=csrf-value; continuum_access=platform-cookie')
      .expect(200);

    expect(response.body).toEqual({
      id: '651a2b3c4d5e6f7a8b9c0d1e',
      email: 'person@example.com',
      name: 'Test Person',
      context: 'PLATFORM',
      permissions: ['platform.health.read'],
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(service.getCurrentPlatformSessionIdentity).toHaveBeenCalledWith(
      undefined,
      '__Host-csrf=csrf-value; continuum_access=platform-cookie',
    );
  });

  it('POST /api/v1/auth/logout requires the matching CSRF pair for cookie sessions', async () => {
    const response = await request(app.getHttpServer() as App)
      .post('/api/v1/auth/logout')
      .set('Cookie', '__Secure-refresh=opaque-refresh; __Host-csrf=csrf-value')
      .set('X-CSRF-Token', 'csrf-value')
      .expect(200)
      .expect({ status: 'logged_out' });

    expect(service.logout).toHaveBeenCalledWith(
      undefined,
      '__Secure-refresh=opaque-refresh; __Host-csrf=csrf-value',
    );
    expect(response.headers['set-cookie']).toHaveLength(2);
    expect(response.headers['set-cookie'][0]).toContain('continuum_access=');
    expect(response.headers['set-cookie'][0]).toContain('Path=/');
    expect(response.headers['set-cookie'][0]).toContain('Max-Age=0');
    expect(response.headers['set-cookie'][1]).toContain('__Secure-refresh=');
    expect(response.headers['set-cookie'][1]).toContain('Path=/api/v1/auth');
    expect(response.headers['set-cookie'][1]).toContain('Max-Age=0');
    expect(response.headers['set-cookie'][1]).toContain('HttpOnly');
    expect(response.headers['set-cookie'][1]).toContain('Secure');
  });

  it.each([
    [
      'missing',
      '__Secure-refresh=opaque-refresh; __Host-csrf=csrf-value',
      undefined,
    ],
    [
      'mismatched',
      '__Secure-refresh=opaque-refresh; __Host-csrf=csrf-value',
      'other-token',
    ],
  ])(
    'POST /api/v1/auth/logout rejects a %s CSRF pair before revoking cookies',
    async (_case, cookie, csrfHeader) => {
      const response = await request(app.getHttpServer() as App)
        .post('/api/v1/auth/logout')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrfHeader ?? '')
        .expect(403);

      expect(response.body).toMatchObject({ code: 'AUTH_CSRF_INVALID' });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(service.logout).not.toHaveBeenCalled();
    },
  );

  it('POST /api/v1/auth/logout preserves bearer-only logout clients', async () => {
    await request(app.getHttpServer() as App)
      .post('/api/v1/auth/logout')
      .set('Authorization', 'Bearer access-token')
      .expect(200);

    expect(service.logout).toHaveBeenCalledWith(
      'Bearer access-token',
      undefined,
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
    expect(response.headers['set-cookie'][1]).toContain('Path=/api/v1/auth');
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
