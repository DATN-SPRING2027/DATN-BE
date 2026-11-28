import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const require = createRequire(import.meta.url);
require('reflect-metadata');
const { ConfigService } = require('@nestjs/config');
const {
  CHAT_PERSISTENCE,
} = require('../../dist/services/chat/infrastructure/persistence.js');
const {
  createCollectionSchema,
} = require('../../dist/services/chat/infrastructure/mongodb/mongodb.schemas.js');
const {
  MongoChatRepository,
} = require('../../dist/services/chat/infrastructure/mongodb/mongo-chat.repository.js');
const {
  RedisService,
} = require('../../dist/services/chat/infrastructure/redis/redis.service.js');
const {
  cachedChatRepository,
} = require('../../dist/services/chat/infrastructure/redis/chat-cache.repository.js');

if (process.env.NODE_ENV !== 'development')
  throw new Error('This test is restricted to development');
const organizationId = new mongoose.Types.ObjectId();
const prefix = `chat-fixture-${randomUUID()}`;
const connection = await mongoose
  .createConnection(process.env.CHAT_MONGODB_URI ?? process.env.MONGODB_URI, {
    dbName: CHAT_PERSISTENCE.databaseName,
    autoIndex: false,
  })
  .asPromise();
const redis = new RedisService(new ConfigService(process.env));
const keys = new Set();
const caching = Object.fromEntries(
  ['get', 'set', 'increment'].map((method) => [
    method,
    (key, ...args) => {
      keys.add(key);
      return redis[method](key, ...args);
    },
  ]),
);
for (const definition of CHAT_PERSISTENCE.collections)
  connection.model(
    `${CHAT_PERSISTENCE.databaseName}_${definition.name}`,
    createCollectionSchema(definition),
    definition.name,
  );
const native = new MongoChatRepository(connection);
const repository = cachedChatRepository(native, caching, prefix);
const actor = (name) => ({
  id: String(new mongoose.Types.ObjectId()),
  organizationId: String(organizationId),
  name,
  avatarUrl: null,
});
const a = actor('Fixture Owner'),
  b = actor('Fixture Member'),
  c = actor('Fixture Manager');
