import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import mongoose from 'mongoose';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? describe : describe.skip;

integration('Database-per-service AppModule wiring', () => {
  let app: INestApplicationContext | undefined;
  const previousEnvironment = {
    INFRA_ENABLED: process.env.INFRA_ENABLED,
    JWT_SECRET: process.env.JWT_SECRET,
    IAM_GATEWAY_SECRET: process.env.IAM_GATEWAY_SECRET,
  };

  beforeAll(async () => {
    if (!process.env.MONGODB_URI)
      throw new Error('MONGODB_URI is required for runtime integration');
    process.env.INFRA_ENABLED = 'true';
    process.env.JWT_SECRET =
      'runtime-integration-secret-at-least-32-characters';
    process.env.IAM_GATEWAY_SECRET =
      'runtime-integration-gateway-secret-at-least-32-characters';

    const { AppModule } =
      jest.requireActual<typeof import('../src/app.module')>(
        '../src/app.module',
      );
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
  }, 30000);

  afterAll(async () => {
    await app?.close();
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('opens one connection per active service and one shared audit connection', () => {
    const databaseNames = mongoose.connections
      .filter(
        (connection) => connection.readyState === mongoose.STATES.connected,
      )
      .map((connection) => connection.db?.databaseName)
      .filter((name): name is string => name !== undefined)
      .sort();

    expect(databaseNames).toEqual(
      [
        'continuum_audit',
        'continuum_capture',
        'continuum_chat',
        'continuum_handover',
        'continuum_iam',
        'continuum_ingestion',
        'continuum_jira',
        'continuum_lifecycle',
        'continuum_notification',
      ].sort(),
    );
  });
});
