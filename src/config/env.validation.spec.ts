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
    });
  });

  it.each([
    [{ NODE_ENV: 'invalid' }, 'NODE_ENV'],
    [{ PORT: '0' }, 'PORT'],
    [{ PORT: 'not-a-number' }, 'PORT'],
    [{ SWAGGER_ENABLED: 'sometimes' }, 'SWAGGER_ENABLED'],
    [{ INFRA_ENABLED: 'sometimes' }, 'INFRA_ENABLED'],
    [{ JWT_SECRET: 'too-short' }, 'JWT_SECRET'],
    [{ IAM_GATEWAY_SECRET: 'too-short' }, 'IAM_GATEWAY_SECRET'],
    [{ SERVICE_DATABASE: 'continuum_db' }, 'SERVICE_DATABASE'],
    [{ SERVICE_DATABASE: 'continuum_task' }, 'SERVICE_DATABASE'],
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
});
