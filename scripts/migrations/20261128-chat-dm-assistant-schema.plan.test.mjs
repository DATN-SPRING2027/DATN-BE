import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_ASSISTANT_JOBS_VALIDATOR,
  CHAT_CONVERSATION_MESSAGES_VALIDATOR,
  CHAT_DM_ASSISTANT_INDEX_SPECS,
  DATABASE,
  planChatDmAssistantRollback,
  planChatDmAssistantSchema,
  validateTarget,
} from './20261128-chat-dm-assistant-schema.plan.mjs';
import { parseMigrationArgs } from './20261128-chat-dm-assistant-schema.mjs';

const LEGACY_MESSAGE_INDEXES = [
  { name: '_id_', key: { _id: 1 } },
  {
    name: 'conversationId_1_createdAt_-1__id_-1',
    key: { conversationId: 1, createdAt: -1, _id: -1 },
  },
  {
    // Atlas dev uses the default generated name for the existing text index;
    // migration must preserve it untouched.
    name: 'conversationId_1_content_text',
    key: { conversationId: 1, _fts: 'text', _ftsx: 1 },
  },
  {
    name: 'conversationId_1_senderId_1_clientMessageId_1',
    key: { conversationId: 1, senderId: 1, clientMessageId: 1 },
    unique: true,
  },
  {
    name: 'chat_messages_pinned_partial',
    key: { conversationId: 1, isPinned: 1, createdAt: -1 },
    partialFilterExpression: { isPinned: true },
  },
  {
    name: 'chat_messages_attachments_kind_partial',
    key: { conversationId: 1, 'attachments.kind': 1, createdAt: -1 },
    partialFilterExpression: { 'attachments.kind': { $exists: true } },
  },
];

function buildMigratedInventory({ activeJobCount = 0, jobDocCount = 0 } = {}) {
  return {
    chat_conversation_messages: {
      exists: true,
      objectType: 'collection',
      documentCount: 120,
      legacyMessageCount: 118,
      assistantMessageCount: 2,
      invalidDocumentCount: 0,
      validator: CHAT_CONVERSATION_MESSAGES_VALIDATOR,
      validationLevel: 'moderate',
      validationAction: 'error',
      indexes: [
        ...LEGACY_MESSAGE_INDEXES,
        ...CHAT_DM_ASSISTANT_INDEX_SPECS.filter(
          (spec) => spec.collection === 'chat_conversation_messages',
        ).map((spec) => ({ ...spec })),
      ],
    },
    chat_assistant_jobs: {
      exists: true,
      objectType: 'collection',
      documentCount: jobDocCount,
      activeJobCount,
      invalidDocumentCount: 0,
      validator: CHAT_ASSISTANT_JOBS_VALIDATOR,
      validationLevel: 'strict',
      validationAction: 'error',
      indexes: [
        { name: '_id_', key: { _id: 1 } },
        ...CHAT_DM_ASSISTANT_INDEX_SPECS.filter(
          (spec) => spec.collection === 'chat_assistant_jobs',
        ).map((spec) => ({ ...spec })),
      ],
    },
  };
}

test('plans CREATE for empty database with deterministic SHA-256 and zero document rewrites', () => {
  const plan = planChatDmAssistantSchema({
    databaseName: DATABASE,
    targetFingerprint: 'fp-empty',
    inventory: {},
  });

  assert.equal(plan.clean, true);
  assert.equal(plan.rewriteDocuments, false);
  assert.equal(plan.preservesExistingIndexes, true);
  assert.equal(plan.summary.collectionsCreate, 2);
  assert.equal(plan.summary.collectionsValidate, 0);
  assert.equal(plan.summary.indexesCreate, 6);
  assert.equal(plan.summary.indexesNoop, 0);
  assert.equal(plan.summary.blockers, 0);
  assert.match(plan.reportSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    plan.reportSha256,
    planChatDmAssistantSchema({
      databaseName: DATABASE,
      targetFingerprint: 'fp-empty',
      inventory: {},
    }).reportSha256,
  );
});

test('plans VALIDATE on existing chat_conversation_messages with legacy docs/indexes and CREATE on chat_assistant_jobs', () => {
  const plan = planChatDmAssistantSchema({
    databaseName: DATABASE,
    targetFingerprint: 'fp-legacy',
    inventory: {
      chat_conversation_messages: {
        exists: true,
        objectType: 'collection',
        documentCount: 82,
        legacyMessageCount: 82,
        assistantMessageCount: 0,
        invalidDocumentCount: 0,
        validator: {},
        indexes: LEGACY_MESSAGE_INDEXES,
      },
      chat_assistant_jobs: { exists: false },
    },
  });

  assert.equal(plan.clean, true);
  assert.equal(plan.summary.collectionsValidate, 1);
  assert.equal(plan.summary.collectionsCreate, 1);
  assert.equal(plan.summary.indexesCreate, 6);
  const messagesPlan = plan.collections.find(
    (c) => c.name === 'chat_conversation_messages',
  );
  assert.equal(messagesPlan?.action, 'VALIDATE');
  assert.equal(messagesPlan?.validationLevel, 'moderate');
  assert.equal(messagesPlan?.legacyMessageCount, 82);
  const jobsPlan = plan.collections.find(
    (c) => c.name === 'chat_assistant_jobs',
  );
  assert.equal(jobsPlan?.action, 'CREATE');
  assert.equal(jobsPlan?.validationLevel, 'strict');
});

