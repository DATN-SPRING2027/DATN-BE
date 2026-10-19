import 'reflect-metadata';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  assertFixedDatabaseNames,
  parseTestAdoptionArguments,
  PLATFORM_AUTHORITY_ADOPTION_AUDIT_DATABASE,
  PLATFORM_AUTHORITY_ADOPTION_IAM_DATABASE,
  validateTestAdoptionEnvironment,
} from './platform-authority-test-adoption-policy.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

const fail = (code, message) => Object.assign(new Error(message), { code });

async function loadAdoptionUseCase() {
  const repositoryPath = path.resolve(
    repositoryRoot,
    'dist/services/iam/infrastructure/mongodb/platform-authority-legacy-adoption.repository.js',
  );
  const servicePath = path.resolve(
    repositoryRoot,
    'dist/services/iam/application/platform/platform-authority-legacy-adoption.service.js',
  );
  const persistencePath = path.resolve(
    repositoryRoot,
    'dist/services/iam/infrastructure/persistence.js',
  );
  const schemasPath = path.resolve(
    repositoryRoot,
    'dist/services/iam/infrastructure/mongodb/mongodb.schemas.js',
  );
  const [
    { MongoPlatformAuthorityLegacyAdoptionRepository },
    { PlatformAuthorityLegacyAdoptionService },
    { IAM_PERSISTENCE },
    { createCollectionSchema },
  ] = await Promise.all([
    import(pathToFileURL(repositoryPath).href),
    import(pathToFileURL(servicePath).href),
    import(pathToFileURL(persistencePath).href),
    import(pathToFileURL(schemasPath).href),
  ]);
  return {
    MongoPlatformAuthorityLegacyAdoptionRepository,
    PlatformAuthorityLegacyAdoptionService,
    IAM_PERSISTENCE,
    createCollectionSchema,
  };
}

async function verifyTransactionSupport(connection) {
  const hello = await connection.db.admin().command({ hello: 1 });
  if (
    !hello.setName ||
    !hello.isWritablePrimary ||
    !Number.isFinite(hello.logicalSessionTimeoutMinutes)
  ) {
    throw fail(
      'TRANSACTIONS_UNAVAILABLE',
      'The allowlisted Atlas endpoint did not report replica-set transaction capability.',
    );
  }

  const session = await connection.startSession();
  try {
    session.startTransaction({ readConcern: { level: 'snapshot' } });
    await connection.db.collection('users').findOne({}, { session });
    await connection
      .useDb(PLATFORM_AUTHORITY_ADOPTION_AUDIT_DATABASE)
      .collection('audit_logs_iam')
      .findOne({}, { session });
    await session.abortTransaction();
  } finally {
    await session.endSession();
  }
}

async function main() {
  if (process.execArgv.length > 0) {
    throw fail(
      'NODE_PRELOAD_PROHIBITED',
      'Node preload and runtime flags are prohibited for this command.',
    );
  }
  const args = parseTestAdoptionArguments(process.argv.slice(2));
  validateTestAdoptionEnvironment(process.env);
  assertFixedDatabaseNames(
    PLATFORM_AUTHORITY_ADOPTION_IAM_DATABASE,
    PLATFORM_AUTHORITY_ADOPTION_AUDIT_DATABASE,
  );

  const {
    MongoPlatformAuthorityLegacyAdoptionRepository,
    PlatformAuthorityLegacyAdoptionService,
    IAM_PERSISTENCE,
    createCollectionSchema,
  } = await loadAdoptionUseCase();
  const connection = await mongoose
    .createConnection(process.env.MONGODB_URI, {
      dbName: PLATFORM_AUTHORITY_ADOPTION_IAM_DATABASE,
      autoIndex: false,
      autoCreate: false,
      maxPoolSize: 2,
      serverSelectionTimeoutMS: 10_000,
    })
    .asPromise();

  try {
    if (
      connection.db?.databaseName !== PLATFORM_AUTHORITY_ADOPTION_IAM_DATABASE
    ) {
      throw fail(
        'UNAPPROVED_DATABASE',
        'Connected IAM database did not match the fixed development database.',
      );
    }
    for (const name of [
      'users',
      'platform_authority_assignments',
      'platform_authority_change_operations',
      'platform_authority_change_locks',
    ]) {
      const definition = IAM_PERSISTENCE.collections.find(
        (collection) => collection.name === name,
      );
      if (!definition) {
        throw fail(
          'IAM_SCHEMA_UNAVAILABLE',
          'The current IAM persistence schema is incomplete.',
        );
      }
      connection.model(
        `${IAM_PERSISTENCE.databaseName}_${name}`,
        createCollectionSchema(definition),
      );
    }
    await verifyTransactionSupport(connection);

    const repository = new MongoPlatformAuthorityLegacyAdoptionRepository(
      connection,
      PLATFORM_AUTHORITY_ADOPTION_AUDIT_DATABASE,
    );
    const service = new PlatformAuthorityLegacyAdoptionService(repository);
    const preflight = await service.inspect();
    const report = {
      mode: args.apply ? 'APPLY_TEST_ONLY' : 'READ_ONLY_PREFLIGHT',
      environment: process.env.NODE_ENV,
      host: 'kimthang.mh3rrz2.mongodb.net',
      databases: [
        PLATFORM_AUTHORITY_ADOPTION_IAM_DATABASE,
        PLATFORM_AUTHORITY_ADOPTION_AUDIT_DATABASE,
      ],
      targetEmail: args.targetEmail,
      targetStatus: preflight.targetStatus,
      actorStatus: preflight.actorStatus,
      issuerStatus: preflight.issuerStatus,
      legacyPlatformAssignmentCount: preflight.assignmentCount,
      ready: preflight.ready,
      blockers: preflight.blockers,
    };
    if (!args.apply) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    if (!preflight.ready || !preflight.expectedCurrentSnapshotHash) {
      throw fail(
        'ADOPTION_PREFLIGHT_FAILED',
        'The exact target and legacy V1 state are not eligible for adoption.',
      );
    }

    const result = await service.adopt({
      operationId: randomUUID(),
      actorUserId: preflight.actorUserId,
      issuerUserId: preflight.issuerUserId,
      expectedCurrentSnapshotHash: preflight.expectedCurrentSnapshotHash,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          ...report,
          operationId: result.operationId,
          status: result.status,
          scope: result.body.scope,
          authorityStatus: result.body.status,
          v2PermissionCount: result.body.assignments.length,
          replayed: result.replayed,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await connection.close();
  }
}

main().catch((error) => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'TEST_ONLY_ADOPTION_FAILED';
  process.stderr.write(`${code}: TEST_ONLY adoption command stopped.\n`);
  process.exitCode = 1;
});
