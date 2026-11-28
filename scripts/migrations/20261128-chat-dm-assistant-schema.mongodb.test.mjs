import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  CONTINUUM_AI_HANDLE,
  CONTINUUM_AI_SENDER_ID,
  DATABASE,
} from './20261128-chat-dm-assistant-schema.plan.mjs';
import {
  inspectChatDmAssistantRollback,
  inspectChatDmAssistantSchema,
  migrateChatDmAssistantSchema,
  rollbackChatDmAssistantSchema,
} from './20261128-chat-dm-assistant-schema.mjs';

const execFileAsync = promisify(execFile);
const migrationCliPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '20261128-chat-dm-assistant-schema.mjs',
);

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { CHAT_PERSISTENCE } = require(
  '../../src/services/chat/infrastructure/persistence.ts',
);
const { createCollectionSchema } = require(
  '../../src/services/chat/infrastructure/mongodb/mongodb.schemas.ts',
);

const oid = () => new Types.ObjectId();

async function withIsolatedMongo(run) {
  const replSet = await MongoMemoryReplSet.create({
    binary: { version: '7.0.24' },
    replSet: { count: 1 },
  });
  const connection = mongoose.createConnection(replSet.getUri(), {
    dbName: DATABASE,
    autoIndex: false,
  });
  try {
    await connection.asPromise();
    await run(connection);
  } finally {
    await connection.close();
    await replSet.stop();
  }
}

