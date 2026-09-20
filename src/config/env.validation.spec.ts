import { validateEnvironment } from './env.validation';

describe('validateEnvironment', () => {
  it('parses valid environment values', () => {
    expect(
      validateEnvironment({
        NODE_ENV: 'test',
        PORT: '3001',
        SWAGGER_ENABLED: 'false',
      }),
    ).toMatchObject({
      NODE_ENV: 'test',
      PORT: 3001,
      SWAGGER_ENABLED: false,
    });
  });

  it.each([
    [{ NODE_ENV: 'invalid' }, 'NODE_ENV'],
    [{ PORT: '0' }, 'PORT'],
    [{ PORT: 'not-a-number' }, 'PORT'],
    [{ SWAGGER_ENABLED: 'sometimes' }, 'SWAGGER_ENABLED'],
  ])('rejects invalid configuration %p', (environment, field) => {
    expect(() => validateEnvironment(environment)).toThrow(field);
  });

  it('keeps Swagger disabled when the toggle is omitted', () => {
    expect(validateEnvironment({ NODE_ENV: 'production' })).toMatchObject({
      NODE_ENV: 'production',
      PORT: 3001,
      SWAGGER_ENABLED: false,
    });
  });
});
