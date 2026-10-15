import type { INestApplication } from '@nestjs/common';
import { configureApplication } from './bootstrap';

describe('configureApplication Team transport headers', () => {
  it('allows command headers and exposes response validators to the browser', () => {
    let corsOptions = {
      allowedHeaders: [] as string[],
      exposedHeaders: [] as string[],
    };
    const expressApp = { disable: jest.fn(), set: jest.fn() };
    const app = {
      getHttpAdapter: () => ({ getInstance: () => expressApp }),
      setGlobalPrefix: jest.fn(),
      use: jest.fn(),
      enableCors: (options: {
        allowedHeaders: string[];
        exposedHeaders: string[];
      }) => {
        corsOptions = options;
      },
      useGlobalPipes: jest.fn(),
      useGlobalFilters: jest.fn(),
    };

    configureApplication(app as unknown as INestApplication);

    expect(corsOptions.allowedHeaders).toEqual(
      expect.arrayContaining([
        'X-CSRF-Token',
        'X-Organization-Id',
        'If-Match',
        'Idempotency-Key',
      ]),
    );
    expect(corsOptions.exposedHeaders).toEqual(
      expect.arrayContaining([
        'ETag',
        'Location',
        'Idempotency-Replayed',
        'Retry-After',
      ]),
    );
    expect(expressApp.disable).not.toHaveBeenCalledWith('etag');
  });
});
