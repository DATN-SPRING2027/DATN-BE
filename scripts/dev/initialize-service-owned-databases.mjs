import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  parseDevelopmentMongoUri,
  requireDevelopmentEnvironment,
} from './development-target-policy.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const descriptors = [
  ['iam', 'IAM_PERSISTENCE'],
  ['capture', 'CAPTURE_PERSISTENCE'],
  ['jira', 'JIRA_PERSISTENCE'],
  ['lifecycle', 'LIFECYCLE_PERSISTENCE'],
  ['chat', 'CHAT_PERSISTENCE'],
  ['handover', 'HANDOVER_PERSISTENCE'],
  ['ingestion', 'INGESTION_PERSISTENCE'],
  ['notification', 'NOTIFICATION_PERSISTENCE'],
];

const { SERVICE_DATABASES, AUDIT_DATABASE_NAME } = require(
  path.join(repositoryRoot, 'src/common/mongodb/database-names.ts'),
);

const EXPECTED_SEED = Object.freeze({
  organization: {
    slug: 'datn-dev',
    name: 'DATN Development',
    plan: 'FREE',
  },
  users: [
    {
      key: 'admin',
      email: 'admin@datn-dev.example.test',
      fullName: 'Development Admin',
      orgRole: 'ADMIN',
    },
    {
      key: 'leader',
      email: 'leader@datn-dev.example.test',
      fullName: 'Development Project Leader',
      orgRole: 'MEMBER',
      projectRole: 'TEAM_LEADER',
    },
    {
      key: 'member',
      email: 'member@datn-dev.example.test',
      fullName: 'Development Project Member',
      orgRole: 'MEMBER',
      projectRole: 'MEMBER',
    },
  ],
  roles: [
    {
      code: 'ADMIN',
      name: 'Admin',
      permissions: ['project.visibility.manage', 'project.leader.manage'],
      isSystem: true,
    },
    {
      code: 'TEAM_LEADER',
      name: 'Team Leader',
      permissions: [
        'project.read',
        'project.members.list',
        'project.members.add',
        'project.members.remove',
      ],
      isSystem: true,
    },
    {
      code: 'MEMBER',
      name: 'Member',
      permissions: ['project.read'],
      isSystem: true,
    },
  ],
  project: {
    code: 'DEV_SAMPLE',
    name: 'Development Sample Project',
    description: 'Synthetic local development fixture.',
    visibility: 'PRIVATE',
    status: 'ACTIVE',
  },
});

const relevantIndexOptions = [
  'unique',
  'sparse',
  'expireAfterSeconds',
  'partialFilterExpression',
  'collation',
  'hidden',
];

function sourcePath(relativePath) {
  return path.join(repositoryRoot, relativePath);
}

function defaultIndexName(key) {
  return Object.entries(key)
    .map(([field, direction]) => `${field}_${direction}`)
    .join('_');
}

function normalizeSchemaIndexes(schema) {
  return schema.indexes().map(([key, sourceOptions = {}]) => {
    const options = Object.fromEntries(
      Object.entries(sourceOptions).filter(
        ([name, value]) => name !== 'background' && value !== undefined,
      ),
    );
    return {
      key: { ...key },
      name: options.name ?? defaultIndexName(key),
      options,
    };
  });
}

function serviceSchemaTarget(serviceName, persistenceExport) {
  const persistencePath = sourcePath(
    `src/services/${serviceName}/infrastructure/persistence.ts`,
  );
  const schemasPath = sourcePath(
    `src/services/${serviceName}/infrastructure/mongodb/mongodb.schemas.ts`,
  );
  const persistence = require(persistencePath)[persistenceExport];
  const schemas = require(schemasPath);
  const expectedDatabase = SERVICE_DATABASES[serviceName];

  if (!persistence || persistence.databaseName !== expectedDatabase) {
    throw new Error(
      `Persistence mapping is missing or inconsistent for service '${serviceName}'.`,
    );
  }

  const collections = persistence.collections.map((definition) => ({
    name: definition.name,
    indexes: normalizeSchemaIndexes(schemas.createCollectionSchema(definition)),
  }));
  collections.push({
    name: schemas.OUTBOX_COLLECTION,
    indexes: normalizeSchemaIndexes(schemas.outboxSchema),
  });

  return { databaseName: expectedDatabase, collections };
}

