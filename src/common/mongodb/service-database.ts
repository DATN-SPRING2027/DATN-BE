import {
  SERVICE_DATABASES,
  type ServiceDatabaseName,
  type ServiceName,
} from './database-names';

export type ServiceDatabaseOwner = {
  serviceName: ServiceName;
  databaseName: ServiceDatabaseName;
};

export function getOwnedServiceDatabaseName(
  definition: ServiceDatabaseOwner,
): ServiceDatabaseName {
  const expectedName = SERVICE_DATABASES[definition.serviceName];
  if (!expectedName || expectedName !== definition.databaseName) {
    throw new Error(
      `Persistence definition for '${definition.serviceName}' does not match the canonical service database mapping`,
    );
  }

  return expectedName;
}

export function resolveServiceDatabaseName(
  definition: ServiceDatabaseOwner,
  configuredName?: string,
): ServiceDatabaseName {
  const expectedName = getOwnedServiceDatabaseName(definition);
  const normalizedName = configuredName?.trim();

  if (!normalizedName) {
    throw new Error(
      `SERVICE_DATABASE is required when INFRA_ENABLED=true for standalone '${definition.serviceName}'`,
    );
  }

  const allowedNames = Object.values(
    SERVICE_DATABASES,
  ) as ServiceDatabaseName[];
  if (!allowedNames.includes(normalizedName as ServiceDatabaseName)) {
    throw new Error(
      `SERVICE_DATABASE '${normalizedName}' is not an allowed active service database`,
    );
  }

  if (normalizedName !== expectedName) {
    throw new Error(
      `SERVICE_DATABASE '${normalizedName}' does not match the owning service database '${expectedName}'`,
    );
  }

  return expectedName;
}
