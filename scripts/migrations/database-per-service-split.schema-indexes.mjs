import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const services = [
  ['continuum_iam', 'iam', 'IAM_PERSISTENCE'],
  ['continuum_capture', 'capture', 'CAPTURE_PERSISTENCE'],
  ['continuum_jira', 'jira', 'JIRA_PERSISTENCE'],
  ['continuum_lifecycle', 'lifecycle', 'LIFECYCLE_PERSISTENCE'],
  ['continuum_chat', 'chat', 'CHAT_PERSISTENCE'],
  ['continuum_handover', 'handover', 'HANDOVER_PERSISTENCE'],
  ['continuum_ingestion', 'ingestion', 'INGESTION_PERSISTENCE'],
  ['continuum_notification', 'notification', 'NOTIFICATION_PERSISTENCE'],
];

function sourcePath(relativePath) {
  return fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
}

function defaultIndexName(key) {
  return Object.entries(key)
    .map(([field, direction]) => `${field}_${direction}`)
    .join('_');
}

function toIndexDefinition([key, options = {}]) {
  return {
    name: options.name ?? defaultIndexName(key),
    key,
    ...options,
  };
}

function loadServicePersistence(databaseName, serviceName, exportName) {
  const persistencePath = `src/services/${serviceName}/infrastructure/persistence.ts`;
  const schemasPath = `src/services/${serviceName}/infrastructure/mongodb/mongodb.schemas.ts`;
  const persistence = require(sourcePath(persistencePath))[exportName];
  const { createCollectionSchema } = require(sourcePath(schemasPath));

  if (!persistence || persistence.databaseName !== databaseName) {
    throw new Error(
      `Missing or mismatched persistence manifest for ${databaseName}`,
    );
  }

  return {
    persistence,
    schemasPath,
    createCollectionSchema,
    persistencePath,
  };
}

export const SERVICE_SCHEMA_INDEX_MANIFEST = (() => {
  const manifest = {};
  for (const [databaseName, serviceName, exportName] of services) {
    const { persistence, createCollectionSchema } = loadServicePersistence(
      databaseName,
      serviceName,
      exportName,
    );
    manifest[databaseName] = {};
    for (const definition of persistence.collections) {
      const schema = createCollectionSchema(definition);
      manifest[databaseName][definition.name] = schema
        .indexes()
        .map(toIndexDefinition)
        .sort((left, right) => left.name.localeCompare(right.name));
    }
  }

  const iamSchemasPath =
    'src/services/iam/infrastructure/mongodb/mongodb.schemas.ts';
  const { auditSchema } = require(sourcePath(iamSchemasPath));
  manifest.continuum_audit = {
    audit_logs: auditSchema
      .indexes()
      .map(toIndexDefinition)
      .sort((left, right) => left.name.localeCompare(right.name)),
    // IAM writes this raw collection without a Mongoose schema or declared
    // application indexes. MongoDB's built-in _id_ index is server-managed.
    audit_logs_iam: [],
  };

  return Object.freeze(manifest);
})();

const schemaSourceFiles = [
  ...services.flatMap(([, serviceName]) => [
    `src/services/${serviceName}/infrastructure/persistence.ts`,
    `src/services/${serviceName}/infrastructure/mongodb/mongodb.schemas.ts`,
  ]),
  'src/services/iam/infrastructure/mongodb/mongodb.schemas.ts',
];

export async function schemaAuthoritySha256() {
  const hash = createHash('sha256');
  for (const relativePath of [...new Set(schemaSourceFiles)].sort()) {
    hash.update(relativePath);
    hash.update('\u0000');
    hash.update(await readFile(sourcePath(relativePath)));
    hash.update('\u0000');
  }
  return hash.digest('hex');
}