export function buildInitializationPlan() {
  const serviceTargets = descriptors.map(([serviceName, persistenceExport]) =>
    serviceSchemaTarget(serviceName, persistenceExport),
  );
  const iamSchemas = require(
    sourcePath('src/services/iam/infrastructure/mongodb/mongodb.schemas.ts'),
  );
  const auditTarget = {
    databaseName: AUDIT_DATABASE_NAME,
    collections: [
      {
        name: 'audit_logs',
        indexes: normalizeSchemaIndexes(iamSchemas.auditSchema),
      },
      { name: 'audit_logs_iam', indexes: [] },
    ],
  };
  const plan = [...serviceTargets, auditTarget];
  const targetNames = plan.map((target) => target.databaseName);
  const expectedNames = [
    ...Object.values(SERVICE_DATABASES),
    AUDIT_DATABASE_NAME,
  ].sort();

  if (
    new Set(targetNames).size !== targetNames.length ||
    !isDeepStrictEqual([...targetNames].sort(), expectedNames)
  ) {
    throw new Error(
      'Initialization target does not match the approved service database inventory.',
    );
  }

  for (const target of plan) {
    const collectionNames = target.collections.map(({ name }) => name);
    if (new Set(collectionNames).size !== collectionNames.length) {
      throw new Error(
        `Duplicate collection definition in ${target.databaseName}.`,
      );
    }
  }

  return plan;
}

export function validateDevelopmentSeedEnvironment(env) {
  requireDevelopmentEnvironment(env);
  if (env.INFRA_ENABLED !== 'true') {
    throw new Error(
      'INFRA_ENABLED must be true for service-owned database initialization.',
    );
  }
  if (env.DATN_DEV_DB_INITIALIZATION !== 'service-owned-development') {
    throw new Error(
      'Set DATN_DEV_DB_INITIALIZATION=service-owned-development to confirm a development target.',
    );
  }
  if (!env.MONGODB_URI) {
    throw new Error('MONGODB_URI must be supplied by the command environment.');
  }

  parseDevelopmentMongoUri(env.MONGODB_URI);

  return env.MONGODB_URI;
}

function keyEquals(left, right) {
  return isDeepStrictEqual(Object.entries(left), Object.entries(right));
}

function optionsCompatible(actual, expected) {
  return relevantIndexOptions.every((key) => {
    const actualValue = actual[key];
    const expectedValue = expected[key];
    if (actualValue === undefined && expectedValue === undefined) return true;
    return isDeepStrictEqual(actualValue, expectedValue);
  });
}

