import type {
  ServiceDatabaseName,
  ServiceName,
} from '../../../../common/mongodb/database-names';

export type IndexFields = Record<string, 1 | -1>;

export interface CollectionIndex {
  fields: IndexFields;
  options?: {
    unique?: boolean;
    expireAfterSeconds?: number;
    name?: string;
  };
}

export interface ServiceCollectionDefinition {
  name: string;
  indexes?: CollectionIndex[];
}

export interface ServicePersistenceDefinition {
  serviceName: ServiceName;
  databaseName: ServiceDatabaseName;
  collections: ServiceCollectionDefinition[];
}