test('is a complete idempotent NOOP when validators and all 6 additive indexes already match', () => {
  const plan = planChatDmAssistantSchema({
    databaseName: DATABASE,
    targetFingerprint: 'fp-migrated',
    inventory: buildMigratedInventory({ jobDocCount: 4 }),
  });

  assert.equal(plan.clean, true);
  assert.equal(plan.summary.collectionsCreate, 0);
  assert.equal(plan.summary.collectionsValidate, 0);
  assert.equal(plan.summary.collectionsNoop, 2);
  assert.equal(plan.summary.indexesCreate, 0);
  assert.equal(plan.summary.indexesNoop, 6);
  assert.equal(plan.summary.blockers, 0);
  assert.deepEqual(plan.rollbackPreview.dropManagedIndexes, []);
  assert.deepEqual(plan.rollbackPreview.clearManagedValidators, []);
});

test('blocks apply when duplicate triggerMessageId keys, index conflicts, validator conflicts, or invalid docs exist', () => {
  const duplicatePlan = planChatDmAssistantSchema({
    databaseName: DATABASE,
    targetFingerprint: 'fp-dupes',
    inventory: {
      chat_conversation_messages: {
        exists: true,
        objectType: 'collection',
        documentCount: 10,
        invalidDocumentCount: 0,
        validator: {},
        indexes: LEGACY_MESSAGE_INDEXES,
        duplicateKeysByIndex: {
          chat_messages_assistant_trigger_unique: [{ count: 2 }],
        },
      },
      chat_assistant_jobs: {
        exists: true,
        objectType: 'collection',
        documentCount: 2,
        invalidDocumentCount: 0,
        validator: {},
        indexes: [{ name: '_id_', key: { _id: 1 } }],
        duplicateKeysByIndex: {
          chat_assistant_jobs_trigger_unique: [{ count: 2 }],
        },
      },
    },
  });

  assert.equal(duplicatePlan.clean, false);
  assert.equal(duplicatePlan.summary.indexesBlock, 2);
  assert.equal(
    duplicatePlan.blockers.filter((b) => b.code === 'DUPLICATE_KEYS').length,
    2,
  );

  const conflictPlan = planChatDmAssistantSchema({
    databaseName: DATABASE,
    targetFingerprint: 'fp-conflict',
    inventory: {
      chat_conversation_messages: {
        exists: true,
        objectType: 'collection',
        documentCount: 5,
        invalidDocumentCount: 1,
        validator: { $jsonSchema: { bsonType: 'object', required: ['other'] } },
        indexes: [
          ...LEGACY_MESSAGE_INDEXES,
          {
            name: 'chat_messages_assistant_trigger_unique',
            key: { conversationId: 1, triggerMessageId: 1 },
            unique: false,
          },
        ],
      },
    },
  });

  assert.equal(conflictPlan.clean, false);
  const codes = new Set(conflictPlan.blockers.map((b) => b.code));
  assert.ok(codes.has('INVALID_DOCUMENTS'));
  assert.ok(codes.has('VALIDATOR_CONFLICT'));
  assert.ok(codes.has('INDEX_CONFLICT'));
});

test('rejects wrong database name', () => {
  assert.throws(
    () =>
      planChatDmAssistantSchema({
        databaseName: 'continuum_iam',
        inventory: {},
      }),
    /Expected database continuum_chat/,
  );
  assert.throws(
    () =>
      planChatDmAssistantRollback({
        databaseName: 'continuum_capture',
        inventory: {},
      }),
    /Expected database continuum_chat/,
  );
});