const candidate = (person) => ({
  id: person.id,
  fullName: person.name,
  avatarUrl: null,
});
const passed = [];
let fixtureOwned = false;
const collectionNames = [
  'chat_assistant_jobs',
  'chat_notifications',
  'chat_reports',
  'chat_blocks',
  'chat_uploads',
  'chat_conversation_messages',
  'chat_members',
  'chat_conversations',
];
try {
  // No real IAM user belongs to this random, unregistered organization. No realtime event is sent.
  for (const name of collectionNames)
    assert.equal(
      await connection.db.collection(name).countDocuments({ organizationId }),
      0,
    );
  fixtureOwned = true;
  const room = await repository.createRoom(
    a,
    'Chat integration fixture',
    [candidate(b), candidate(c)],
    randomUUID(),
  );
  await repository.setPreferences(b, room, {
    notificationMode: 'MENTIONS',
    isPinned: true,
    isArchived: true,
    markedUnread: true,
  });
  assert.equal((await repository.getPreferences(b, room)).markedUnread, true);
  assert.equal((await repository.listConversations(b, 10)).data.length, 0);
  assert.equal(
    (await repository.listConversations(b, 10, undefined, undefined, true))
      .data[0].id,
    room,
  );
  await repository.setPreferences(b, room, { isArchived: false });
  passed.push(
    'personal pin/archive/restore/unread and mention-only preferences',
  );

  await repository.saveDraft(a, room, 'Hi @Fixture Member', [b.id]);
  assert.deepEqual((await repository.getDraft(a, room)).mentionUserIds, [b.id]);
  await repository.saveDraft(a, room, '', []);
  assert.equal((await repository.getDraft(a, room)).content, '');
  passed.push(
    'durable draft and mention identity restoration through Redis cache',
  );

  await repository.setPreferences(c, room, { notificationMode: 'NONE' });
  const sent = await repository.sendMessage(
    a,
    room,
    randomUUID(),
    'xin chào fixture',
    [],
    undefined,
    [b.id],
  );
  assert.equal((await repository.notifications(b, 10)).data.length, 1);
  assert.equal((await repository.notifications(c, 10)).data.length, 0);
  await repository.markDelivered(b, room, sent.message.id);
  await repository.markRead(b, room, sent.message.id);
  const receipt = (
    await repository.receipts(a, room, sent.message.id)
  ).data.find((item) => item.userId === b.id);
  assert.equal(receipt.read, true);
  assert.equal(receipt.delivered, true);
  assert.ok(receipt.readAt);
  assert.ok(receipt.deliveredAt);
  assert.ok((await repository.notifications(b, 10)).data[0].readAt);
  passed.push(
    'mention notifications, mute, delivery/read acknowledgments and notification read synchronization',
  );

  await repository.pinMessage(a, room, sent.message.id, true);
  assert.equal(
    (await repository.library(a, room, 'PIN', 10)).data[0].id,
    sent.message.id,
  );
  await repository.pinMessage(a, room, sent.message.id, false);
  assert.equal((await repository.library(a, room, 'PIN', 10)).data.length, 0);
  passed.push('shared message pin/unpin with cache invalidation');

  await repository.transferOwnership(a, room, b.id);
  const conversation = await repository.getConversation(a, room);
  assert.equal(conversation.createdBy, a.id);
  assert.equal(
    conversation.members.find((member) => member.userId === b.id).role,
    'OWNER',
  );
  await repository.setManager(b, room, c.id, true);
  await assert.rejects(
    repository.setManager(a, room, c.id, false),
    (error) => error.getStatus() === 404,
  );
  await repository.renameRoom(c, room, 'Renamed integration fixture');
  assert.equal(
    (await repository.getConversation(a, room)).title,
    'Renamed integration fixture',
  );
  passed.push(
    'atomic ownership transfer, original creator preservation and manager authorization',
  );

  const target = await repository.createDirect(a, candidate(b));
  const attachmentId = randomUUID();
  const sourceId = new mongoose.Types.ObjectId();
  await connection.db
    .collection('chat_conversation_messages')
    .insertOne({
      _id: sourceId,
      organizationId,
      conversationId: new mongoose.Types.ObjectId(room),
      senderId: a.id,
      senderName: a.name,
      clientMessageId: randomUUID(),
      content: 'Shared fixture https://example.test/docs',
      links: ['https://example.test/docs'],
      createdAt: new Date(),
      deletedAt: null,
      attachments: [
        {
          id: attachmentId,
          name: 'fixture.png',
          contentType: 'image/png',
          size: 1,
          kind: 'IMAGE',
          provider: 'S3',
          objectKey: `fixtures/${prefix}/no-real-object`,
        },
      ],
    });
  const forwardId = randomUUID();
  const forwarded = await repository.forwardMessage(
    a,
    target,
    room,
    String(sourceId),
    forwardId,
  );
  assert.equal(forwarded.attachments.length, 1);
  assert.notEqual(forwarded.attachments[0].id, attachmentId);
  assert.equal(
    (
      await repository.forwardMessage(
        a,
        target,
        room,
        String(sourceId),
        forwardId,
      )
    ).id,
    forwarded.id,
  );
  assert.equal(
    (await repository.library(a, target, 'IMAGE', 10)).data[0].id,
    forwarded.id,
  );
  assert.equal(
    (await repository.library(a, target, 'LINK', 10)).data[0].id,
    forwarded.id,
  );
  await assert.rejects(
    repository.forwardMessage(a, target, room, sent.message.id, forwardId),
    (error) => error.getStatus() === 409,
  );
  await assert.rejects(
    repository.library(c, target, 'IMAGE', 10),
    (error) => error.getStatus() === 404,
  );
  passed.push(
    'idempotent text/file forwarding, distinct attachment IDs, media/link library and access control',
  );

  await repository.setBlock(a, b.id, true);
  await assert.rejects(
    repository.sendMessage(b, target, randomUUID(), 'blocked'),
    (error) => error.getStatus() === 409,
  );
  await repository.setBlock(a, b.id, false);
  await repository.sendMessage(b, target, randomUUID(), 'unblocked fixture');
  passed.push('bidirectional direct-message blocking and unblocking');

  const report = await repository.report(
    a,
    room,
    sent.message.id,
    'Integration test report',
  );
  assert.ok(report);
  assert.equal(
    (
      await connection.db
        .collection('chat_reports')
        .findOne({ _id: new mongoose.Types.ObjectId(report), organizationId })
    ).status,
    'OPEN',
  );
  const outsider = {
    ...a,
    organizationId: String(new mongoose.Types.ObjectId()),
  };
  await assert.rejects(
    repository.getPreferences(outsider, room),
    (error) => error.getStatus() === 404,
  );
  await repository.leaveRoom(c, room);
  await assert.rejects(
    repository.listMessages(c, room, 10),
    (error) => error.getStatus() === 404,
  );
  passed.push(
    'scoped reports, cross-organization denial, manager leave and membership revocation',
  );

  // Search indexing is asynchronous; wait a bounded time for this isolated fixture.
  let found = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    const page = await native.searchAcross(
      a,
      { q: 'xin chao', conversationId: room, senderId: a.id },
      10,
    );
    if (page.data.some((message) => message.id === sent.message.id)) {
      found = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(found, true);
  passed.push(
    'live MongoDB Search folding, sender/conversation filters and active membership filtering',
  );

  // DM @continuumAI repository integration checks (draft flag, DIRECT-only, atomic job outbox, immutability, forward guard, live source status & cache invalidation)
  await repository.saveDraft(a, target, '@continuumAI Hôm qua chốt gì?', [], true);
  const assistantDraft = await repository.getDraft(a, target);
  assert.equal(assistantDraft.assistantMention, true);
  await repository.saveDraft(a, target, '', [], false);
  assert.equal((await repository.getDraft(a, target)).assistantMention, false);

  await assert.rejects(
    repository.sendMessage(a, room, randomUUID(), '@continuumAI test room', [], undefined, [], {
      handle: 'continuumAI',
      query: 'test room',
      timezone: 'Asia/Ho_Chi_Minh',
    }),
    (error) =>
      error.getStatus() === 422 &&
      error.getResponse?.()?.code === 'CHAT_ASSISTANT_DIRECT_ONLY',
  );

  const sourceMsg = await repository.sendMessage(
    a,
    target,
    randomUUID(),
    'Chốt deadline PAY-123 sang thứ Sáu 29/11.',
  );
  const triggerClientId = randomUUID();
  const triggerSent = await repository.sendMessage(
    a,
    target,
    triggerClientId,
    '@continuumAI Deadline PAY-123 là khi nào?',
    [],
    undefined,
    [],
    {
      handle: 'continuumAI',
      query: 'Deadline PAY-123 là khi nào?',
      timezone: 'Asia/Ho_Chi_Minh',
    },
  );
  assert.equal(triggerSent.message.assistantState?.status, 'PENDING');
  assert.equal(triggerSent.assistantStatusEvent?.status, 'PENDING');

  // Idempotent replay with same clientMessageId + same assistantMention -> 0 duplicate jobs
  const replay = await repository.sendMessage(
    a,
    target,
    triggerClientId,
    '@continuumAI Deadline PAY-123 là khi nào?',
    [],
    undefined,
    [],
    {
      handle: 'continuumAI',
      query: 'Deadline PAY-123 là khi nào?',
      timezone: 'Asia/Ho_Chi_Minh',
    },
  );
  assert.equal(replay.message.id, triggerSent.message.id);
  assert.equal(replay.assistantStatusEvent, undefined);
  assert.equal(
    await connection.db
      .collection('chat_assistant_jobs')
      .countDocuments({ organizationId, triggerMessageId: new mongoose.Types.ObjectId(triggerSent.message.id) }),
    1,
  );

  // Replay conflict when omitting assistantMention
  await assert.rejects(
    repository.sendMessage(
      a,
      target,
      triggerClientId,
      '@continuumAI Deadline PAY-123 là khi nào?',
    ),
    (error) => error.getStatus() === 409,
  );

  // Insert an assistant reply referencing sourceMsg and verify immutability, forward block, and live EDITED/DELETED enrichment across Redis cache
  const aiMessageId = new mongoose.Types.ObjectId();
  await connection.db.collection('chat_conversation_messages').insertOne({
    _id: aiMessageId,
    organizationId,
    conversationId: new mongoose.Types.ObjectId(target),
    senderId: 'assistant:continuum_ai',
    senderName: 'Continuum AI',
    senderAvatarUrl: null,
    clientMessageId: `assistant:${triggerSent.message.id}`,
    content: 'Deadline PAY-123 là thứ Sáu 29/11 [M1].',
    mentionUserIds: [],
    links: [],
    isPinned: false,
    editedAt: null,
    deletedAt: null,
    reactions: [],
    replyToMessageId: new mongoose.Types.ObjectId(triggerSent.message.id),
    attachments: [],
    contentVersion: 0,
    authorType: 'ASSISTANT',
    triggerMessageId: new mongoose.Types.ObjectId(triggerSent.message.id),
    assistantStatus: 'COMPLETED',
    assistantFailureCode: null,
    assistantMeta: {
      handle: 'continuumAI',
      queryMode: 'KEYWORD',
      partialCoverage: false,
      coverageNote: null,
      model: 'fixture-model',
      promptTokens: 100,
      completionTokens: 20,
    },
    sourceReferences: [
      {
        refId: 'M1',
        messageId: new mongoose.Types.ObjectId(sourceMsg.message.id),
        senderName: a.name,
        createdAt: new Date(sourceMsg.message.createdAt),
        sourceEditedAt: null,
        sourceVersion: 0,
        quoteSnippet: 'Chốt deadline PAY-123 sang thứ Sáu 29/11.',
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await assert.rejects(
    repository.editMessage(a, target, String(aiMessageId), 'tamper'),
    (error) =>
      error.getStatus() === 403 &&
      error.getResponse?.()?.code === 'CHAT_ASSISTANT_MESSAGE_IMMUTABLE',
  );
  await assert.rejects(
    repository.deleteMessage(a, target, String(aiMessageId)),
    (error) =>
      error.getStatus() === 403 &&
      error.getResponse?.()?.code === 'CHAT_ASSISTANT_MESSAGE_IMMUTABLE',
  );
  await assert.rejects(
    repository.forwardMessage(a, room, target, String(aiMessageId), randomUUID()),
    (error) =>
      error.getStatus() === 422 &&
      error.getResponse?.()?.code === 'CHAT_ASSISTANT_FORWARD_FORBIDDEN',
  );

  // Prime Redis cache with ACTIVE, then edit & delete sourceMsg and confirm immediate live status update
  const activePage = await repository.listMessages(b, target, 20);
  const activeAi = activePage.data.find((m) => m.id === String(aiMessageId));
  assert.equal(activeAi?.sourceReferences?.[0]?.status, 'ACTIVE');
  assert.equal(activeAi?.assistantMeta?.sourceState, 'FRESH');

  await repository.editMessage(a, target, sourceMsg.message.id, 'Đính chính PAY-123 sang 30/11.');
  const editedPage = await repository.listMessages(b, target, 20);
  const editedAi = editedPage.data.find((m) => m.id === String(aiMessageId));
  assert.equal(editedAi?.sourceReferences?.[0]?.status, 'EDITED');
  assert.equal(editedAi?.assistantMeta?.sourceState, 'HAS_EDITED');

  await repository.deleteMessage(a, target, sourceMsg.message.id);
  const deletedPage = await repository.listMessages(b, target, 20);
  const deletedAi = deletedPage.data.find((m) => m.id === String(aiMessageId));
  assert.equal(deletedAi?.sourceReferences?.[0]?.status, 'DELETED');
  assert.equal(deletedAi?.sourceReferences?.[0]?.quoteSnippet, '');
  assert.equal(deletedAi?.assistantMeta?.sourceState, 'HAS_DELETED');
  passed.push(
    'DM @continuumAI draft flag, DIRECT-only guard, atomic job outbox, replay idempotency, AI immutability/forward block, and live EDITED/DELETED source enrichment through Redis cache',
  );
  console.log(
    JSON.stringify(
      {
        passed,
        checks: passed.length,
        isolatedOrganization: String(organizationId),
        realMessagesSent: 0,
        realFilesUploaded: 0,
      },
      null,
      2,
    ),
  );
} finally {
  // Delete only records in the random fixture organization verified empty before setup.
  if (fixtureOwned)
    for (const name of collectionNames)
      await connection.db.collection(name).deleteMany({ organizationId });
  for (const key of keys) {
    assert.ok(key.startsWith(`${prefix}:chat:`));
    await redis.delete(key);
  }
  redis.onModuleDestroy();
  await connection.close();
}
