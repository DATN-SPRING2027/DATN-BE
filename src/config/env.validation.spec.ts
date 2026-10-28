import { validateEnvironment } from './env.validation';

describe('validateEnvironment', () => {
  it('parses valid environment values', () => {
    expect(
      validateEnvironment({
        NODE_ENV: 'test',
        PORT: '3001',
        SWAGGER_ENABLED: 'false',
        INFRA_ENABLED: 'true',
        SERVICE_DATABASE: 'continuum_iam',
      }),
    ).toMatchObject({
      NODE_ENV: 'test',
      PORT: 3001,
      SWAGGER_ENABLED: false,
      INFRA_ENABLED: true,
      SERVICE_DATABASE: 'continuum_iam',
      SAG_CHAT_STREAM_TIMEOUT_MS: 120000,
    });
  });

  it.each([
    [{ NODE_ENV: 'invalid' }, 'NODE_ENV'],
    [{ PORT: '0' }, 'PORT'],
    [{ PORT: 'not-a-number' }, 'PORT'],
    [{ SWAGGER_ENABLED: 'sometimes' }, 'SWAGGER_ENABLED'],
    [{ INFRA_ENABLED: 'sometimes' }, 'INFRA_ENABLED'],
    [{ JWT_SECRET: 'too-short' }, 'JWT_SECRET'],
    [{ PASSWORD_RESET_OUTBOX_KEY: 'too-short' }, 'PASSWORD_RESET_OUTBOX_KEY'],
    [{ IAM_GATEWAY_SECRET: 'too-short' }, 'IAM_GATEWAY_SECRET'],
    [{ SERVICE_DATABASE: 'continuum_db' }, 'SERVICE_DATABASE'],
    [{ SERVICE_DATABASE: 'continuum_task' }, 'SERVICE_DATABASE'],
    [{ SAG_CHAT_STREAM_TIMEOUT_MS: '1000' }, 'SAG_CHAT_STREAM_TIMEOUT_MS'],
    [{ SAG_CHAT_STREAM_TIMEOUT_MS: '600001' }, 'SAG_CHAT_STREAM_TIMEOUT_MS'],
    [
      { GATEWAY_TRUSTED_PROXY_CIDRS: 'anywhere' },
      'GATEWAY_TRUSTED_PROXY_CIDRS',
    ],
  ])('rejects invalid configuration %p', (environment, field) => {
    expect(() => validateEnvironment(environment)).toThrow(field);
  });

  it('keeps Swagger disabled when the toggle is omitted', () => {
    expect(
      validateEnvironment({
        NODE_ENV: 'production',
      }),
    ).toMatchObject({
      NODE_ENV: 'production',
      PORT: 3001,
      SWAGGER_ENABLED: false,
      INFRA_ENABLED: false,
    });
  });

  it('allows Google OAuth to remain disabled when all provider settings are blank', () => {
    expect(
      validateEnvironment({
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        GOOGLE_CALLBACK_URL: '',
      }),
    ).toMatchObject({
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      GOOGLE_CALLBACK_URL: '',
    });
  });

  it('requires all Google OAuth settings and a valid HTTP callback URL', () => {
    expect(() =>
      validateEnvironment({
        GOOGLE_CLIENT_ID: 'client-id',
        GOOGLE_CLIENT_SECRET: '',
        GOOGLE_CALLBACK_URL: 'http://localhost:5000/api/auth/google/callback',
      }),
    ).toThrow('Google OAuth requires');
    expect(() =>
      validateEnvironment({
        GOOGLE_CLIENT_ID: 'client-id',
        GOOGLE_CLIENT_SECRET: 'client-secret-placeholder',
        GOOGLE_CALLBACK_URL: 'javascript:alert(1)',
      }),
    ).toThrow('GOOGLE_CALLBACK_URL');
  });

  it('requires an HTTPS Google callback in production', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        GOOGLE_CLIENT_ID: 'client-id',
        GOOGLE_CLIENT_SECRET: 'client-secret-placeholder',
        GOOGLE_CALLBACK_URL: 'http://app.example.test/api/auth/google/callback',
      }),
    ).toThrow('must use HTTPS in production');
  });

  it('rejects SAG_API_BASE_URL containing embedded credentials or query strings', () => {
    expect(() =>
      validateEnvironment({
        SAG_API_BASE_URL: 'http://user:pass@127.0.0.1:8000',
        SAG_BFF_SERVICE_TOKEN: 's'.repeat(40),
      }),
    ).toThrow('SAG_API_BASE_URL must not contain credentials');
    expect(() =>
      validateEnvironment({
        SAG_API_BASE_URL: 'http://127.0.0.1:8000?debug=1',
        SAG_BFF_SERVICE_TOKEN: 's'.repeat(40),
      }),
    ).toThrow('SAG_API_BASE_URL must not contain credentials');
  });
});
