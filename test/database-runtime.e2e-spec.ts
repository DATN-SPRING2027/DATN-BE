import type { INestApplicationContext } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { NestFactory } from '@nestjs/core';
import mongoose from 'mongoose';
import {
  AUDIT_CONNECTION_NAME,
  AUDIT_DATABASE_NAME,
  SERVICE_DATABASES,
} from '../src/common/mongodb/database-names';
import { IAM_PERSISTENCE } from '../src/services/iam/infrastructure/persistence';
import { AUTHENTICATION_REPOSITORY } from '../src/services/iam/application/authentication/authentication.repository';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? describe : describe.skip;

integration('Database-per-service AppModule wiring', () => {
  let app: INestApplicationContext | undefined;
  const previousEnvironment = {
    INFRA_ENABLED: process.env.INFRA_ENABLED,
    SERVICE_DATABASE: process.env.SERVICE_DATABASE,
    JWT_SECRET: process.env.JWT_SECRET,
    IAM_GATEWAY_SECRET: process.env.IAM_GATEWAY_SECRET,
  };

  beforeAll(async () => {
    if (!process.env.MONGODB_URI)
      throw new Error('MONGODB_URI is required for runtime integration');
    process.env.INFRA_ENABLED = 'true';
    process.env.SERVICE_DATABASE = SERVICE_DATABASES.iam;
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
    await mongoose.disconnect();
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('opens one connection per active service and one shared audit connection', () => {
    const connectionNames = [
      ...Object.values(SERVICE_DATABASES),
      AUDIT_CONNECTION_NAME,
    ];
    const connections = connectionNames.map(
      (name) =>
        app?.get(getConnectionToken(name), {
          strict: false,
        }) as mongoose.Connection,
    );
    const databaseNames = connections
      .map((connection) => connection.db?.databaseName)
      .filter((name): name is string => name !== undefined)
      .sort();

    expect(databaseNames).toEqual(
      [AUDIT_DATABASE_NAME, ...Object.values(SERVICE_DATABASES)].sort(),
    );
    expect(new Set(connections).size).toBe(connectionNames.length);
    expect(databaseNames).not.toContain('continuum_db');

    const usersModel = app?.get(
      getModelToken(
        `${IAM_PERSISTENCE.databaseName}_users`,
        IAM_PERSISTENCE.databaseName,
      ),
      { strict: false },
    ) as mongoose.Model<unknown>;
    expect(usersModel.db.db?.databaseName).toBe(SERVICE_DATABASES.iam);

    const authenticationRepository = app?.get<unknown>(
      AUTHENTICATION_REPOSITORY,
      {
        strict: false,
      },
    );
    const repositoryConnection = Reflect.get(
      authenticationRepository as object,
      'connection',
    ) as mongoose.Connection | undefined;
    expect(repositoryConnection?.db?.databaseName).toBe(SERVICE_DATABASES.iam);
  });
});