function duplicateKeyPipeline(index) {
  const keyValues = Object.fromEntries(
    Object.keys(index.key).map((field) => [
      field,
      { $ifNull: [`$${field}`, null] },
    ]),
  );
  return [
    { $group: { _id: keyValues, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 },
  ];
}

function databaseFor(connection, databaseName) {
  const database = connection.useDb(databaseName, { useCache: true }).db;
  if (!database)
    throw new Error(`Mongo connection did not resolve ${databaseName}.`);
  return database;
}

async function existingCollectionNames(database) {
  const rows = await database.listCollections({}, { nameOnly: true }).toArray();
  return new Set(rows.map((row) => row.name));
}

async function inspectCollectionIndexes(
  database,
  collectionDefinition,
  exists,
) {
  if (!exists) return collectionDefinition.indexes;

  const collection = database.collection(collectionDefinition.name);
  const actualIndexes = await collection.indexes();
  const missing = [];
  for (const expected of collectionDefinition.indexes) {
    const sameKey = actualIndexes.find((actual) =>
      keyEquals(actual.key, expected.key),
    );
    const sameName = actualIndexes.find(
      (actual) => actual.name === expected.name,
    );

    if (sameName && !keyEquals(sameName.key, expected.key)) {
      throw new Error(
        `Index name conflict at ${database.databaseName}.${collectionDefinition.name}.${expected.name}; no index was changed.`,
      );
    }
    if (sameKey) {
      if (!optionsCompatible(sameKey, expected.options)) {
        throw new Error(
          `Index options conflict at ${database.databaseName}.${collectionDefinition.name}.${expected.name}; no index was changed.`,
        );
      }
      continue;
    }

    if (expected.options.unique === true) {
      const duplicateGroups = await collection
        .aggregate(duplicateKeyPipeline(expected))
        .toArray();
      if (duplicateGroups.length > 0) {
        throw new Error(
          `Unique index precondition failed at ${database.databaseName}.${collectionDefinition.name}.${expected.name}; duplicate keys were found and no index was changed.`,
        );
      }
    }
    missing.push(expected);
  }

  return missing;
}

export async function initializeServiceOwnedDatabases(
  connection,
  plan = buildInitializationPlan(),
) {
  const pending = [];

  // Preflight every target before the first write to avoid partial setup when
  // an existing index has incompatible options or unique keys already collide.
  for (const target of plan) {
    const database = databaseFor(connection, target.databaseName);
    const existingNames = await existingCollectionNames(database);
    for (const collection of target.collections) {
      const exists = existingNames.has(collection.name);
      const missingIndexes = await inspectCollectionIndexes(
        database,
        collection,
        exists,
      );
      pending.push({ target, collection, exists, missingIndexes });
    }
  }

  let createdCollections = 0;
  let createdIndexes = 0;
  for (const item of pending) {
    const database = databaseFor(connection, item.target.databaseName);
    if (!item.exists) {
      try {
        await database.createCollection(item.collection.name);
        createdCollections += 1;
      } catch (error) {
        if (error?.code !== 48 && error?.codeName !== 'NamespaceExists')
          throw error;
      }
    }

    const collection = database.collection(item.collection.name);
    for (const index of item.missingIndexes) {
      const { name, ...options } = index.options;
      await collection.createIndex(index.key, options);
      createdIndexes += 1;
    }
  }

  for (const target of plan) {
    const database = databaseFor(connection, target.databaseName);
    const names = await existingCollectionNames(database);
    for (const collectionDefinition of target.collections) {
      if (!names.has(collectionDefinition.name)) {
        throw new Error(
          `Initialization verification failed for ${target.databaseName}.${collectionDefinition.name}.`,
        );
      }
      await inspectCollectionIndexes(database, collectionDefinition, true);
    }
  }

  return {
    databases: plan.length,
    collections: pending.length,
    createdCollections,
    createdIndexes,
  };
}

function deterministicObjectId(key) {
  const hex = createHash('sha256')
    .update(`datn-dev-seed-v1:${key}`)
    .digest('hex')
    .slice(0, 24);
  return new mongoose.Types.ObjectId(hex);
}

function sameStoredValue(actual, expected) {
  if (expected instanceof mongoose.Types.ObjectId) {
    return actual instanceof mongoose.Types.ObjectId && actual.equals(expected);
  }
  return isDeepStrictEqual(actual, expected);
}

async function ensureSeedDocument(
  database,
  collectionName,
  identity,
  document,
  expectedFields,
  options = {},
) {
  const collection = database.collection(collectionName);
  let existing = await collection.findOne(identity);
  let inserted = false;

  if (!existing) {
    const idCollision = await collection.findOne({ _id: document._id });
    if (idCollision) {
      throw new Error(
        `Seed ID collision at ${database.databaseName}.${collectionName}; existing data was preserved.`,
      );
    }
    const result = await collection.updateOne(
      { _id: document._id },
      { $setOnInsert: document },
      { upsert: true },
    );
    inserted = result.upsertedCount === 1;
    existing = await collection.findOne(identity);
  }

  if (!existing || !existing._id.equals(document._id)) {
    throw new Error(
      `Seed identity collision at ${database.databaseName}.${collectionName}; existing data was preserved.`,
    );
  }
  for (const [field, expected] of Object.entries(expectedFields)) {
    if (!sameStoredValue(existing[field], expected)) {
      throw new Error(
        `Existing development seed record conflicts at ${database.databaseName}.${collectionName}.${field}; no existing record was overwritten.`,
      );
    }
  }
  if (options.passwordHash) {
    let passwordMatches = false;
    try {
      passwordMatches = await bcrypt.compare(
        options.seedPassword,
        existing.passwordHash,
      );
    } catch {
      passwordMatches = false;
    }
    if (!passwordMatches) {
      throw new Error(
        `The development seed account already exists with a different credential; no credential was changed.`,
      );
    }
  }

  return inserted;
}

function timestamped(document, now) {
  return { ...document, createdAt: now, updatedAt: now };
}

export async function seedDevelopmentDataset(connection, seedPassword) {
  if (typeof seedPassword !== 'string' || seedPassword.length === 0) {
    throw new Error(
      'DATN_DEV_SEED_PASSWORD is required; no seed data was written.',
    );
  }
  if (bcrypt.truncates(seedPassword)) {
    throw new Error(
      'DATN_DEV_SEED_PASSWORD exceeds bcrypt input capacity; no seed data was written.',
    );
  }

  const database = databaseFor(connection, SERVICE_DATABASES.iam);
  const now = new Date();
  const passwordHash = await bcrypt.hash(seedPassword, 12);
  const created = {
    organizations: 0,
    users: 0,
    memberships: 0,
    roles: 0,
    roleAssignments: 0,
    projects: 0,
    projectMemberships: 0,
  };

  const organizationId = deterministicObjectId('organization/datn-dev');
  const organization = {
    _id: organizationId,
    ...timestamped(EXPECTED_SEED.organization, now),
  };
  created.organizations += Number(
    await ensureSeedDocument(
      database,
      'organizations',
      { slug: organization.slug },
      organization,
      {
        _id: organizationId,
        slug: organization.slug,
        name: organization.name,
        plan: organization.plan,
      },
    ),
  );

  const users = new Map();
  for (const seedUser of EXPECTED_SEED.users) {
    const userId = deterministicObjectId(`user/${seedUser.key}`);
    const user = {
      _id: userId,
      ...timestamped(
        {
          email: seedUser.email,
          passwordHash,
          fullName: seedUser.fullName,
          status: 'ACTIVE',
          twoFactorEnabled: false,
        },
        now,
      ),
    };
    created.users += Number(
      await ensureSeedDocument(
        database,
        'users',
        { email: seedUser.email },
        user,
        {
          _id: userId,
          email: seedUser.email,
          fullName: seedUser.fullName,
          status: 'ACTIVE',
          twoFactorEnabled: false,
        },
        { passwordHash, seedPassword },
      ),
    );
    users.set(seedUser.key, { ...seedUser, _id: userId });

    const membershipId = deterministicObjectId(
      `organization-membership/${seedUser.key}`,
    );
    created.memberships += Number(
      await ensureSeedDocument(
        database,
        'organization_memberships',
        { organizationId, userId },
        timestamped(
          { _id: membershipId, organizationId, userId, status: 'ACTIVE' },
          now,
        ),
        { _id: membershipId, organizationId, userId, status: 'ACTIVE' },
      ),
    );
  }

  const roles = new Map();
  for (const role of EXPECTED_SEED.roles) {
    const roleId = deterministicObjectId(`role/${role.code}`);
    created.roles += Number(
      await ensureSeedDocument(
        database,
        'roles',
        { code: role.code },
        { _id: roleId, ...role },
        { _id: roleId, ...role },
      ),
    );
    roles.set(role.code, { ...role, _id: roleId });
  }

  const ensureAssignment = async (userKey, roleCode, projectId = null) => {
    const user = users.get(userKey);
    const role = roles.get(roleCode);
    const assignmentId = deterministicObjectId(
      `role-assignment/${userKey}/${projectId ? projectId.toHexString() : 'organization'}`,
    );
    const identity = { organizationId, userId: user._id, projectId };
    const document = timestamped(
      {
        _id: assignmentId,
        organizationId,
        ...(projectId ? { projectId } : { projectId: null }),
        userId: user._id,
        roleId: role._id,
        roleCode,
        assignedBy: users.get('admin')._id,
      },
      now,
    );
    created.roleAssignments += Number(
      await ensureSeedDocument(
        database,
        'role_assignments',
        identity,
        document,
        {
          _id: assignmentId,
          organizationId,
          userId: user._id,
          projectId,
          roleId: role._id,
          roleCode,
          assignedBy: users.get('admin')._id,
        },
      ),
    );
  };

  await ensureAssignment('admin', 'ADMIN');
  await ensureAssignment('leader', 'MEMBER');
  await ensureAssignment('member', 'MEMBER');

  const projectId = deterministicObjectId('project/DEV_SAMPLE');
  const project = timestamped(
    {
      _id: projectId,
      organizationId,
      ...EXPECTED_SEED.project,
      createdBy: users.get('member')._id,
    },
    now,
  );
  created.projects += Number(
    await ensureSeedDocument(
      database,
      'projects',
      { organizationId, code: EXPECTED_SEED.project.code },
      project,
      {
        _id: projectId,
        organizationId,
        ...EXPECTED_SEED.project,
        createdBy: users.get('member')._id,
      },
    ),
  );

  for (const seedUser of EXPECTED_SEED.users.filter(
    (user) => user.projectRole,
  )) {
    const user = users.get(seedUser.key);
    const membershipId = deterministicObjectId(
      `project-membership/${seedUser.key}`,
    );
    created.projectMemberships += Number(
      await ensureSeedDocument(
        database,
        'project_memberships',
        { projectId, userId: user._id },
        {
          _id: membershipId,
          organizationId,
          projectId,
          userId: user._id,
          status: 'ACTIVE',
          joinedAt: now,
        },
        {
          _id: membershipId,
          organizationId,
          projectId,
          userId: user._id,
          status: 'ACTIVE',
        },
      ),
    );
    await ensureAssignment(seedUser.key, seedUser.projectRole, projectId);
  }

  return {
    created,
    organizationSlug: EXPECTED_SEED.organization.slug,
    projectCode: EXPECTED_SEED.project.code,
    syntheticAccountCount: EXPECTED_SEED.users.length,
  };
}

function countIndexes(plan) {
  return plan.reduce(
    (total, target) =>
      total +
      target.collections.reduce(
        (count, collection) => count + collection.indexes.length,
        0,
      ),
    0,
  );
}

async function run() {
  const schemaOnly = process.argv.slice(2).includes('--schema-only');
  if (process.argv.slice(2).some((argument) => argument !== '--schema-only')) {
    throw new Error('Only the optional --schema-only argument is supported.');
  }
  const uri = validateDevelopmentSeedEnvironment(process.env);
  const seedPassword = schemaOnly
    ? undefined
    : process.env.DATN_DEV_SEED_PASSWORD;
  if (!schemaOnly && (!seedPassword || bcrypt.truncates(seedPassword))) {
    throw new Error(
      'Set a non-empty DATN_DEV_SEED_PASSWORD that fits bcrypt input capacity; no database changes were made.',
    );
  }

  const plan = buildInitializationPlan();
  const targetNames = plan.map(({ databaseName }) => databaseName).join(', ');
  console.log(
    `Development target confirmed (${process.env.DATN_DB_ENV}). Service-owned database targets: ${targetNames}. Legacy continuum_db is excluded.`,
  );
  let connection;
  try {
    connection = await mongoose
      .createConnection(uri, {
        dbName: SERVICE_DATABASES.iam,
        autoCreate: false,
        autoIndex: false,
        serverSelectionTimeoutMS: 5000,
      })
      .asPromise();
  } catch {
    throw new Error(
      'Could not connect to the configured development MongoDB target. Check Atlas IP Access List/network policy and endpoint availability; connection details were not logged and no database writes were made.',
    );
  }

  try {
    const initialization = await initializeServiceOwnedDatabases(
      connection,
      plan,
    );
    const seed = schemaOnly
      ? null
      : await seedDevelopmentDataset(connection, seedPassword);
    const expectedIndexes = countIndexes(plan);
    console.log(
      `Initialized ${initialization.databases} service-owned databases, ${initialization.collections} collections, and ${expectedIndexes} schema indexes.`,
    );
    console.log(
      `Created ${initialization.createdCollections} collections and ${initialization.createdIndexes} indexes; existing indexes and documents were preserved.`,
    );
    if (seed) {
      console.log(
        `Development seed ready: ${seed.syntheticAccountCount} synthetic accounts in ${seed.organizationSlug}, sample Project ${seed.projectCode}. Passwords and connection details were not logged.`,
      );
      console.log(`New seed records: ${JSON.stringify(seed.created)}.`);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      /^(Index|Unique|Existing|Seed|Initialization|Persistence|Duplicate)/.test(
        error.message,
      )
    ) {
      throw error;
    }
    const safeCode = error?.codeName ?? error?.code ?? error?.name ?? 'unknown';
    throw new Error(
      `Initialization stopped (${String(safeCode)}); connection details and document contents were not logged.`,
    );
  } finally {
    await connection.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  run().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Initialization failed.',
    );
    process.exitCode = 1;
  });
}
