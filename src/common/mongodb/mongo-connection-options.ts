import type { MongooseModuleFactoryOptions } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

export interface SharedMongoConfiguration {
  uri: string;
  databaseName: string;
  autoIndex: boolean;
}

export function buildSharedMongoConnectionOptions(
  configuration: SharedMongoConfiguration,
): MongooseModuleFactoryOptions {
  return {
    uri: configuration.uri,
    dbName: configuration.databaseName,
    autoIndex: configuration.autoIndex,
    maxPoolSize: 50,
    minPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    lazyConnection: true,
    connectionFactory: (connection: Connection) => {
      // Keep the HTTP process alive while readiness reports a database outage.
      void connection.asPromise().catch(() => undefined);
      return connection;
    },
  };
}
