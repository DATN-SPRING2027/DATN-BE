export function resolveServiceDatabaseName(
  definition: { databaseName: string },
  configuredName?: string,
): string {
  if (configuredName && configuredName !== definition.databaseName) {
    throw new Error(
      `SERVICE_DATABASE '${configuredName}' does not match the owning service database '${definition.databaseName}'`,
    );
  }
  return definition.databaseName;
}
