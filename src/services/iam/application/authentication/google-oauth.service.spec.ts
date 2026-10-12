import {
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { GoogleOAuthService } from './google-oauth.service';

const mockOAuthClient = {
  generateCodeVerifierAsync: jest.fn(),
  generateAuthUrl: jest.fn(),
  getToken: jest.fn(),
  verifyIdToken: jest.fn(),
};

jest.mock('google-auth-library', () => ({
  CodeChallengeMethod: { S256: 'S256' },
  OAuth2Client: jest.fn(() => mockOAuthClient),
}));

describe('GoogleOAuthService', () => {
  const configValues: Record<string, string> = {
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_CALLBACK_URL: 'http://localhost:3000/api/auth/google/callback',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters',
    NODE_ENV: 'test',
  };
  let service: GoogleOAuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockOAuthClient.generateCodeVerifierAsync.mockResolvedValue({
      codeVerifier: 'test-code-verifier-with-more-than-forty-three-characters',
      codeChallenge: 'test-code-challenge',
    });
    mockOAuthClient.generateAuthUrl.mockImplementation(
      (options: Record<string, string | string[]>) => {
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        Object.entries(options).forEach(([key, value]) => {
          url.searchParams.set(
            key,
            Array.isArray(value) ? value.join(' ') : value,
          );
        });
        return url.toString();
      },
    );
    mockOAuthClient.getToken.mockResolvedValue({
      tokens: { id_token: 'signed-google-id-token' },
    });
    const config = {
      get: jest.fn((key: string) => configValues[key]),
    } as unknown as ConfigService;
    service = new GoogleOAuthService(config);
  });

  it('starts a stateful PKCE flow with only OpenID profile scopes', async () => {
    const result = await service.begin();
    const authUrl = new URL(result.authorizationUrl);

    expect(authUrl.searchParams.get('scope')?.split(' ')).toEqual([
      'openid',
      'email',
      'profile',
    ]);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('code_challenge')).toBe(
      'test-code-challenge',
    );
    expect(authUrl.searchParams.get('state')).toBeTruthy();
    expect(authUrl.searchParams.get('nonce')).toBeTruthy();
    expect(result.stateCookie).toMatch(/^v1\./);
    expect(mockOAuthClient.generateCodeVerifierAsync).toHaveBeenCalledTimes(1);
    expect(OAuth2Client).toHaveBeenCalledWith(
      configValues.GOOGLE_CLIENT_ID,
      configValues.GOOGLE_CLIENT_SECRET,
      configValues.GOOGLE_CALLBACK_URL,
    );
  });

  it('exchanges the code with the matching transaction and returns a verified Google subject', async () => {
    const requestId = 'b127a512-4b27-4a62-96a3-587ae4d2e4b0';
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const started = await service.begin('651a2b3c4d5e6f7a8b9c0d1f');
    const authUrl = new URL(started.authorizationUrl);
    const nonce = authUrl.searchParams.get('nonce');
    mockOAuthClient.verifyIdToken.mockResolvedValue({
      getPayload: () => ({
        iss: 'https://accounts.google.com',
        aud: configValues.GOOGLE_CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 60,
        sub: 'google-subject-123',
        email: 'Person@Example.com',
        email_verified: true,
        name: 'Google Person',
        nonce,
      }),
    });

    await expect(
      service.verifyCallback(
        {
          code: 'one-time-code',
          state: authUrl.searchParams.get('state')!,
          stateCookie: started.stateCookie,
        },
        requestId,
      ),
    ).resolves.toMatchObject({
      subject: 'google-subject-123',
      email: 'person@example.com',
      emailVerified: true,
      name: 'Google Person',
      organizationId: '651a2b3c4d5e6f7a8b9c0d1f',
    });
    expect(mockOAuthClient.getToken).toHaveBeenCalledWith({
      code: 'one-time-code',
      codeVerifier: 'test-code-verifier-with-more-than-forty-three-characters',
    });
    expect(mockOAuthClient.verifyIdToken).toHaveBeenCalledWith({
      idToken: 'signed-google-id-token',
      audience: configValues.GOOGLE_CLIENT_ID,
    });
    const logLines = log.mock.calls.map(([line]) => String(line));
    const events = logLines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId,
          stage: 'state_validation',
          status: 'succeeded',
        }),
        expect.objectContaining({
          requestId,
          stage: 'token_exchange',
          status: 'succeeded',
        }),
        expect.objectContaining({
          requestId,
          stage: 'id_token_verification',
          status: 'succeeded',
        }),
        expect.objectContaining({
          requestId,
          stage: 'email_verification',
          status: 'succeeded',
        }),
      ]),
    );
    expect(logLines.join('\n')).not.toContain('one-time-code');
    expect(logLines.join('\n')).not.toContain('signed-google-id-token');
    expect(logLines.join('\n')).not.toContain('person@example.com');
    log.mockRestore();
  });

  it('rejects callback state that was not issued in the browser transaction', async () => {
    const requestId = 'b127a512-4b27-4a62-96a3-587ae4d2e4b0';
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const started = await service.begin();
    const authUrl = new URL(started.authorizationUrl);

    await expect(
      service.verifyCallback(
        {
          code: 'one-time-code',
          state: 'attacker-state',
          stateCookie: started.stateCookie,
        },
        requestId,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(mockOAuthClient.getToken).not.toHaveBeenCalled();
    expect(authUrl.searchParams.get('state')).not.toBe('attacker-state');
    expect(
      warning.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .find((entry) => entry.stage === 'state_validation'),
    ).toMatchObject({
      requestId,
      stage: 'state_validation',
      status: 'failed',
      errorCode: 'OAUTH_STATE_INVALID',
    });
    warning.mockRestore();
  });

  it('rejects an unverified Google email', async () => {
    const started = await service.begin();
    const authUrl = new URL(started.authorizationUrl);
    mockOAuthClient.verifyIdToken.mockResolvedValue({
      getPayload: () => ({
        iss: 'https://accounts.google.com',
        aud: configValues.GOOGLE_CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 60,
        sub: 'google-subject-123',
        email: 'person@example.com',
        email_verified: false,
        nonce: authUrl.searchParams.get('nonce'),
      }),
    });

    await expect(
      service.verifyCallback({
        code: 'one-time-code',
        state: authUrl.searchParams.get('state')!,
        stateCookie: started.stateCookie,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fails closed when any Google setting is missing', async () => {
    const config = {
      get: jest.fn((key: string) =>
        key === 'GOOGLE_CLIENT_SECRET' ? undefined : configValues[key],
      ),
    } as unknown as ConfigService;
    const unconfigured = new GoogleOAuthService(config);

    await expect(unconfigured.begin()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('rejects a malformed optional organization selector before redirecting to Google', async () => {
    await expect(service.begin('not-an-object-id')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(mockOAuthClient.generateAuthUrl).not.toHaveBeenCalled();
  });
});
