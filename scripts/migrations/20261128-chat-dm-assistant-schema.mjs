import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import {
  CHAT_DM_ASSISTANT_COLLECTIONS,
  CHAT_DM_ASSISTANT_INDEX_SPECS,
  DATABASE,
  indexOptionsMatch,
  keyMatches,
  planChatDmAssistantRollback,
  planChatDmAssistantSchema,
  validateTarget,
} from './20261128-chat-dm-assistant-schema.plan.mjs';

const ALLOWED_FLAGS = new Set([
  '--apply',
  '--rollback',
  '--rollback-plan',
  '--allow-shared-database',
  '--drop-empty-jobs-collection',
]);

export function parseMigrationArgs(args = [], env = {}) {
  if (new Set(args).size !== args.length) {
    throw new Error('Duplicate migration arguments are not allowed');
  }

  let expectedReportSha256;
  for (const arg of args) {
    if (arg.startsWith('--expected-report-sha256=')) {
      if (expectedReportSha256 !== undefined) {
        throw new Error('Only one --expected-report-sha256 value is allowed');
      }
      const value = arg.slice('--expected-report-sha256='.length);
      if (!/^[a-f0-9]{64}$/.test(value)) {
        throw new Error(
          '--expected-report-sha256 must be a 64-character lowercase hex SHA-256 digest',
        );
      }
      expectedReportSha256 = value;
      continue;
    }
    if (!ALLOWED_FLAGS.has(arg)) {
      throw new Error(`Unknown migration argument: ${arg}`);
    }
  }

  const apply = args.includes('--apply');
  const rollback = args.includes('--rollback');
  const rollbackPlan = args.includes('--rollback-plan');
  const allowShared = args.includes('--allow-shared-database');
  const dropEmptyJobsCollection = args.includes('--drop-empty-jobs-collection');

  const modeCount = Number(apply) + Number(rollback) + Number(rollbackPlan);
  if (modeCount > 1) {
    throw new Error(
      'Choose at most one of --apply, --rollback, or --rollback-plan',
    );
  }

  if (dropEmptyJobsCollection && !rollback && !rollbackPlan) {
    throw new Error(
      '--drop-empty-jobs-collection is only valid with --rollback or --rollback-plan',
    );
  }

  const mode = apply
    ? 'apply'
    : rollback
      ? 'rollback'
      : rollbackPlan
        ? 'rollback-plan'
        : 'dry-run';

  if ((mode === 'apply' || mode === 'rollback') && !expectedReportSha256) {
    throw new Error(
      `${mode === 'apply' ? '--apply' : '--rollback'} requires --expected-report-sha256=<dry-run-sha256>`,
    );
  }

  const uri = env.CHAT_MONGODB_URI ?? env.MONGODB_URI;
  const target = validateTarget(uri);

  if ((mode === 'apply' || mode === 'rollback') && !target.loopback) {
    if (
      !allowShared ||
      env.CHAT_MIGRATION_CONFIRM_DATABASE !== DATABASE
    ) {
      throw new Error(
        `Mutating a non-loopback target requires --allow-shared-database and CHAT_MIGRATION_CONFIRM_DATABASE=${DATABASE}`,
      );
    }
  }

  return {
    mode,
    uri,
    target,
    allowShared,
    dropEmptyJobsCollection,
    expectedReportSha256,
  };
}