test(
  'MongoDB 7: dry-run, additive apply, idempotent re-run, legacy & Mongoose Model.create compatibility, strict validator/unique guards, and safe rollback',
  { timeout: 180_000 },
  async () => {
    await withIsolatedMongo(async (connection) => {
      const db = connection.db;
      const messages = db.collection('chat_conversation_messages');
      const orgId = oid();
      const convId = oid();
      const userA = oid().toHexString();
      const userB = oid().toHexString();

      // Seed existing indexes including Atlas-named text index that must never be dropped
      await messages.createIndex({ conversationId: 1, createdAt: -1, _id: -1 });
      await messages.createIndex(
        { conversationId: 1, content: 'text' },
        { name: 'conversationId_1_content_text' },
      );
      await messages.createIndex(
        { conversationId: 1, senderId: 1, clientMessageId: 1 },
        { unique: true },
      );
      await messages.createIndex(
        { conversationId: 1, isPinned: 1, createdAt: -1 },
        {
          name: 'chat_messages_pinned_partial',
          partialFilterExpression: { isPinned: true },
        },
      );

      // Seed pre-migration legacy human docs (omitting authorType, contentVersion, sourceReferences)
      const legacyActive = {
        _id: oid(),
        organizationId: orgId,
        conversationId: convId,
        senderId: userA,
        senderName: 'Nguyễn An',
        senderAvatarUrl: null,
        clientMessageId: 'legacy-msg-1',
        content: 'Chốt dời deadline PAY-123 sang 29/11 lúc 17:00 nhé.',
        mentionUserIds: [],
        links: [],
        isPinned: false,
        editedAt: null,
        deletedAt: null,
        reactions: [],
        replyToMessageId: null,
        attachments: [],
        createdAt: new Date('2026-11-27T08:15:00.000Z'),
        updatedAt: new Date('2026-11-27T08:15:00.000Z'),
      };
      const legacyDeleted = {
        _id: oid(),
        organizationId: orgId,
        conversationId: convId,
        senderId: userB,
        senderName: 'Trần Bình',
        senderAvatarUrl: null,
        clientMessageId: 'legacy-msg-deleted',
        content: '',
        mentionUserIds: [],
        links: [],
        isPinned: false,
        editedAt: null,
        deletedAt: new Date('2026-11-27T09:00:00.000Z'),
        reactions: [],
        replyToMessageId: null,
        attachments: [],
        createdAt: new Date('2026-11-27T08:20:00.000Z'),
        updatedAt: new Date('2026-11-27T09:00:00.000Z'),
      };
      await messages.insertMany([legacyActive, legacyDeleted]);

      // 1. Read-only dry-run performs zero writes
      const collectionsBefore = await db.listCollections().toArray();
      const dryRun = await migrateChatDmAssistantSchema(db, { apply: false });
      assert.equal(dryRun.applied, false);
      assert.equal(dryRun.clean, true);
      assert.equal(dryRun.summary.collectionsValidate, 1);
      assert.equal(dryRun.summary.collectionsCreate, 1);
      assert.equal(dryRun.summary.indexesCreate, 6);
      assert.equal(
        dryRun.collections.find((c) => c.name === 'chat_conversation_messages')
          ?.legacyMessageCount,
        2,
      );
      assert.equal(
        (await db.listCollections().toArray()).length,
        collectionsBefore.length,
      );

      // 2. Apply refuses mismatched SHA-256 with zero writes
      await assert.rejects(
        migrateChatDmAssistantSchema(db, {
          apply: true,
          expectedReportSha256: '0'.repeat(64),
        }),
        /differs from --expected-report-sha256/,
      );
      assert.equal(
        (await db.listCollections().toArray()).length,
        collectionsBefore.length,
      );

      // 3. Reviewed apply succeeds and preserves legacy docs + existing indexes untouched
      const applied = await migrateChatDmAssistantSchema(db, {
        apply: true,
        expectedReportSha256: dryRun.reportSha256,
      });
      assert.equal(applied.applied, true);
      assert.equal(applied.clean, true);
      assert.equal(applied.summary.collectionsNoop, 2);
      assert.equal(applied.summary.indexesNoop, 6);

      assert.deepEqual(
        await messages.findOne({ _id: legacyActive._id }),
        legacyActive,
      );
      assert.deepEqual(
        await messages.findOne({ _id: legacyDeleted._id }),
        legacyDeleted,
      );

      const messageIndexesAfter = await messages.listIndexes().toArray();
      assert.ok(
        messageIndexesAfter.some(
          (idx) => idx.name === 'conversationId_1_content_text',
        ),
        'existing Atlas text index must be preserved untouched',
      );
      assert.ok(
        messageIndexesAfter.some(
          (idx) => idx.name === 'chat_messages_assistant_trigger_unique',
        ),
      );
      assert.ok(
        messageIndexesAfter.some(
          (idx) => idx.name === 'chat_messages_assistant_source_refs_idx',
        ),
      );

      // 4. Re-running apply is a strict idempotent NOOP
      const secondDryRun = await inspectChatDmAssistantSchema(db);
      assert.equal(secondDryRun.summary.collectionsNoop, 2);
      assert.equal(secondDryRun.summary.indexesNoop, 6);
      const secondApply = await migrateChatDmAssistantSchema(db, {
        apply: true,
        expectedReportSha256: secondDryRun.reportSha256,
      });
      assert.equal(secondApply.applied, true);
      assert.equal(secondApply.summary.indexesNoop, 6);

      // 5. Legacy human edit & delete still pass live moderate validator
      await messages.updateOne(
        { _id: legacyActive._id },
        {
          $set: {
            content: 'Chốt dời deadline PAY-123 sang 30/11 lúc 17:00 nhé.',
            editedAt: new Date('2026-11-28T01:00:00.000Z'),
          },
          $inc: { contentVersion: 1 },
        },
      );

      // 6. Verify Mongoose Model.create() inserts pass live MongoDB $jsonSchema validators!
      const msgDef = CHAT_PERSISTENCE.collections.find(
        (c) => c.name === 'chat_conversation_messages',
      );
      const jobsDef = CHAT_PERSISTENCE.collections.find(
        (c) => c.name === 'chat_assistant_jobs',
      );
      const MessageModel = connection.model(
        'continuum_chat_chat_conversation_messages',
        createCollectionSchema(msgDef),
      );
      const AssistantJobModel = connection.model(
        'continuum_chat_chat_assistant_jobs',
        createCollectionSchema(jobsDef),
      );

      // Ordinary human message via Mongoose Model.create() (must omit sourceReferences!)
      const createdHuman = await MessageModel.create({
        organizationId: orgId,
        conversationId: convId,
        senderId: userA,
        senderName: 'Nguyễn An',
        clientMessageId: 'mongoose-human-1',
        content: 'Tin nhắn thường từ Mongoose Model.create().',
      });
      const rawHuman = await messages.findOne({ _id: createdHuman._id });
      assert.equal(rawHuman.contentVersion, 0);
      assert.equal(
        Object.prototype.hasOwnProperty.call(rawHuman, 'sourceReferences'),
        false,
        'Mongoose must not persist sourceReferences: [] on human docs',
      );

      // Second ordinary human message proves partial unique index ignores non-assistant rows
      await MessageModel.create({
        organizationId: orgId,
        conversationId: convId,
        senderId: userB,
        senderName: 'Trần Bình',
        clientMessageId: 'mongoose-human-2',
        content: 'OK chốt nhé.',
      });

      // Human trigger message via Mongoose Model.create()
      const triggerDoc = await MessageModel.create({
        organizationId: orgId,
        conversationId: convId,
        senderId: userA,
        senderName: 'Nguyễn An',
        clientMessageId: 'mongoose-trigger-1',
        content: '@continuumAI Hôm qua hai người chốt những gì?',
        authorType: 'USER',
        assistantMention: {
          handle: CONTINUUM_AI_HANDLE,
          query: 'Hôm qua hai người chốt những gì?',
          timezone: 'Asia/Ho_Chi_Minh',
        },
      });

      // Valid ASSISTANT COMPLETED message via Mongoose Model.create()
      const assistantDoc = await MessageModel.create({
        organizationId: orgId,
        conversationId: convId,
        senderId: CONTINUUM_AI_SENDER_ID,
        senderName: 'Continuum AI',
        senderAvatarUrl: null,
        clientMessageId: `assistant:${triggerDoc._id.toHexString()}`,
        content: 'Hôm qua hai người đã chốt dời deadline PAY-123 [M1].',
        replyToMessageId: triggerDoc._id,
        authorType: 'ASSISTANT',
        triggerMessageId: triggerDoc._id,
        assistantStatus: 'COMPLETED',
        assistantFailureCode: null,
        assistantMeta: {
          handle: CONTINUUM_AI_HANDLE,
          queryMode: 'TIME_WINDOW',
          partialCoverage: false,
          coverageNote: null,
          model: 'gpt-4o-mini',
          promptTokens: 300,
          completionTokens: 55,
        },
        sourceReferences: [
          {
            refId: 'M1',
            messageId: legacyActive._id,
            senderName: 'Nguyễn An',
            createdAt: legacyActive.createdAt,
            sourceEditedAt: null,
            sourceVersion: 0,
            quoteSnippet: 'Chốt dời deadline PAY-123',
          },
        ],
      });

      // Duplicate assistant reply for same (conversationId, triggerMessageId) rejected with 11000
      await assert.rejects(
        messages.insertOne({
          organizationId: orgId,
          conversationId: convId,
          senderId: CONTINUUM_AI_SENDER_ID,
          senderName: 'Continuum AI',
          clientMessageId: `assistant:retry-${triggerDoc._id.toHexString()}`,
          content: 'Duplicate reply',
          authorType: 'ASSISTANT',
          triggerMessageId: triggerDoc._id,
          assistantStatus: 'COMPLETED',
          sourceReferences: [],
        }),
        { code: 11000 },
      );

      // Valid ASSISTANT INSUFFICIENT_EVIDENCE message with empty sourceReferences: []
      const secondTriggerId = oid();
      await MessageModel.create({
        organizationId: orgId,
        conversationId: convId,
        senderId: CONTINUUM_AI_SENDER_ID,
        senderName: 'Continuum AI',
        clientMessageId: `assistant:${secondTriggerId.toHexString()}`,
        content: 'Chưa đủ căn cứ trong hội thoại.',
        replyToMessageId: secondTriggerId,
        authorType: 'ASSISTANT',
        triggerMessageId: secondTriggerId,
        assistantStatus: 'INSUFFICIENT_EVIDENCE',
        assistantFailureCode: null,
        sourceReferences: [],
      });

      // Negative $jsonSchema validator checks on chat_conversation_messages (code 121)
      await assert.rejects(
        messages.insertOne({
          organizationId: orgId,
          conversationId: convId,
          senderId: CONTINUUM_AI_SENDER_ID,
          senderName: 'Continuum AI',
          clientMessageId: 'bad-ai-no-trigger',
          content: 'Missing triggerMessageId',
          authorType: 'ASSISTANT',
          assistantStatus: 'COMPLETED',
          sourceReferences: [],
        }),
        { code: 121 },
      );
      await assert.rejects(
        messages.insertOne({
          organizationId: orgId,
          conversationId: convId,
          senderId: userA,
          senderName: 'Fake AI',
          clientMessageId: 'bad-ai-wrong-sender',
          content: 'Wrong senderId for assistant',
          authorType: 'ASSISTANT',
          triggerMessageId: oid(),
          assistantStatus: 'COMPLETED',
          sourceReferences: [],
        }),
        { code: 121 },
      );
      await assert.rejects(
        messages.insertOne({
          organizationId: orgId,
          conversationId: convId,
          senderId: userA,
          senderName: 'Nguyễn An',
          clientMessageId: 'bad-human-with-trigger',
          content: 'Human message must not carry triggerMessageId',
          authorType: 'USER',
          triggerMessageId: oid(),
        }),
        { code: 121 },
      );
      await assert.rejects(
        messages.insertOne({
          organizationId: orgId,
          conversationId: convId,
          senderId: userA,
          senderName: 'Nguyễn An',
          clientMessageId: 'bad-human-with-refs',
          content: 'Human message must not carry sourceReferences',
          sourceReferences: [],
        }),
        { code: 121 },
      );

      // 7. chat_assistant_jobs strict validation + unique triggerMessageId constraint
      const jobDoc = await AssistantJobModel.create({
        organizationId: orgId,
        conversationId: convId,
        triggerMessageId: triggerDoc._id,
        requesterUserId: userA,
        requesterDisplayName: 'Nguyễn An',
        query: 'Hôm qua hai người chốt những gì?',
      });
      assert.equal(jobDoc.status, 'PENDING');

      // Duplicate triggerMessageId job rejected with 11000
      await assert.rejects(
        db.collection('chat_assistant_jobs').insertOne({
          organizationId: orgId,
          conversationId: convId,
          triggerMessageId: triggerDoc._id,
          requesterUserId: userA,
          requesterDisplayName: 'Nguyễn An',
          handle: CONTINUUM_AI_HANDLE,
          query: 'Duplicate job',
          timezone: 'Asia/Ho_Chi_Minh',
          status: 'PENDING',
          failureCode: null,
          attempts: 0,
          maxAttempts: 3,
          nextAttemptAt: new Date(),
          lockedBy: null,
          lockedUntil: null,
          responseMessageId: null,
          completedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        { code: 11000 },
      );

      // Strict validator rejects unallowed content fields in metrics or invalid maxAttempts
      await assert.rejects(
        db.collection('chat_assistant_jobs').insertOne({
          organizationId: orgId,
          conversationId: convId,
          triggerMessageId: oid(),
          requesterUserId: userA,
          requesterDisplayName: 'Nguyễn An',
          handle: CONTINUUM_AI_HANDLE,
          query: 'Check metrics guard',
          timezone: 'Asia/Ho_Chi_Minh',
          status: 'PENDING',
          failureCode: null,
          attempts: 0,
          maxAttempts: 3,
          nextAttemptAt: new Date(),
          lockedBy: null,
          lockedUntil: null,
          responseMessageId: null,
          metrics: { leakedChatText: 'secret' },
          completedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        { code: 121 },
      );

      // 8. Rollback safety: blocked while job is PENDING, succeeds once job completes, preserves legacy data/indexes
      const blockedRollbackPlan = await inspectChatDmAssistantRollback(db);
      assert.equal(blockedRollbackPlan.clean, false);
      assert.ok(
        blockedRollbackPlan.blockers.some(
          (b) => b.code === 'ACTIVE_JOBS_PRESENT',
        ),
      );
      await assert.rejects(
        rollbackChatDmAssistantSchema(db, {
          execute: true,
          expectedReportSha256: blockedRollbackPlan.reportSha256,
        }),
        /Rollback blocked/,
      );

      // Complete the job, then run safe rollback (preserving jobs collection & messages)
      await db.collection('chat_assistant_jobs').updateOne(
        { _id: jobDoc._id },
        {
          $set: {
            status: 'COMPLETED',
            responseMessageId: assistantDoc._id,
            completedAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );
      const rollbackPlan = await inspectChatDmAssistantRollback(db);
      assert.equal(rollbackPlan.clean, true);
      assert.equal(rollbackPlan.summary.indexesDrop, 6);
      assert.equal(rollbackPlan.summary.collectionsClearValidator, 2);

      const rolledBack = await rollbackChatDmAssistantSchema(db, {
        execute: true,
        expectedReportSha256: rollbackPlan.reportSha256,
      });
      assert.equal(rolledBack.rolledBack, true);
      assert.equal(rolledBack.summary.indexesDrop, 0);
      assert.equal(rolledBack.summary.collectionsClearValidator, 0);

      // Verify legacy indexes and all messages + job history were preserved!
      const indexesAfterRollback = await messages.listIndexes().toArray();
      assert.ok(
        indexesAfterRollback.some(
          (idx) => idx.name === 'conversationId_1_content_text',
        ),
      );
      assert.equal(
        indexesAfterRollback.some(
          (idx) => idx.name === 'chat_messages_assistant_trigger_unique',
        ),
        false,
      );
      assert.equal(await messages.countDocuments(), 7);
      assert.equal(
        await db.collection('chat_assistant_jobs').countDocuments(),
        1,
      );
    });
  },
);

test(
  'MongoDB 7: duplicate triggerMessageId preflight blocks apply before any DDL writes',
  { timeout: 120_000 },
  async () => {
    await withIsolatedMongo(async (connection) => {
      const db = connection.db;
      const messages = db.collection('chat_conversation_messages');
      const orgId = oid();
      const convId = oid();
      const triggerId = oid();

      await messages.insertMany([
        {
          organizationId: orgId,
          conversationId: convId,
          senderId: CONTINUUM_AI_SENDER_ID,
          senderName: 'Continuum AI',
          clientMessageId: 'dup-1',
          content: 'Reply 1',
          authorType: 'ASSISTANT',
          triggerMessageId: triggerId,
          assistantStatus: 'COMPLETED',
          sourceReferences: [],
        },
        {
          organizationId: orgId,
          conversationId: convId,
          senderId: CONTINUUM_AI_SENDER_ID,
          senderName: 'Continuum AI',
          clientMessageId: 'dup-2',
          content: 'Reply 2',
          authorType: 'ASSISTANT',
          triggerMessageId: triggerId,
          assistantStatus: 'COMPLETED',
          sourceReferences: [],
        },
      ]);

      const dryRun = await inspectChatDmAssistantSchema(db);
      assert.equal(dryRun.clean, false);
      assert.ok(
        dryRun.blockers.some(
          (b) =>
            b.code === 'DUPLICATE_KEYS' &&
            b.index === 'chat_messages_assistant_trigger_unique',
        ),
      );

      await assert.rejects(
        migrateChatDmAssistantSchema(db, {
          apply: true,
          expectedReportSha256: dryRun.reportSha256,
        }),
        /Apply blocked by preflight/,
      );

      // Confirm zero collections, indexes, or validators were altered
      const collections = await db.listCollections().toArray();
      assert.equal(collections.length, 1);
      assert.equal(collections[0].options?.validator, undefined);
      assert.equal((await messages.listIndexes().toArray()).length, 1);
    });
  },
);

test(
  'MongoDB 7: CLI dry-run stdout report and empty-jobs-collection rollback',
  { timeout: 120_000 },
  async () => {
    const replSet = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: { count: 1 },
    });
    const uri = replSet.getUri();
    const connection = mongoose.createConnection(uri, {
      dbName: DATABASE,
      autoIndex: false,
    });
    try {
      await connection.asPromise();
      const db = connection.db;

      // Run CLI directly in default read-only dry-run mode
      const { stdout } = await execFileAsync(
        process.execPath,
        [migrationCliPath],
        {
          env: { ...process.env, CHAT_MONGODB_URI: uri, MONGODB_URI: '' },
        },
      );
      const cliReport = JSON.parse(stdout);
      assert.equal(cliReport.applied, false);
      assert.equal(cliReport.clean, true);
      assert.equal(cliReport.databaseName, DATABASE);
      assert.equal(cliReport.summary.collectionsCreate, 2);
      assert.equal(cliReport.summary.indexesCreate, 6);
      assert.match(cliReport.reportSha256, /^[a-f0-9]{64}$/);
      assert.equal((await db.listCollections().toArray()).length, 0);

      // Apply on empty DB, then rollback with --drop-empty-jobs-collection
      await migrateChatDmAssistantSchema(db, {
        apply: true,
        expectedReportSha256: cliReport.reportSha256,
        targetFingerprint: cliReport.targetFingerprint,
      });
      assert.equal((await db.listCollections().toArray()).length, 2);

      const rbPlan = await inspectChatDmAssistantRollback(db, {
        dropEmptyJobsCollection: true,
      });
      assert.equal(rbPlan.clean, true);
      assert.equal(rbPlan.summary.collectionsDrop, 1);
      assert.equal(rbPlan.summary.indexesDrop, 2);

      const rbDone = await rollbackChatDmAssistantSchema(db, {
        execute: true,
        dropEmptyJobsCollection: true,
        expectedReportSha256: rbPlan.reportSha256,
      });
      assert.equal(rbDone.rolledBack, true);
      const remaining = (await db.listCollections().toArray()).map(
        (entry) => entry.name,
      );
      assert.deepEqual(remaining, ['chat_conversation_messages']);
    } finally {
      await connection.close();
      await replSet.stop();
    }
  },
);