test('scopes rollback strictly to managed indexes/validators, preserves legacy indexes, and blocks active jobs', () => {
  // Active PENDING/PROCESSING jobs must block rollback
  const blockedByActiveJobs = planChatDmAssistantRollback({
    databaseName: DATABASE,
    targetFingerprint: 'fp-rollback-active',
    inventory: buildMigratedInventory({ activeJobCount: 2, jobDocCount: 5 }),
  });
  assert.equal(blockedByActiveJobs.clean, false);
  assert.ok(
    blockedByActiveJobs.blockers.some((b) => b.code === 'ACTIVE_JOBS_PRESENT'),
  );

  // Default rollback with 0 active jobs and historical completed jobs preserves chat_assistant_jobs collection
  const safeRollback = planChatDmAssistantRollback({
    databaseName: DATABASE,
    targetFingerprint: 'fp-rollback-safe',
    inventory: buildMigratedInventory({ activeJobCount: 0, jobDocCount: 5 }),
    dropEmptyJobsCollection: false,
  });
  assert.equal(safeRollback.clean, true);
  assert.equal(safeRollback.preservesLegacyCollectionsAndIndexes, true);
  assert.equal(safeRollback.summary.collectionsClearValidator, 2);
  assert.equal(safeRollback.summary.collectionsDrop, 0);
  assert.equal(safeRollback.summary.indexesDrop, 6);
  const droppedNames = safeRollback.dropIndexes
    .filter((i) => i.action === 'DROP')
    .map((i) => i.name);
  assert.deepEqual(
    droppedNames.sort(),
    CHAT_DM_ASSISTANT_INDEX_SPECS.map((s) => s.name).sort(),
  );
  // Confirm NO legacy index is ever in the rollback drop list
  for (const legacy of LEGACY_MESSAGE_INDEXES) {
    assert.equal(droppedNames.includes(legacy.name), false);
  }

  // Attempting --drop-empty-jobs-collection on non-empty jobs collection must block
  const blockedDropNonEmpty = planChatDmAssistantRollback({
    databaseName: DATABASE,
    targetFingerprint: 'fp-rollback-nonempty',
    inventory: buildMigratedInventory({ activeJobCount: 0, jobDocCount: 1 }),
    dropEmptyJobsCollection: true,
  });
  assert.equal(blockedDropNonEmpty.clean, false);
  assert.ok(
    blockedDropNonEmpty.blockers.some(
      (b) => b.code === 'NON_EMPTY_JOBS_COLLECTION',
    ),
  );

  // Empty jobs collection with explicit flag drops jobs collection + only the 2 message assistant indexes
  const dropEmptyRollback = planChatDmAssistantRollback({
    databaseName: DATABASE,
    targetFingerprint: 'fp-rollback-empty',
    inventory: buildMigratedInventory({ activeJobCount: 0, jobDocCount: 0 }),
    dropEmptyJobsCollection: true,
  });
  assert.equal(dropEmptyRollback.clean, true);
  assert.equal(dropEmptyRollback.summary.collectionsDrop, 1);
  assert.equal(dropEmptyRollback.summary.collectionsClearValidator, 1);
  assert.equal(dropEmptyRollback.summary.indexesDrop, 2);
  assert.equal(
    dropEmptyRollback.collections.find(
      (c) => c.name === 'chat_conversation_messages',
    )?.action,
    'CLEAR_VALIDATOR',
  );
  assert.equal(
    dropEmptyRollback.collections.find((c) => c.name === 'chat_assistant_jobs')
      ?.action,
    'DROP_COLLECTION',
  );
});

test('enforces CLI safety guards and strips credentials from targetFingerprint', () => {
  const fpA = validateTarget(
    'mongodb+srv://alice:secret1@cluster0.example.mongodb.net/continuum_db?retryWrites=true',
  );
  const fpB = validateTarget(
    'mongodb+srv://bob:secret2@cluster0.example.mongodb.net/other_db?retryWrites=true',
  );
  assert.equal(fpA.loopback, false);
  assert.equal(fpA.databaseName, DATABASE);
  assert.equal(fpA.targetFingerprint, fpB.targetFingerprint);
  assert.match(fpA.targetFingerprint, /^[a-f0-9]{64}$/);

  const loopbackTarget = validateTarget('mongodb://127.0.0.1:27017');
  assert.equal(loopbackTarget.loopback, true);

  // Dry-run works without hash or shared confirmation
  const dryRun = parseMigrationArgs([], {
    MONGODB_URI: 'mongodb+srv://user:pass@cluster0.example.mongodb.net',
  });
  assert.equal(dryRun.mode, 'dry-run');

  // Apply requires expected-report-sha256
  assert.throws(
    () =>
      parseMigrationArgs(['--apply'], {
        MONGODB_URI: 'mongodb://127.0.0.1:27017',
      }),
    /--expected-report-sha256/,
  );

  // Non-loopback apply requires --allow-shared-database + CHAT_MIGRATION_CONFIRM_DATABASE=continuum_chat
  const fakeHash = 'a'.repeat(64);
  assert.throws(
    () =>
      parseMigrationArgs(
        ['--apply', `--expected-report-sha256=${fakeHash}`],
        {
          MONGODB_URI: 'mongodb+srv://user:pass@cluster0.example.mongodb.net',
        },
      ),
    /CHAT_MIGRATION_CONFIRM_DATABASE=continuum_chat/,
  );

  const validSharedApply = parseMigrationArgs(
    [
      '--apply',
      '--allow-shared-database',
      `--expected-report-sha256=${fakeHash}`,
    ],
    {
      MONGODB_URI: 'mongodb+srv://user:pass@cluster0.example.mongodb.net',
      CHAT_MIGRATION_CONFIRM_DATABASE: DATABASE,
    },
  );
  assert.equal(validSharedApply.mode, 'apply');

  // Conflicting flags rejected
  assert.throws(
    () =>
      parseMigrationArgs(
        ['--apply', '--rollback', `--expected-report-sha256=${fakeHash}`],
        { MONGODB_URI: 'mongodb://127.0.0.1:27017' },
      ),
    /Choose at most one/,
  );

  assert.throws(
    () =>
      parseMigrationArgs(['--drop-empty-jobs-collection'], {
        MONGODB_URI: 'mongodb://127.0.0.1:27017',
      }),
    /only valid with --rollback/,
  );
});