async function collectInventory(db) {
  if (db.databaseName !== DATABASE) {
    throw new Error(`Expected database ${DATABASE}, got ${db.databaseName}`);
  }

  const inventory = {};

  for (const spec of CHAT_DM_ASSISTANT_COLLECTIONS) {
    const info = await db.listCollections({ name: spec.name }).next();
    if (!info) {
      inventory[spec.name] = {
        exists: false,
        objectType: null,
        documentCount: 0,
        invalidDocumentCount: 0,
        indexes: [],
        duplicateKeysByIndex: {},
        validator: {},
        validationLevel: undefined,
        validationAction: undefined,
        ...(spec.name === 'chat_conversation_messages'
          ? { legacyMessageCount: 0, assistantMessageCount: 0 }
          : { activeJobCount: 0 }),
      };
      continue;
    }

    if (info.type !== 'collection') {
      inventory[spec.name] = {
        exists: true,
        objectType: info.type,
        documentCount: 0,
        invalidDocumentCount: 0,
        indexes: [],
        duplicateKeysByIndex: {},
        validator: info.options?.validator ?? {},
        validationLevel: info.options?.validationLevel,
        validationAction: info.options?.validationAction,
      };
      continue;
    }

    const collection = db.collection(spec.name);
    const [documentCount, invalidDocumentCount, indexes, extraCounts] =
      await Promise.all([
        collection.countDocuments(),
        collection.countDocuments({ $nor: [spec.validator] }),
        collection.listIndexes().toArray(),
        spec.name === 'chat_conversation_messages'
          ? Promise.all([
              collection.countDocuments({ authorType: { $exists: false } }),
              collection.countDocuments({ authorType: 'ASSISTANT' }),
            ]).then(([legacyMessageCount, assistantMessageCount]) => ({
              legacyMessageCount,
              assistantMessageCount,
            }))
          : collection
              .countDocuments({ status: { $in: ['PENDING', 'PROCESSING'] } })
              .then((activeJobCount) => ({ activeJobCount })),
      ]);

    const duplicateKeysByIndex = {};
    for (const indexSpec of CHAT_DM_ASSISTANT_INDEX_SPECS.filter(
      (entry) => entry.collection === spec.name && entry.unique,
    )) {
      const alreadyExists = indexes.some(
        (existing) =>
          existing.name === indexSpec.name &&
          keyMatches(existing.key, indexSpec.key) &&
          indexOptionsMatch(existing, indexSpec),
      );
      if (alreadyExists) continue;

      const groupId = Object.fromEntries(
        Object.keys(indexSpec.key).map((field) => [
          field.replaceAll('.', '__'),
          `$${field}`,
        ]),
      );
      const pipeline = [
        ...(indexSpec.partialFilterExpression
          ? [{ $match: indexSpec.partialFilterExpression }]
          : []),
        { $group: { _id: groupId, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $limit: 5 },
      ];
      const duplicates = await collection.aggregate(pipeline).toArray();
      if (duplicates.length > 0) {
        // Never emit message content or sensitive IDs in migration reports.
        duplicateKeysByIndex[indexSpec.name] = duplicates.map((row) => ({
          count: row.count,
        }));
      }
    }

    inventory[spec.name] = {
      exists: true,
      objectType: 'collection',
      documentCount,
      invalidDocumentCount,
      indexes,
      duplicateKeysByIndex,
      validator: info.options?.validator ?? {},
      validationLevel: info.options?.validationLevel,
      validationAction: info.options?.validationAction,
      ...extraCounts,
    };
  }

  return inventory;
}

/** Read-only preflight inspection. Never writes to MongoDB or logs message contents. */
export async function inspectChatDmAssistantSchema(
  db,
  targetFingerprint = 'isolated-test',
) {
  const inventory = await collectInventory(db);
  return planChatDmAssistantSchema({
    databaseName: db.databaseName,
    targetFingerprint,
    inventory,
  });
}

/** Read-only rollback preflight inspection. Never writes to MongoDB. */
export async function inspectChatDmAssistantRollback(
  db,
  {
    targetFingerprint = 'isolated-test',
    dropEmptyJobsCollection = false,
  } = {},
) {
  const inventory = await collectInventory(db);
  return planChatDmAssistantRollback({
    databaseName: db.databaseName,
    targetFingerprint,
    inventory,
    dropEmptyJobsCollection,
  });
}

/** Additive, idempotent migration. Dry-run by default; --apply requires exact reviewed report hash. */
export async function migrateChatDmAssistantSchema(
  db,
  {
    apply = false,
    expectedReportSha256,
    targetFingerprint = 'isolated-test',
  } = {},
) {
  const plan = await inspectChatDmAssistantSchema(db, targetFingerprint);
  if (!apply) {
    return { ...plan, applied: false };
  }
  if (!expectedReportSha256 || expectedReportSha256 !== plan.reportSha256) {
    throw new Error(
      'Apply refused: current dry-run hash differs from --expected-report-sha256',
    );
  }
  if (!plan.clean) {
    throw new Error(
      'Apply blocked by preflight findings; no schema or index writes performed',
    );
  }

  const beforeMessageCount =
    plan.collections.find((c) => c.name === 'chat_conversation_messages')
      ?.documentCount ?? 0;

  for (const planned of plan.collections) {
    const spec = CHAT_DM_ASSISTANT_COLLECTIONS.find(
      (entry) => entry.name === planned.name,
    );
    if (!spec) continue;
    if (planned.action === 'CREATE') {
      await db.createCollection(spec.name, {
        validator: spec.validator,
        validationLevel: spec.validationLevel,
        validationAction: spec.validationAction,
      });
    } else if (planned.action === 'VALIDATE') {
      await db.command({
        collMod: spec.name,
        validator: spec.validator,
        validationLevel: spec.validationLevel,
        validationAction: spec.validationAction,
      });
    }
  }

  for (const plannedIndex of plan.indexes) {
    if (plannedIndex.action !== 'CREATE') continue;
    const { collection, name, key, unique, partialFilterExpression } =
      plannedIndex;
    await db.collection(collection).createIndex(key, {
      name,
      ...(unique ? { unique: true } : {}),
      ...(partialFilterExpression ? { partialFilterExpression } : {}),
    });
  }

  const verified = await inspectChatDmAssistantSchema(db, targetFingerprint);
  const afterMessageCount =
    verified.collections.find((c) => c.name === 'chat_conversation_messages')
      ?.documentCount ?? 0;

  if (
    !verified.clean ||
    verified.summary.collectionsCreate > 0 ||
    verified.summary.collectionsValidate > 0 ||
    verified.summary.indexesCreate > 0 ||
    afterMessageCount < beforeMessageCount
  ) {
    throw new Error(
      'Post-apply verification failed; preserve data and inspect a fresh dry-run report',
    );
  }

  return { ...verified, applied: true };
}

/** Safe, scoped rollback. Never drops legacy human chat collections, documents, or existing indexes. */
export async function rollbackChatDmAssistantSchema(
  db,
  {
    execute = false,
    dropEmptyJobsCollection = false,
    expectedReportSha256,
    targetFingerprint = 'isolated-test',
  } = {},
) {
  const plan = await inspectChatDmAssistantRollback(db, {
    targetFingerprint,
    dropEmptyJobsCollection,
  });
  if (!execute) {
    return { ...plan, rolledBack: false };
  }
  if (!expectedReportSha256 || expectedReportSha256 !== plan.reportSha256) {
    throw new Error(
      'Rollback refused: current rollback-plan hash differs from --expected-report-sha256',
    );
  }
  if (!plan.clean) {
    throw new Error(
      'Rollback blocked by preflight findings; no schema or index changes performed',
    );
  }

  const beforeMessageCount =
    plan.collections.find((c) => c.name === 'chat_conversation_messages')
      ?.documentCount ?? 0;

  for (const item of plan.dropIndexes) {
    if (item.action !== 'DROP') continue;
    await db.collection(item.collection).dropIndex(item.name);
  }

  for (const item of plan.collections) {
    if (item.action === 'CLEAR_VALIDATOR') {
      await db.command({
        collMod: item.name,
        validator: {},
      });
    } else if (item.action === 'DROP_COLLECTION') {
      if (item.name !== 'chat_assistant_jobs') {
        throw new Error(
          `Refusing to drop protected collection during rollback: ${item.name}`,
        );
      }
      await db.dropCollection(item.name);
    }
  }

  const verified = await inspectChatDmAssistantRollback(db, {
    targetFingerprint,
    dropEmptyJobsCollection,
  });
  const afterMessageCount =
    verified.collections.find((c) => c.name === 'chat_conversation_messages')
      ?.documentCount ?? 0;

  if (
    !verified.clean ||
    verified.summary.collectionsClearValidator > 0 ||
    verified.summary.collectionsDrop > 0 ||
    verified.summary.indexesDrop > 0 ||
    afterMessageCount < beforeMessageCount
  ) {
    throw new Error(
      'Post-rollback verification failed; preserve data and inspect current state',
    );
  }

  return { ...verified, rolledBack: true };
}

async function runCli() {
  const options = parseMigrationArgs(process.argv.slice(2), process.env);
  const client = new mongoose.mongo.MongoClient(options.uri, {
    serverSelectionTimeoutMS: 10000,
    appName: 'chat-dm-assistant-schema-migration',
  });
  try {
    await client.connect();
    const db = client.db(DATABASE);
    let report;
    if (options.mode === 'dry-run' || options.mode === 'apply') {
      report = await migrateChatDmAssistantSchema(db, {
        apply: options.mode === 'apply',
        expectedReportSha256: options.expectedReportSha256,
        targetFingerprint: options.target.targetFingerprint,
      });
    } else {
      report = await rollbackChatDmAssistantSchema(db, {
        execute: options.mode === 'rollback',
        dropEmptyJobsCollection: options.dropEmptyJobsCollection,
        expectedReportSha256: options.expectedReportSha256,
        targetFingerprint: options.target.targetFingerprint,
      });
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.clean) {
      process.exitCode = 2;
    }
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli().catch((error) => {
    const safeMessage =
      error instanceof Error &&
      /^(Expected database|Unknown migration|Duplicate migration|Choose at most|--|CHAT_MONGODB_URI|A valid MongoDB|MongoDB URI|Mutating a non-loopback|Apply |Rollback |Post-)/.test(
        error.message,
      )
        ? error.message
        : 'Chat DM assistant migration failed. Check target/arguments and rerun the read-only dry-run; no raw driver error is logged.';
    process.stderr.write(`${safeMessage}\n`);
    process.exitCode = 1;
  });
}
