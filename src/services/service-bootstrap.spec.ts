jest.mock('@nestjs/core', () => ({
  NestFactory: { create: jest.fn() },
}));

import { NestFactory } from '@nestjs/core';
import { IAM_PERSISTENCE } from './iam/infrastructure/persistence';
import {
  assertStandaloneServiceDatabase,
  bootstrapService,
} from './service-bootstrap';

describe('assertStandaloneServiceDatabase', () => {
  it('fails fast when standalone Mongo persistence has no SERVICE_DATABASE', () => {
    expect(() =>
      assertStandaloneServiceDatabase('true', IAM_PERSISTENCE, undefined),
    ).toThrow('SERVICE_DATABASE is required');
  });

  it('rejects before Nest application creation when standalone config is missing', async () => {
    const originalInfraEnabled = process.env.INFRA_ENABLED;
    const originalServiceDatabase = process.env.SERVICE_DATABASE;
    process.env.INFRA_ENABLED = 'true';
    delete process.env.SERVICE_DATABASE;

    try {
      await expect(
        bootstrapService(class TestServiceModule {}, IAM_PERSISTENCE),
      ).rejects.toThrow('SERVICE_DATABASE is required');
      expect(jest.mocked(NestFactory).create.mock.calls).toHaveLength(0);
    } finally {
      if (originalInfraEnabled === undefined) delete process.env.INFRA_ENABLED;
      else process.env.INFRA_ENABLED = originalInfraEnabled;
      if (originalServiceDatabase === undefined)
        delete process.env.SERVICE_DATABASE;
      else process.env.SERVICE_DATABASE = originalServiceDatabase;
    }
  });

  it('rejects a standalone database that is not owned by the service', () => {
    expect(() =>
      assertStandaloneServiceDatabase(
        'true',
        IAM_PERSISTENCE,
        'continuum_capture',
      ),
    ).toThrow('does not match the owning service database');
  });

  it('accepts the service-owned database', () => {
    expect(() =>
      assertStandaloneServiceDatabase('true', IAM_PERSISTENCE, 'continuum_iam'),
    ).not.toThrow();
  });

  it('keeps infrastructure-disabled local mode valid without a database name', () => {
    expect(() =>
      assertStandaloneServiceDatabase('false', IAM_PERSISTENCE, undefined),
    ).not.toThrow();
  });
});
