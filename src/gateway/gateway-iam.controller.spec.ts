import type { Request, Response } from 'express';
import { GatewayIamController } from './gateway-iam.controller';

describe('GatewayIamController Google OAuth forwarding', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps authorization redirects and OAuth cookies for the browser', async () => {
    const config = {
      getOrThrow: (key: string) =>
        key === 'IAM_GATEWAY_SECRET'
          ? 'gateway-secret-with-at-least-thirty-two-characters'
          : key === 'IAM_SERVICE_URL'
            ? 'http://127.0.0.1:3001'
            : 5000,
    };
    const controller = new GatewayIamController(config as never);
    const headers = new Headers({
      location: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    headers.append(
      'set-cookie',
      '__Host-continuum-google-oauth-state=sealed; Path=/; HttpOnly; SameSite=Lax; Secure',
    );
    const upstream = new globalThis.Response(null, { status: 302, headers });
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(upstream);
    const response = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };

    await controller.beginGoogleLogin(
      {
        method: 'GET',
        path: '/api/v1/auth/google',
        originalUrl:
          '/api/v1/auth/google?organizationId=651a2b3c4d5e6f7a8b9c0d1f',
        headers: { cookie: 'continuum_access=existing' },
      } as unknown as Request,
      response as unknown as Response,
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:3001/internal/auth/google?organizationId=651a2b3c4d5e6f7a8b9c0d1f',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'manual',
      method: 'GET',
    });
    expect(response.status).toHaveBeenCalledWith(302);
    expect(response.setHeader).toHaveBeenCalledWith(
      'location',
      'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
    );
    expect(response.setHeader).toHaveBeenCalledWith('set-cookie', [
      '__Host-continuum-google-oauth-state=sealed; Path=/; HttpOnly; SameSite=Lax; Secure',
    ]);
    expect(response.setHeader).toHaveBeenCalledWith(
      'referrer-policy',
      'no-referrer',
    );
  });
});

describe('GatewayIamController invitation forwarding', () => {
  afterEach(() => jest.restoreAllMocks());

  it('forwards authenticated email inbox and CSRF headers to IAM', async () => {
    const config = {
      getOrThrow: (key: string) =>
        key === 'IAM_GATEWAY_SECRET'
          ? 'gateway-secret-with-at-least-thirty-two-characters'
          : key === 'IAM_SERVICE_URL'
            ? 'http://127.0.0.1:3001'
            : 5000,
    };
    const controller = new GatewayIamController(config as never);
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new globalThis.Response('[]', { status: 200 }));
    const response = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };

    await controller.listMyInvitations(
      {
        method: 'GET',
        path: '/api/v1/auth/invitations',
        originalUrl: '/api/v1/auth/invitations',
        headers: {
          authorization: 'Bearer account-token',
          cookie: '__Host-csrf=csrf; continuum_access=access',
          'x-csrf-token': 'csrf',
        },
      } as unknown as Request,
      response as unknown as Response,
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:3001/internal/auth/invitations',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        authorization: 'Bearer account-token',
        cookie: '__Host-csrf=csrf; continuum_access=access',
        'x-csrf-token': 'csrf',
      },
    });
    expect(response.status).toHaveBeenCalledWith(200);
  });
});
