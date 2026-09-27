import { validateEnvironment } from './env.validation';

describe('validateEnvironment', () => {
  it('parses valid environment values', () => {
    expect(
      validateEnvironment({
        NODE_ENV: 'test',
        PORT: '3001',
        SWAGGER_ENABLED: 'false',
        MONGODB_ENABLED: 'true',
      }),
    ).toMatchObject({
      NODE_ENV: 'test',
      PORT: 3001,
      SWAGGER_ENABLED: false,
      MONGODB_ENABLED: true,
    });
  });

  it.each([
    [{ NODE_ENV: 'invalid' }, 'NODE_ENV'],
    [{ PORT: '0' }, 'PORT'],
    [{ PORT: 'not-a-number' }, 'PORT'],
    [{ SWAGGER_ENABLED: 'sometimes' }, 'SWAGGER_ENABLED'],
    [{ MONGODB_ENABLED: 'sometimes' }, 'MONGODB_ENABLED'],
  ])('rejects invalid configuration %p', (environment, field) => {
    expect(() => validateEnvironment(environment)).toThrow(field);
  });

  it('keeps Swagger disabled when the toggle is omitted', () => {
    expect(validateEnvironment({ NODE_ENV: 'production' })).toMatchObject({
      NODE_ENV: 'production',
      PORT: 3001,
      SWAGGER_ENABLED: false,
      MONGODB_ENABLED: false,
      MONGODB_DATABASE: 'continuum_db',
    });
  });

  it('rejects a non-shared database when the shared Mongo runtime is enabled', () => {
    expect(() =>
      validateEnvironment({
        MONGODB_ENABLED: 'true',
        MONGODB_DATABASE: 'continuum_iam',
      }),
    ).toThrow('MONGODB_DATABASE must be continuum_db');
  });
});
