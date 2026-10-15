import { ServiceUnavailableException } from '@nestjs/common';
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

describe('GatewayIamController Team API forwarding', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps Team gateway errors no-store when the IAM service is unavailable', async () => {
    const config = {
      getOrThrow: (key: string) =>
        key === 'IAM_GATEWAY_SECRET'
          ? 'gateway-secret-with-at-least-thirty-two-characters'
          : key === 'IAM_SERVICE_URL'
            ? 'http://127.0.0.1:3001'
            : 5000,
    };
    const controller = new GatewayIamController(config as never);
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const response = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };

    await expect(
      controller.listTeams(
        {
          method: 'GET',
          path: '/api/v1/iam/projects/cccccccccccccccccccccccc/teams',
          originalUrl: '/api/v1/iam/projects/cccccccccccccccccccccccc/teams',
          headers: {},
        } as unknown as Request,
        response as unknown as Response,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(response.setHeader).toHaveBeenCalledWith(
      'cache-control',
      'no-store',
    );
  });

  it.each([
    [
      'createTeam',
      'POST',
      '/api/v1/iam/projects/651a2b3c4d5e6f7a8b9c0d1f/teams',
      '/internal/iam/projects/651a2b3c4d5e6f7a8b9c0d1f/teams',
    ],
    [
      'updateTeam',
      'PATCH',
      '/api/v1/iam/teams/651a2b3c4d5e6f7a8b9c0d1f',
      '/internal/iam/teams/651a2b3c4d5e6f7a8b9c0d1f',
    ],
    [
      'listTeams',
      'GET',
      '/api/v1/iam/projects/651a2b3c4d5e6f7a8b9c0d1f/teams?page=2&pageSize=20&status=ARCHIVED',
      '/internal/iam/projects/651a2b3c4d5e6f7a8b9c0d1f/teams?page=2&pageSize=20&status=ARCHIVED',
    ],
    [
      'getTeam',
      'GET',
      '/api/v1/iam/teams/651a2b3c4d5e6f7a8b9c0d1f',
      '/internal/iam/teams/651a2b3c4d5e6f7a8b9c0d1f',
    ],
    [
      'archiveTeam',
      'POST',
      '/api/v1/iam/teams/651a2b3c4d5e6f7a8b9c0d1f/archive',
      '/internal/iam/teams/651a2b3c4d5e6f7a8b9c0d1f/archive',
    ],
    [
      'restoreTeam',
      'POST',
      '/api/v1/iam/teams/651a2b3c4d5e6f7a8b9c0d1f/restore',
      '/internal/iam/teams/651a2b3c4d5e6f7a8b9c0d1f/restore',
    ],
  ])(
    'forwards %s with Team concurrency headers and response validators',
    async (methodName, method, originalUrl, upstreamUrl) => {
      const config = {
        getOrThrow: (key: string) =>
          key === 'IAM_GATEWAY_SECRET'
            ? 'gateway-secret-with-at-least-thirty-two-characters'
            : key === 'IAM_SERVICE_URL'
              ? 'http://127.0.0.1:3001'
              : 5000,
      };
      const controller = new GatewayIamController(config as never);
      const responseHeaders = new Headers({
        'cache-control':
          methodName === 'listTeams' ? 'public, max-age=60' : 'no-store',
      });
      if (methodName !== 'listTeams')
        responseHeaders.set('etag', '"team:651a2b3c4d5e6f7a8b9c0d1f:3"');
      if (methodName === 'createTeam')
        responseHeaders.set(
          'location',
          '/api/v1/iam/teams/651a2b3c4d5e6f7a8b9c0d1f',
        );
      if (
        methodName === 'updateTeam' ||
        methodName === 'archiveTeam' ||
        methodName === 'restoreTeam'
      )
        responseHeaders.set('idempotency-replayed', 'true');
      const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new globalThis.Response('{"ok":true}', {
          status: method === 'POST' && methodName === 'createTeam' ? 201 : 200,
          headers: responseHeaders,
        }),
      );
      const response = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(),
      };
      const body = method === 'GET' ? undefined : { name: 'Platform Team' };
      const requestHeaders: Record<string, string> = {
        authorization: 'Bearer access-token',
        cookie: '__Host-csrf=csrf; continuum_access=access',
        'x-csrf-token': 'csrf',
        'x-organization-id': '651a2b3c4d5e6f7a8b9c0d1e',
      };
      if (
        methodName === 'createTeam' ||
        methodName === 'updateTeam' ||
        methodName === 'archiveTeam' ||
        methodName === 'restoreTeam'
      )
        requestHeaders['idempotency-key'] = 'team-command-1';
      if (
        methodName === 'updateTeam' ||
        methodName === 'archiveTeam' ||
        methodName === 'restoreTeam'
      )
        requestHeaders['if-match'] = '"team:651a2b3c4d5e6f7a8b9c0d1f:2"';
      const request = {
        method,
        path: originalUrl.split('?')[0],
        originalUrl,
        body,
        headers: requestHeaders,
      } as unknown as Request;

      const operation = (
        controller as unknown as Record<
          string,
          (request: Request, response: Response) => Promise<void>
        >
      )[methodName];
      await operation.call(
        controller,
        request,
        response as unknown as Response,
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const fetchCall = fetchMock.mock.calls[0];
      expect(fetchCall?.[0]).toBe(`http://127.0.0.1:3001${upstreamUrl}`);
      const fetchOptions = fetchCall?.[1];
      expect(fetchOptions?.method).toBe(method);
      expect(fetchOptions?.headers).toEqual({
        authorization: 'Bearer access-token',
        cookie: '__Host-csrf=csrf; continuum_access=access',
        'x-csrf-token': 'csrf',
        'x-organization-id': '651a2b3c4d5e6f7a8b9c0d1e',
        ...(requestHeaders['if-match']
          ? { 'if-match': requestHeaders['if-match'] }
          : {}),
        ...(requestHeaders['idempotency-key']
          ? { 'idempotency-key': requestHeaders['idempotency-key'] }
          : {}),
      });
      expect(response.setHeader).toHaveBeenCalledWith(
        'cache-control',
        'no-store',
      );
      expect(
        response.setHeader.mock.calls
          .filter(([name]) => name === 'cache-control')
          .at(-1),
      ).toEqual(['cache-control', 'no-store']);
      if (methodName !== 'listTeams')
        expect(response.setHeader).toHaveBeenCalledWith(
          'etag',
          '"team:651a2b3c4d5e6f7a8b9c0d1f:3"',
        );
      if (methodName === 'createTeam')
        expect(response.setHeader).toHaveBeenCalledWith(
          'location',
          '/api/v1/iam/teams/651a2b3c4d5e6f7a8b9c0d1f',
        );
      if (
        methodName === 'updateTeam' ||
        methodName === 'archiveTeam' ||
        methodName === 'restoreTeam'
      )
        expect(response.setHeader).toHaveBeenCalledWith(
          'idempotency-replayed',
          'true',
        );
      if (methodName === 'archiveTeam' || methodName === 'restoreTeam')
        expect(fetchOptions?.headers).toMatchObject({ 'x-csrf-token': 'csrf' });
    },
  );
});
