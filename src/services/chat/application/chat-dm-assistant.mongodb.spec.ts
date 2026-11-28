import {
  BadGatewayException,
  GatewayTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SERVICE_DATABASES } from '../../../common/mongodb/database-names';
import type {
  AiEngineClient,
  AiEngineRequest,
} from '../../../integrations/ai-engine/ai-engine.port';
import { CHAT_PERSISTENCE } from '../infrastructure/persistence';
import {
  CHAT_ASSISTANT_JOBS_COLLECTION,
  CONTINUUM_AI_DISPLAY_NAME,
  CONTINUUM_AI_HANDLE,
  CONTINUUM_AI_SENDER_ID,
  createCollectionSchema,
} from '../infrastructure/mongodb/mongodb.schemas';
import {
  MongoChatRepository,
  type AssistantJobDocument,
  type MessageDocument,
} from '../infrastructure/mongodb/mongo-chat.repository';
import { MongoChatOrgMembershipChecker } from '../infrastructure/mongodb/mongo-chat-org-membership.checker';
import { cachedChatRepository } from '../infrastructure/redis/chat-cache.repository';
import type { RedisService } from '../infrastructure/redis/redis.service';
import { ChatHistoryCacheInvalidator } from './chat-history-cache';
import type { ChatRealtimeService } from './chat-realtime.service';
import type { ChatActor, ChatCandidate } from './chat.repository';
import type {
  SagDmAssistantAnswerRequest,
  SagDmAssistantAnswerResponse,
} from './chat-dm-assistant.types';
import { DmAssistantRetrievalService } from './chat-dm-assistant-retrieval.service';
import { ChatDmAssistantWorkerService } from './chat-dm-assistant.worker';

function createInMemoryRedis() {
  const store = new Map<string, string>();
  const redis = {
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    increment: jest.fn((key: string) => {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(next));
      return Promise.resolve(next);
    }),
    delete: jest.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
  } as unknown as RedisService;
  return { redis, store };
}

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    BULLMQ_PREFIX: 'test-dm',
    CHAT_DM_ASSISTANT_ENABLED: true,
    CHAT_DM_ASSISTANT_WORKER_ENABLED: false,
    CHAT_DM_ASSISTANT_LEASE_MS: 60_000,
    CHAT_DM_ASSISTANT_POLL_INTERVAL_MS: 1_000,
    CHAT_DM_ASSISTANT_MAX_CONTEXT_MESSAGES: 80,
    CHAT_DM_ASSISTANT_MAX_CONTEXT_CHARS: 24_000,
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('Chat DM @continuumAI — Real MongoMemoryReplSet E2E Integration (ACL, Retrieval, Worker, Anti-Race Commit & Cache)', () => {
  jest.setTimeout(120_000);

  let replicaSet: MongoMemoryReplSet;
  let connection: Connection;
  let nativeRepo: MongoChatRepository;
  let orgChecker: MongoChatOrgMembershipChecker;
  let retrieval: DmAssistantRetrievalService;

  const org1Id = new Types.ObjectId().toHexString();
  const org2Id = new Types.ObjectId().toHexString();

  const makeActor = (name: string, organizationId = org1Id): ChatActor => ({
    id: new Types.ObjectId().toHexString(),
    organizationId,
    name,
    avatarUrl: null,
  });
  const toCandidate = (actor: ChatActor): ChatCandidate => ({
    id: actor.id,
    fullName: actor.name,
    avatarUrl: actor.avatarUrl,
  });

  const userA = makeActor('Nguyễn An', org1Id);
  const userB = makeActor('Trần Bình', org1Id);
  const userC1 = makeActor('Lê Cường (Same Org Outsider)', org1Id);
  const userC2Manager = makeActor('Phạm Quản Lý (Org Admin Outsider)', org1Id);
  const userC3OtherOrg = makeActor('Vũ Ngoài Org', org2Id);

  async function seedIamActiveUser(
    orgId: string,
    userId: string,
    role = 'MEMBER',
  ) {
    const iamDb = connection.useDb(SERVICE_DATABASES.iam, {
      useCache: true,
    }).db!;
    const orgObjId = new Types.ObjectId(orgId);
    const userObjId = new Types.ObjectId(userId);
    await iamDb.collection('users').updateOne(
      { _id: userObjId },
      {
        $set: {
          email: `${userId}@test.local`,
          fullName: `User ${userId.slice(-4)}`,
          status: 'ACTIVE',
        },
      },
      { upsert: true },
    );
    await iamDb.collection('organization_memberships').updateOne(
      { organizationId: orgObjId, userId: userObjId },
      {
        $set: {
          organizationId: orgObjId,
          userId: userObjId,
          status: 'ACTIVE',
          role,
        },
      },
      { upsert: true },
    );
  }

  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: {
        count: 1,
        name: 'test-rs-chat-dm-assistant',
        storageEngine: 'wiredTiger',
      },
    });
    connection = mongoose.createConnection(replicaSet.getUri(), {
      dbName: CHAT_PERSISTENCE.databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 10_000,
    });
    await connection.asPromise();

    // Load exact migration validators so every write is proven against live MongoDB $jsonSchema!
    const migrationPlanUrl = pathToFileURL(
      join(
        __dirname,
        '../../../../scripts/migrations/20261128-chat-dm-assistant-schema.plan.mjs',
      ),
    ).href;
    const rawValidators = execFileSync(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(migrationPlanUrl)}).then((m) => process.stdout.write(JSON.stringify({ CHAT_CONVERSATION_MESSAGES_VALIDATOR: m.CHAT_CONVERSATION_MESSAGES_VALIDATOR, CHAT_ASSISTANT_JOBS_VALIDATOR: m.CHAT_ASSISTANT_JOBS_VALIDATOR })));`,
      ],
      { encoding: 'utf8' },
    );
    const migrationPlan = JSON.parse(rawValidators) as {
      CHAT_CONVERSATION_MESSAGES_VALIDATOR: Record<string, unknown>;
      CHAT_ASSISTANT_JOBS_VALIDATOR: Record<string, unknown>;
    };

    for (const def of CHAT_PERSISTENCE.collections) {
      if (def.name === 'chat_conversation_messages') {
        await connection.createCollection(def.name, {
          validator: migrationPlan.CHAT_CONVERSATION_MESSAGES_VALIDATOR,
          validationLevel: 'moderate',
          validationAction: 'error',
        });
      } else if (def.name === CHAT_ASSISTANT_JOBS_COLLECTION) {
        await connection.createCollection(def.name, {
          validator: migrationPlan.CHAT_ASSISTANT_JOBS_VALIDATOR,
          validationLevel: 'strict',
          validationAction: 'error',
        });
      } else {
        await connection.createCollection(def.name);
      }

      const model = connection.model(
        `${CHAT_PERSISTENCE.databaseName}_${def.name}`,
        createCollectionSchema(def),
        def.name,
      );
      await model.syncIndexes();
    }

    nativeRepo = new MongoChatRepository(connection);
    orgChecker = new MongoChatOrgMembershipChecker(connection);
    retrieval = new DmAssistantRetrievalService(connection);

    await Promise.all([
      seedIamActiveUser(org1Id, userA.id, 'MEMBER'),
      seedIamActiveUser(org1Id, userB.id, 'MEMBER'),
      seedIamActiveUser(org1Id, userC1.id, 'MEMBER'),
      seedIamActiveUser(org1Id, userC2Manager.id, 'ADMIN'),
      seedIamActiveUser(org2Id, userC3OtherOrg.id, 'MEMBER'),
    ]);
  });

  afterAll(async () => {
    await connection?.close();
    await replicaSet?.stop();
  });

  function createWorker(
    aiHandler: (
      request: AiEngineRequest,
    ) => Promise<{ status: number; body: SagDmAssistantAnswerResponse }>,
  ) {
    const { redis, store } = createInMemoryRedis();
    const config = makeConfig();
    const historyCache = new ChatHistoryCacheInvalidator(redis, config);
    const publishConversationEvent = jest.fn().mockResolvedValue(undefined);
    const realtime = {
      publishConversationEvent,
    } as unknown as ChatRealtimeService;
    const aiEngine: AiEngineClient = {
      request: jest.fn((req: AiEngineRequest) =>
        aiHandler(req),
      ) as unknown as AiEngineClient['request'],
      requestStream: jest.fn(),
    };
    const worker = new ChatDmAssistantWorkerService(
      config,
      retrieval,
      aiEngine,
      orgChecker,
      historyCache,
      realtime,
      connection,
    );
    worker.setRetryDelayOverrideMs(0);
    return {
      worker,
      redis,
      store,
      historyCache,
      publishConversationEvent,
      aiEngine,
    };
  }

  async function createFreshDirectDm(
    actor1 = userA,
    actor2 = userB,
  ): Promise<string> {
    const uniqueOrg = actor1.organizationId;
    const conv = await connection
      .db!.collection('chat_conversations')
      .insertOne({
        organizationId: new Types.ObjectId(uniqueOrg),
        type: 'DIRECT',
        directKey: `${uniqueOrg}:${randomUUID()}`,
        title: null,
        createdBy: actor1.id,
        lastMessageAt: null,
        lastMessageId: null,
        lastMessagePreview: '',
        lastMessageSenderId: null,
        membershipVersion: 0,
        contextRevision: 0,
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    const now = new Date();
    await connection.db!.collection('chat_members').insertMany([
      {
        organizationId: new Types.ObjectId(uniqueOrg),
        conversationId: conv.insertedId,
        userId: actor1.id,
        displayName: actor1.name,
        searchLabel: actor2.name,
        avatarUrl: null,
        role: 'OWNER',
        status: 'ACTIVE',
        notificationMode: 'ALL',
        draft: '',
        draftMentionUserIds: [],
        draftAssistantMention: false,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        organizationId: new Types.ObjectId(uniqueOrg),
        conversationId: conv.insertedId,
        userId: actor2.id,
        displayName: actor2.name,
        searchLabel: actor1.name,
        avatarUrl: null,
        role: 'MEMBER',
        status: 'ACTIVE',
        notificationMode: 'ALL',
        draft: '',
        draftMentionUserIds: [],
        draftAssistantMention: false,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    return conv.insertedId.toHexString();
  }

  it('enforces ACL deny matrix (C1, Manager ADMIN C2, cross-org C3), DIRECT-only, block 409, atomic trigger+job, and clientMessageId replay', async () => {
    const dmId = await createFreshDirectDm();
    const roomId = await nativeRepo.createRoom(
      userA,
      'Engineering Room',
      [toCandidate(userB), toCandidate(userC1)],
      randomUUID(),
    );

    // 1. ROOM member calling @continuumAI -> 422 CHAT_ASSISTANT_DIRECT_ONLY
    await expect(
      nativeRepo.sendMessage(
        userA,
        roomId,
        randomUUID(),
        '@continuumAI Tóm tắt phòng này?',
        [],
        undefined,
        [],
        {
          handle: CONTINUUM_AI_HANDLE,
          query: 'Tóm tắt phòng này?',
          timezone: 'Asia/Ho_Chi_Minh',
        },
      ),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'CHAT_ASSISTANT_DIRECT_ONLY' },
    });

    // 2. Non-members (C1, Org Manager C2, Cross-Org C3) all receive 404 CHAT_CONVERSATION_NOT_FOUND
    for (const outsider of [userC1, userC2Manager, userC3OtherOrg]) {
      await expect(
        nativeRepo.sendMessage(
          outsider,
          dmId,
          randomUUID(),
          '@continuumAI Leak?',
          [],
          undefined,
          [],
          {
            handle: CONTINUUM_AI_HANDLE,
            query: 'Leak?',
            timezone: 'Asia/Ho_Chi_Minh',
          },
        ),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'CHAT_CONVERSATION_NOT_FOUND' },
      });
      await expect(
        nativeRepo.listMessages(outsider, dmId, 20),
      ).rejects.toMatchObject({ status: 404 });
    }

    // 3. Blocked DM -> 409 CHAT_DIRECT_UNAVAILABLE
    await nativeRepo.setBlock(userB, userA.id, true);
    await expect(
      nativeRepo.sendMessage(
        userA,
        dmId,
        randomUUID(),
        '@continuumAI blocked?',
        [],
        undefined,
        [],
        {
          handle: CONTINUUM_AI_HANDLE,
          query: 'blocked?',
          timezone: 'Asia/Ho_Chi_Minh',
        },
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'CHAT_DIRECT_UNAVAILABLE' },
    });
    await nativeRepo.setBlock(userB, userA.id, false);

    // 4. Atomic trigger message + job creation and exact idempotent replay
    const clientMsgId = randomUUID();
    const sent = await nativeRepo.sendMessage(
      userA,
      dmId,
      clientMsgId,
      '@continuumAI Hôm qua chốt gì?',
      [],
      undefined,
      [],
      {
        handle: CONTINUUM_AI_HANDLE,
        query: 'Hôm qua chốt gì?',
        timezone: 'Asia/Ho_Chi_Minh',
      },
    );
    expect(sent.message.authorType).toBe('USER');
    expect(sent.message.assistantState?.status).toBe('PENDING');
    expect(sent.assistantStatusEvent?.status).toBe('PENDING');
    expect(sent.recipientIds.sort()).toEqual([userA.id, userB.id].sort());

    const replay = await nativeRepo.sendMessage(
      userA,
      dmId,
      clientMsgId,
      '@continuumAI Hôm qua chốt gì?',
      [],
      undefined,
      [],
      {
        handle: CONTINUUM_AI_HANDLE,
        query: 'Hôm qua chốt gì?',
        timezone: 'Asia/Ho_Chi_Minh',
      },
    );
    expect(replay.message.id).toBe(sent.message.id);
    expect(replay.assistantStatusEvent).toBeUndefined();

    const jobsCount = await connection
      .db!.collection(CHAT_ASSISTANT_JOBS_COLLECTION)
      .countDocuments({
        triggerMessageId: new Types.ObjectId(sent.message.id),
      });
    expect(jobsCount).toBe(1);

    // 5. Conflicting replay (different query OR omitted assistantMention) -> 409 CHAT_IDEMPOTENCY_CONFLICT
    await expect(
      nativeRepo.sendMessage(
        userA,
        dmId,
        clientMsgId,
        '@continuumAI Hôm qua chốt gì?',
        [],
        undefined,
        [],
        {
          handle: CONTINUUM_AI_HANDLE,
          query: 'Different query',
          timezone: 'Asia/Ho_Chi_Minh',
        },
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'CHAT_IDEMPOTENCY_CONFLICT' },
    });
    await expect(
      nativeRepo.sendMessage(
        userA,
        dmId,
        clientMsgId,
        '@continuumAI Hôm qua chốt gì?',
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'CHAT_IDEMPOTENCY_CONFLICT' },
    });

    // Clean up pending job so it doesn't interfere with later worker tests
    await connection.db!.collection(CHAT_ASSISTANT_JOBS_COLLECTION).deleteMany({
      conversationId: new Types.ObjectId(dmId),
    });
  });

  it('retrieves time-window (yesterday), unaccented Vietnamese + PAY-123 + ±2 correction neighbors, excludes other convs/AI/deleted, and publishes grounded reply', async () => {
    const dmId = await createFreshDirectDm();
    const otherDmId = await createFreshDirectDm(userA, userC1);
    const messagesColl = connection.db!.collection(
      'chat_conversation_messages',
    );

    // Anchor: 2026-11-28T09:00:00Z (16:00 Asia/Ho_Chi_Minh)
    // Yesterday in Asia/Ho_Chi_Minh: 2026-11-26T17:00:00Z .. 2026-11-27T16:59:59.999Z
    const oldDecisionId = new Types.ObjectId();
    const payInitialId = new Types.ObjectId();
    const payAckId = new Types.ObjectId();
    const payCorrectionId = new Types.ObjectId();
    const yesterdayDecisionId = new Types.ObjectId();
    const deletedMsgId = new Types.ObjectId();
    const priorAiId = new Types.ObjectId();
    const leakOtherDmId = new Types.ObjectId();

    // Insert 55 older filler messages so oldDecisionId is strictly off-page (> 50 msgs back)
    const baseTime = new Date('2026-11-10T03:00:00.000Z').getTime();
    const fillerDocs = Array.from({ length: 55 }, (_, i) => ({
      _id: new Types.ObjectId(),
      organizationId: new Types.ObjectId(org1Id),
      conversationId: new Types.ObjectId(dmId),
      senderId: i % 2 === 0 ? userA.id : userB.id,
      senderName: i % 2 === 0 ? userA.name : userB.name,
      senderAvatarUrl: null,
      clientMessageId: randomUUID(),
      content: `Tin trao đổi chung số ${i + 1} về tiến độ sprint.`,
      mentionUserIds: [],
      links: [],
      isPinned: false,
      editedAt: null,
      deletedAt: null,
      reactions: [],
      replyToMessageId: null,
      attachments: [],
      contentVersion: 0,
      createdAt: new Date(baseTime + (i + 1) * 60_000),
      updatedAt: new Date(baseTime + (i + 1) * 60_000),
    }));

    await messagesColl.insertMany([
      {
        _id: oldDecisionId,
        organizationId: new Types.ObjectId(org1Id),
        conversationId: new Types.ObjectId(dmId),
        senderId: userA.id,
        senderName: userA.name,
        senderAvatarUrl: null,
        clientMessageId: randomUUID(),
        content: 'Quyết định kiến trúc ARCH-01: dùng MongoDB per-service.',
        mentionUserIds: [],
        links: [],
        isPinned: false,
        editedAt: null,
        deletedAt: null,
        reactions: [],
        replyToMessageId: null,
        attachments: [],
        contentVersion: 0,
        createdAt: new Date(baseTime),
        updatedAt: new Date(baseTime),
      },
      ...fillerDocs,
      // PAY-123 sequence: initial -> short ack -> correction (correction does NOT repeat PAY-123!)
      {
        _id: payInitialId,
        organizationId: new Types.ObjectId(org1Id),
        conversationId: new Types.ObjectId(dmId),
        senderId: userA.id,
        senderName: userA.name,
        senderAvatarUrl: null,
        clientMessageId: randomUUID(),
        content: 'Deadline của PAY-123 tạm đặt thứ Tư 26/11 nhé.',
        mentionUserIds: [],
        links: [],
        isPinned: false,
        editedAt: null,
        deletedAt: null,
        reactions: [],
        replyToMessageId: null,
        attachments: [],
        contentVersion: 0,
        createdAt: new Date('2026-11-25T04:00:00.000Z'),
        updatedAt: new Date('2026-11-25T04:00:00.000Z'),
      },
      {
        _id: payAckId,
        organizationId: new Types.ObjectId(org1Id),
        conversationId: new Types.ObjectId(dmId),
        senderId: userB.id,
        senderName: userB.name,
        senderAvatarUrl: null,
        clientMessageId: randomUUID(),
        content: 'ok chốt nhé',
        mentionUserIds: [],
        links: [],
        isPinned: false,
        editedAt: null,
        deletedAt: null,
        reactions: [],
        replyToMessageId: null,
        attachments: [],
        contentVersion: 0,
        createdAt: new Date('2026-11-25T04:01:00.000Z'),
        updatedAt: new Date('2026-11-25T04:01:00.000Z'),
      },
      {
        _id: payCorrectionId,
        organizationId: new Types.ObjectId(org1Id),
        conversationId: new Types.ObjectId(dmId),
        senderId: userA.id,
        senderName: userA.name,
        senderAvatarUrl: null,
        clientMessageId: randomUUID(),
        content: 'Đính chính: dời sang thứ Sáu 29/11 lúc 17:00 nhé.',
        mentionUserIds: [],
        links: [],
        isPinned: false,
        editedAt: null,
        deletedAt: null,
        reactions: [],
        replyToMessageId: null,
        attachments: [],
        contentVersion: 0,
        createdAt: new Date('2026-11-25T04:02:00.000Z'),
        updatedAt: new Date('2026-11-25T04:02:00.000Z'),
      },
      // Yesterday message (2026-11-27 15:15 Asia/Ho_Chi_Minh = 2026-11-27T08:15:00Z)
      {
        _id: yesterdayDecisionId,
        organizationId: new Types.ObjectId(org1Id),
        conversationId: new Types.ObjectId(dmId),
        senderId: userB.id,
        senderName: userB.name,
        senderAvatarUrl: null,
        clientMessageId: randomUUID(),
        content: 'Chốt triển khai module thanh toán vào sáng thứ Hai.',
        mentionUserIds: [],
        links: [],
        isPinned: false,
        editedAt: null,
        deletedAt: null,
        reactions: [],
        replyToMessageId: null,
        attachments: [],
        contentVersion: 0,
        createdAt: new Date('2026-11-27T08:15:00.000Z'),
        updatedAt: new Date('2026-11-27T08:15:00.000Z'),
      },
      // Deleted message yesterday (MUST be excluded!)
      {
        _id: deletedMsgId,
        organizationId: new Types.ObjectId(org1Id),
        conversationId: new Types.ObjectId(dmId),
        senderId: userA.id,
        senderName: userA.name,
        senderAvatarUrl: null,
        clientMessageId: randomUUID(),
        content: 'SECRET-DELETED-PAY-123',
        mentionUserIds: [],
        links: [],
        isPinned: false,
        editedAt: null,
        deletedAt: new Date('2026-11-27T08:20:00.000Z'),
        reactions: [],
        replyToMessageId: null,
        attachments: [],
        contentVersion: 1,
        createdAt: new Date('2026-11-27T08:18:00.000Z'),
        updatedAt: new Date('2026-11-27T08:20:00.000Z'),
      },
      // Prior AI reply yesterday (MUST be excluded from AI retrieval!)
      {
        _id: priorAiId,
        organizationId: new Types.ObjectId(org1Id),
        conversationId: new Types.ObjectId(dmId),
        senderId: CONTINUUM_AI_SENDER_ID,
        senderName: CONTINUUM_AI_DISPLAY_NAME,
        senderAvatarUrl: null,
        clientMessageId: `assistant:${new Types.ObjectId().toHexString()}`,
        content: 'PRIOR-AI-PAY-123 should never be re-retrieved',
        mentionUserIds: [],
        links: [],
        isPinned: false,
        editedAt: null,
        deletedAt: null,
        reactions: [],
        replyToMessageId: null,
        attachments: [],
        contentVersion: 0,
        authorType: 'ASSISTANT',
        triggerMessageId: new Types.ObjectId(),
        assistantStatus: 'INSUFFICIENT_EVIDENCE',
        assistantFailureCode: null,
        sourceReferences: [],
        createdAt: new Date('2026-11-27T09:00:00.000Z'),
        updatedAt: new Date('2026-11-27T09:00:00.000Z'),
      },
      // Canary message in ANOTHER DM (A–C1) containing PAY-123 & yesterday timestamp (MUST NEVER LEAK!)
      {
        _id: leakOtherDmId,
        organizationId: new Types.ObjectId(org1Id),
        conversationId: new Types.ObjectId(otherDmId),
        senderId: userC1.id,
        senderName: userC1.name,
        senderAvatarUrl: null,
        clientMessageId: randomUUID(),
        content: 'CANARY-LEAK-C1 PAY-123 bí mật của C',
        mentionUserIds: [],
        links: [],
        isPinned: false,
        editedAt: null,
        deletedAt: null,
        reactions: [],
        replyToMessageId: null,
        attachments: [],
        contentVersion: 0,
        createdAt: new Date('2026-11-27T08:30:00.000Z'),
        updatedAt: new Date('2026-11-27T08:30:00.000Z'),
      },
    ]);

    const triggerNow = new Date('2026-11-28T09:00:00.000Z');
    const dummyTriggerId = new Types.ObjectId();

    // A. Unaccented Vietnamese keyword + code query -> retrieves PAY-123 + ±2 correction neighbors, ZERO leaks!
    const kwResult = await retrieval.retrieveContext({
      organizationId: new Types.ObjectId(org1Id),
      conversationId: new Types.ObjectId(dmId),
      triggerMessageId: dummyTriggerId,
      triggerCreatedAt: triggerNow,
      question: 'Deadline cua PAY-123 la khi nao?',
      timezone: 'Asia/Ho_Chi_Minh',
      maxMessages: 80,
      maxChars: 24_000,
    });
    expect(kwResult.queryMode).toBe('KEYWORD');
    const kwIds = kwResult.messages.map((m) => String(m.messageId));
    expect(kwIds).toContain(String(payInitialId));
    expect(kwIds).toContain(String(payAckId));
    expect(kwIds).toContain(String(payCorrectionId));
    expect(kwIds).not.toContain(String(deletedMsgId));
    expect(kwIds).not.toContain(String(priorAiId));
    expect(kwIds).not.toContain(String(leakOtherDmId));

    // B. Time-window query (unaccented "hom qua") -> retrieves ONLY yesterday's eligible human message
    const twResult = await retrieval.retrieveContext({
      organizationId: new Types.ObjectId(org1Id),
      conversationId: new Types.ObjectId(dmId),
      triggerMessageId: dummyTriggerId,
      triggerCreatedAt: triggerNow,
      question: 'hom qua hai nguoi chot nhung gi?',
      timezone: 'Asia/Ho_Chi_Minh',
      maxMessages: 80,
      maxChars: 24_000,
    });
    expect(twResult.queryMode).toBe('TIME_WINDOW');
    expect(twResult.messages.map((m) => String(m.messageId))).toEqual([
      String(yesterdayDecisionId),
    ]);

    // C. Off-page old message (> 50 msgs back) retrieved & jumpable via messagesAround for A/B, 404 for C1/C2/C3!
    const archResult = await retrieval.retrieveContext({
      organizationId: new Types.ObjectId(org1Id),
      conversationId: new Types.ObjectId(dmId),
      triggerMessageId: dummyTriggerId,
      triggerCreatedAt: triggerNow,
      question: 'Quyet dinh kien truc ARCH-01 la gi?',
      timezone: 'Asia/Ho_Chi_Minh',
      maxMessages: 80,
      maxChars: 24_000,
    });
    expect(archResult.messages.map((m) => String(m.messageId))).toContain(
      String(oldDecisionId),
    );
    const aroundA = await nativeRepo.messagesAround(
      userA,
      dmId,
      String(oldDecisionId),
      5,
    );
    expect(aroundA.data.some((m) => m.id === String(oldDecisionId))).toBe(true);
    await expect(
      nativeRepo.messagesAround(userC2Manager, dmId, String(oldDecisionId), 5),
    ).rejects.toMatchObject({ status: 404 });

    // D. Unrelated topic -> empty context (0 matches)
    const emptyResult = await retrieval.retrieveContext({
      organizationId: new Types.ObjectId(org1Id),
      conversationId: new Types.ObjectId(dmId),
      triggerMessageId: dummyTriggerId,
      triggerCreatedAt: triggerNow,
      question: 'Mật khẩu server staging là gì?',
      timezone: 'Asia/Ho_Chi_Minh',
      maxMessages: 80,
      maxChars: 24_000,
    });
    expect(emptyResult.messages).toHaveLength(0);
  });

  it('prevents duplicate AI replies under 2-worker concurrency and crash-recovery E11000, and verifies post-publish EDITED/DELETED source enrichment & Redis cache invalidation', async () => {
    const dmId = await createFreshDirectDm();
    const { redis } = createInMemoryRedis();
    const cachedRepo = cachedChatRepository(nativeRepo, redis, 'test-dm');

    // Draft round-trip with assistantMention through cachedChatRepository
    await cachedRepo.saveDraft(userA, dmId, '@continuumAI PAY-123', [], true);
    expect((await cachedRepo.getDraft(userA, dmId)).assistantMention).toBe(
      true,
    );

    // Seed two source messages
    const src1 = await cachedRepo.sendMessage(
      userA,
      dmId,
      randomUUID(),
      'Deadline của PAY-500 là thứ Sáu 29/11.',
    );
    const src2 = await cachedRepo.sendMessage(
      userB,
      dmId,
      randomUUID(),
      'Xác nhận PAY-500 hoàn thành trước 17:00 nhé.',
    );

    const trigger = await cachedRepo.sendMessage(
      userA,
      dmId,
      randomUUID(),
      '@continuumAI Deadline PAY-500 là khi nào?',
      [],
      undefined,
      [],
      {
        handle: CONTINUUM_AI_HANDLE,
        query: 'Deadline PAY-500 là khi nào?',
        timezone: 'Asia/Ho_Chi_Minh',
      },
    );

    const sagHandler = (req: AiEngineRequest) => {
      const body = req.body as SagDmAssistantAnswerRequest;
      expect(body.messages.length).toBeGreaterThanOrEqual(2);
      return Promise.resolve({
        status: 200,
        body: {
          status: 'ANSWERED' as const,
          answerText: 'Deadline PAY-500 là 17:00 thứ Sáu 29/11 [M1][M2].',
          citedRefIds: ['M1', 'M2'],
          coverageNote: null,
          model: 'test-model',
          usage: {
            inputTokens: 200,
            cachedTokens: 0,
            outputTokens: 40,
            totalTokens: 240,
            calls: 1,
          },
        },
      });
    };

    const w1 = createWorker(sagHandler);
    const w2 = createWorker(sagHandler);

    // 2 workers racing concurrently on the exact same pending job!
    const [r1, r2] = await Promise.all([
      w1.worker.processJobById(
        trigger.message.assistantState!.jobId,
        'worker-1',
      ),
      w2.worker.processJobById(
        trigger.message.assistantState!.jobId,
        'worker-2',
      ),
    ]);
    const outcomes = [r1.outcome, r2.outcome].sort();
    expect(outcomes).toEqual(['COMPLETED', 'IDLE']);

    const aiReplyId = (r1.responseMessageId ?? r2.responseMessageId)!;
    expect(aiReplyId).toBeTruthy();

    const aiCount = await connection
      .db!.collection('chat_conversation_messages')
      .countDocuments({
        conversationId: new Types.ObjectId(dmId),
        authorType: 'ASSISTANT',
        triggerMessageId: new Types.ObjectId(trigger.message.id),
      });
    expect(aiCount).toBe(1);

    // Verify WS message.created + assistant.status emitted ONLY to active members [A, B]
    const winner = r1.outcome === 'COMPLETED' ? w1 : w2;
    const rawCalls = winner.publishConversationEvent.mock.calls as [
      string,
      string,
      string,
      string[],
      unknown,
    ][];
    const emittedEvents = rawCalls.map((call) => ({
      event: call[0],
      recipients: [...call[3]].sort(),
    }));
    expect(emittedEvents).toContainEqual({
      event: 'message.created',
      recipients: [userA.id, userB.id].sort(),
    });
    expect(emittedEvents).toContainEqual({
      event: 'assistant.status',
      recipients: [userA.id, userB.id].sort(),
    });

    // Verify AI immutability (403) and forward block (422), while reactions & pin succeed
    await expect(
      cachedRepo.editMessage(userA, dmId, aiReplyId, 'Tampered'),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'CHAT_ASSISTANT_MESSAGE_IMMUTABLE' },
    });
    await expect(
      cachedRepo.deleteMessage(userB, dmId, aiReplyId),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'CHAT_ASSISTANT_MESSAGE_IMMUTABLE' },
    });
    const otherDm = await createFreshDirectDm(userA, userC1);
    await expect(
      cachedRepo.forwardMessage(userA, otherDm, dmId, aiReplyId, randomUUID()),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'CHAT_ASSISTANT_FORWARD_FORBIDDEN' },
    });
    const reacted = await cachedRepo.setReaction(
      userB,
      dmId,
      aiReplyId,
      '👍',
      true,
    );
    expect(reacted.message.reactions[0]).toMatchObject({
      emoji: '👍',
      count: 1,
      reactedByMe: true,
    });
    await expect(
      cachedRepo.pinMessage(userA, dmId, aiReplyId, true),
    ).resolves.toBeUndefined();

    // Prime Redis cache with ACTIVE source status
    const pageActive = await cachedRepo.listMessages(userB, dmId, 20);
    const aiActive = pageActive.data.find((m) => m.id === aiReplyId)!;
    expect(aiActive.authorType).toBe('ASSISTANT');
    expect(aiActive.assistantStatus).toBe('COMPLETED');
    expect(aiActive.assistantMeta?.sourceState).toBe('FRESH');
    expect(aiActive.sourceReferences?.map((r) => r.status)).toEqual([
      'ACTIVE',
      'ACTIVE',
    ]);

    // Edit src1 -> cachedRepo MUST immediately return EDITED (no stale ACTIVE from Redis cache!)
    await cachedRepo.editMessage(
      userA,
      dmId,
      src1.message.id,
      'Deadline PAY-500 dời sang 02/12.',
    );
    const pageEdited = await cachedRepo.listMessages(userB, dmId, 20);
    const aiEdited = pageEdited.data.find((m) => m.id === aiReplyId)!;
    expect(aiEdited.content).toBe(aiActive.content); // Posted answer stays intact
    expect(aiEdited.sourceReferences?.[0].status).toBe('EDITED');
    expect(aiEdited.sourceReferences?.[1].status).toBe('ACTIVE');
    expect(aiEdited.assistantMeta?.sourceState).toBe('HAS_EDITED');

    // Delete src2 -> cachedRepo MUST immediately return DELETED with quoteSnippet === '' and HAS_EDITED_AND_DELETED!
    const convBeforeDelete = await connection
      .db!.collection('chat_conversations')
      .findOne({ _id: new Types.ObjectId(dmId) });
    const revBeforeDelete = Number(convBeforeDelete?.contextRevision ?? 0);

    await cachedRepo.deleteMessage(userB, dmId, src2.message.id);

    const convAfterFirstDelete = await connection
      .db!.collection('chat_conversations')
      .findOne({ _id: new Types.ObjectId(dmId) });
    expect(convAfterFirstDelete?.contextRevision).toBe(revBeforeDelete + 1);

    // Idempotent repeat delete MUST NOT bump contextRevision or contentVersion!
    await cachedRepo.deleteMessage(userB, dmId, src2.message.id);
    const convAfterRepeatDelete = await connection
      .db!.collection('chat_conversations')
      .findOne({ _id: new Types.ObjectId(dmId) });
    expect(convAfterRepeatDelete?.contextRevision).toBe(revBeforeDelete + 1);
    const src2Doc = await connection
      .db!.collection('chat_conversation_messages')
      .findOne({ _id: new Types.ObjectId(src2.message.id) });
    expect(src2Doc?.contentVersion).toBe(1);

    const pageDeleted = await cachedRepo.listMessages(userA, dmId, 20);
    const aiDeleted = pageDeleted.data.find((m) => m.id === aiReplyId)!;
    expect(aiDeleted.sourceReferences?.[0].status).toBe('EDITED');
    expect(aiDeleted.sourceReferences?.[1].status).toBe('DELETED');
    expect(aiDeleted.sourceReferences?.[1].quoteSnippet).toBe('');
    expect(aiDeleted.assistantMeta?.sourceState).toBe('HAS_EDITED_AND_DELETED');

    // Crash-recovery & unique partial index E11000 enforcement:
    // 1. Direct duplicate insert for same (conversationId, triggerMessageId) MUST fail with MongoDB E11000
    await expect(
      connection.db!.collection('chat_conversation_messages').insertOne({
        organizationId: new Types.ObjectId(org1Id),
        conversationId: new Types.ObjectId(dmId),
        senderId: CONTINUUM_AI_SENDER_ID,
        senderName: CONTINUUM_AI_DISPLAY_NAME,
        senderAvatarUrl: null,
        clientMessageId: `assistant-dup:${randomUUID()}`,
        content: 'Duplicate attempt',
        mentionUserIds: [],
        links: [],
        isPinned: false,
        editedAt: null,
        deletedAt: null,
        reactions: [],
        replyToMessageId: new Types.ObjectId(trigger.message.id),
        attachments: [],
        contentVersion: 0,
        authorType: 'ASSISTANT',
        triggerMessageId: new Types.ObjectId(trigger.message.id),
        assistantStatus: 'COMPLETED',
        assistantFailureCode: null,
        sourceReferences: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 11000 });

    // 2. Crash-recovery reconciliation when job resets to PENDING while AI reply already exists
    await connection.db!.collection(CHAT_ASSISTANT_JOBS_COLLECTION).updateOne(
      { _id: new Types.ObjectId(trigger.message.assistantState!.jobId) },
      {
        $set: {
          status: 'PENDING',
          attempts: 0,
          lockedBy: null,
          lockedUntil: null,
          responseMessageId: null,
          completedAt: null,
        },
      },
    );
    const wRecovery = createWorker(() =>
      Promise.resolve({
        status: 200,
        body: {
          status: 'ANSWERED',
          answerText: 'Recovered answer [M1].',
          citedRefIds: ['M1'],
          coverageNote: null,
          model: 'test-model',
          usage: {
            inputTokens: 100,
            cachedTokens: 0,
            outputTokens: 20,
            totalTokens: 120,
            calls: 1,
          },
        },
      }),
    );
    const recovered = await wRecovery.worker.processJobById(
      trigger.message.assistantState!.jobId,
      'worker-recovery',
    );
    expect(recovered.outcome).toBe('COMPLETED');
    expect(recovered.responseMessageId).toBe(aiReplyId);
    expect(
      await connection
        .db!.collection('chat_conversation_messages')
        .countDocuments({
          conversationId: new Types.ObjectId(dmId),
          authorType: 'ASSISTANT',
          triggerMessageId: new Types.ObjectId(trigger.message.id),
        }),
    ).toBe(1);
  });

  it('handles mid-flight trigger edit/delete, source edit/delete, unrelated edit fence retry, and IAM org revocation cleanly', async () => {
    // 1. Mid-flight trigger delete -> CANCELLED / TRIGGER_DELETED
    {
      const dmId = await createFreshDirectDm();
      await nativeRepo.sendMessage(
        userA,
        dmId,
        randomUUID(),
        'PAY-701 chốt thứ Hai.',
      );
      const trigger = await nativeRepo.sendMessage(
        userA,
        dmId,
        randomUUID(),
        '@continuumAI PAY-701 khi nào?',
        [],
        undefined,
        [],
        {
          handle: CONTINUUM_AI_HANDLE,
          query: 'PAY-701 khi nào?',
          timezone: 'Asia/Ho_Chi_Minh',
        },
      );
      const { worker } = createWorker(async () => {
        await nativeRepo.deleteMessage(userA, dmId, trigger.message.id);
        return {
          status: 200,
          body: {
            status: 'ANSWERED',
            answerText: 'PAY-701 thứ Hai [M1].',
            citedRefIds: ['M1'],
            coverageNote: null,
            model: 'm',
            usage: {
              inputTokens: 10,
              cachedTokens: 0,
              outputTokens: 5,
              totalTokens: 15,
              calls: 1,
            },
          },
        };
      });
      const res = await worker.processJobById(
        trigger.message.assistantState!.jobId,
      );
      expect(res).toMatchObject({
        outcome: 'CANCELLED',
        failureCode: 'TRIGGER_DELETED',
        responseMessageId: null,
      });
      expect(
        await connection
          .db!.collection('chat_conversation_messages')
          .countDocuments({
            conversationId: new Types.ObjectId(dmId),
            authorType: 'ASSISTANT',
          }),
      ).toBe(0);
    }

    // 2. Mid-flight trigger edit -> CANCELLED / SOURCE_CHANGED
    {
      const dmId = await createFreshDirectDm();
      await nativeRepo.sendMessage(
        userA,
        dmId,
        randomUUID(),
        'PAY-702 chốt thứ Ba.',
      );
      const trigger = await nativeRepo.sendMessage(
        userA,
        dmId,
        randomUUID(),
        '@continuumAI PAY-702 khi nào?',
        [],
        undefined,
        [],
        {
          handle: CONTINUUM_AI_HANDLE,
          query: 'PAY-702 khi nào?',
          timezone: 'Asia/Ho_Chi_Minh',
        },
      );
      const { worker } = createWorker(async () => {
        await nativeRepo.editMessage(
          userA,
          dmId,
          trigger.message.id,
          '@continuumAI Câu hỏi đã sửa',
        );
        return {
          status: 200,
          body: {
            status: 'ANSWERED',
            answerText: 'PAY-702 thứ Ba [M1].',
            citedRefIds: ['M1'],
            coverageNote: null,
            model: 'm',
            usage: {
              inputTokens: 10,
              cachedTokens: 0,
              outputTokens: 5,
              totalTokens: 15,
              calls: 1,
            },
          },
        };
      });
      const res = await worker.processJobById(
        trigger.message.assistantState!.jobId,
      );
      expect(res).toMatchObject({
        outcome: 'CANCELLED',
        failureCode: 'SOURCE_CHANGED',
        responseMessageId: null,
      });
    }

    // 3. Mid-flight source edit -> CANCELLED / SOURCE_CHANGED
    {
      const dmId = await createFreshDirectDm();
      const src = await nativeRepo.sendMessage(
        userA,
        dmId,
        randomUUID(),
        'PAY-703 chốt thứ Tư.',
      );
      const trigger = await nativeRepo.sendMessage(
        userA,
        dmId,
        randomUUID(),
        '@continuumAI PAY-703 khi nào?',
        [],
        undefined,
        [],
        {
          handle: CONTINUUM_AI_HANDLE,
          query: 'PAY-703 khi nào?',
          timezone: 'Asia/Ho_Chi_Minh',
        },
      );
      const { worker } = createWorker(async () => {
        await nativeRepo.editMessage(
          userA,
          dmId,
          src.message.id,
          'PAY-703 đổi sang thứ Năm.',
        );
        return {
          status: 200,
          body: {
            status: 'ANSWERED',
            answerText: 'PAY-703 thứ Tư [M1].',
            citedRefIds: ['M1'],
            coverageNote: null,
            model: 'm',
            usage: {
              inputTokens: 10,
              cachedTokens: 0,
              outputTokens: 5,
              totalTokens: 15,
              calls: 1,
            },
          },
        };
      });
      const res = await worker.processJobById(
        trigger.message.assistantState!.jobId,
      );
      expect(res).toMatchObject({
        outcome: 'CANCELLED',
        failureCode: 'SOURCE_CHANGED',
        responseMessageId: null,
      });
    }

    // 4. Mid-flight UNRELATED message edit bumps contextRevision -> fence retries & PUBLISHES cleanly!
    {
      const dmId = await createFreshDirectDm();
      const unrelated = await nativeRepo.sendMessage(
        userB,
        dmId,
        randomUUID(),
        'Trưa nay ăn bún bò nhé.',
      );
      // Insert 4 spacer messages so unrelated is outside ±2 neighbors of PAY-704
      for (let i = 0; i < 4; i += 1) {
        await nativeRepo.sendMessage(userA, dmId, randomUUID(), `Tin đệm ${i}`);
      }
      await nativeRepo.sendMessage(
        userA,
        dmId,
        randomUUID(),
        'PAY-704 chốt 10:00 thứ Sáu.',
      );
      const trigger = await nativeRepo.sendMessage(
        userA,
        dmId,
        randomUUID(),
        '@continuumAI PAY-704 khi nào?',
        [],
        undefined,
        [],
        {
          handle: CONTINUUM_AI_HANDLE,
          query: 'PAY-704 khi nào?',
          timezone: 'Asia/Ho_Chi_Minh',
        },
      );
      const { worker } = createWorker(async (req) => {
        const body = req.body as SagDmAssistantAnswerRequest;
        const payRef = body.messages.find((m) => m.text.includes('PAY-704'))!;
        // Edit unrelated message outside sentMessages while SAG is running!
        await nativeRepo.editMessage(
          userB,
          dmId,
          unrelated.message.id,
          'Trưa nay ăn phở nhé.',
        );
        return {
          status: 200,
          body: {
            status: 'ANSWERED',
            answerText: `PAY-704 chốt 10:00 thứ Sáu [${payRef.refId}].`,
            citedRefIds: [payRef.refId],
            coverageNote: null,
            model: 'm',
            usage: {
              inputTokens: 10,
              cachedTokens: 0,
              outputTokens: 5,
              totalTokens: 15,
              calls: 1,
            },
          },
        };
      });
      const res = await worker.processJobById(
        trigger.message.assistantState!.jobId,
      );
      expect(res.outcome).toBe('COMPLETED');
      expect(res.responseMessageId).toBeTruthy();
    }

    // 5. Mid-flight IAM organization revocation (real MongoChatOrgMembershipChecker against continuum_iam!) -> CANCELLED / ACCESS_REVOKED
    {
      const tempUser = makeActor('Revoked Mid-Flight', org1Id);
      await seedIamActiveUser(org1Id, tempUser.id);
      const dmId = await createFreshDirectDm(tempUser, userB);
      await nativeRepo.sendMessage(
        userB,
        dmId,
        randomUUID(),
        'PAY-705 chốt thứ Hai.',
      );
      const trigger = await nativeRepo.sendMessage(
        tempUser,
        dmId,
        randomUUID(),
        '@continuumAI PAY-705 khi nào?',
        [],
        undefined,
        [],
        {
          handle: CONTINUUM_AI_HANDLE,
          query: 'PAY-705 khi nào?',
          timezone: 'Asia/Ho_Chi_Minh',
        },
      );
      const { worker } = createWorker(async () => {
        // Revoke org membership in continuum_iam mid-flight!
        const iamDb = connection.useDb(SERVICE_DATABASES.iam, {
          useCache: true,
        }).db!;
        await iamDb.collection('organization_memberships').updateOne(
          {
            organizationId: new Types.ObjectId(org1Id),
            userId: new Types.ObjectId(tempUser.id),
          },
          { $set: { status: 'REMOVED' } },
        );
        return {
          status: 200,
          body: {
            status: 'ANSWERED',
            answerText: 'Should never publish [M1].',
            citedRefIds: ['M1'],
            coverageNote: null,
            model: 'm',
            usage: {
              inputTokens: 10,
              cachedTokens: 0,
              outputTokens: 5,
              totalTokens: 15,
              calls: 1,
            },
          },
        };
      });
      const res = await worker.processJobById(
        trigger.message.assistantState!.jobId,
      );
      expect(res).toMatchObject({
        outcome: 'CANCELLED',
        failureCode: 'ACCESS_REVOKED',
        responseMessageId: null,
      });
      const jobDoc = (await connection
        .db!.collection(CHAT_ASSISTANT_JOBS_COLLECTION)
        .findOne({
          _id: new Types.ObjectId(trigger.message.assistantState!.jobId),
        })) as AssistantJobDocument | null;
      expect(jobDoc?.status).toBe('CANCELLED');
      expect(jobDoc?.attempts).toBe(1); // Never retried!
    }

    // 6. Mid-flight source deleted -> CANCELLED / SOURCE_CHANGED
    {
      const dmId = await createFreshDirectDm();
      const src = await nativeRepo.sendMessage(
        userA,
        dmId,
        randomUUID(),
        'PAY-706 chốt thứ Sáu.',
      );
      const trigger = await nativeRepo.sendMessage(
        userA,
        dmId,
        randomUUID(),
        '@continuumAI PAY-706 khi nào?',
        [],
        undefined,
        [],
        {
          handle: CONTINUUM_AI_HANDLE,
          query: 'PAY-706 khi nào?',
          timezone: 'Asia/Ho_Chi_Minh',
        },
      );
      const { worker } = createWorker(async () => {
        await nativeRepo.deleteMessage(userA, dmId, src.message.id);
        return {
          status: 200,
          body: {
            status: 'ANSWERED',
            answerText: 'PAY-706 thứ Sáu [M1].',
            citedRefIds: ['M1'],
            coverageNote: null,
            model: 'm',
            usage: {
              inputTokens: 10,
              cachedTokens: 0,
              outputTokens: 5,
              totalTokens: 15,
              calls: 1,
            },
          },
        };
      });
      expect(
        await worker.processJobById(trigger.message.assistantState!.jobId),
      ).toMatchObject({
        outcome: 'CANCELLED',
        failureCode: 'SOURCE_CHANGED',
        responseMessageId: null,
      });
    }

    // 7. Mid-flight block -> CANCELLED / ACCESS_REVOKED
    {
      const dmId = await createFreshDirectDm();
      await nativeRepo.sendMessage(
        userB,
        dmId,
        randomUUID(),
        'PAY-707 chốt 09:00.',
      );
      const trigger = await nativeRepo.sendMessage(
        userA,
        dmId,
        randomUUID(),
        '@continuumAI PAY-707 khi nào?',
        [],
        undefined,
        [],
        {
          handle: CONTINUUM_AI_HANDLE,
          query: 'PAY-707 khi nào?',
          timezone: 'Asia/Ho_Chi_Minh',
        },
      );
      const { worker } = createWorker(async () => {
        await nativeRepo.setBlock(userB, userA.id, true);
        return {
          status: 200,
          body: {
            status: 'ANSWERED',
            answerText: 'PAY-707 09:00 [M1].',
            citedRefIds: ['M1'],
            coverageNote: null,
            model: 'm',
            usage: {
              inputTokens: 10,
              cachedTokens: 0,
              outputTokens: 5,
              totalTokens: 15,
              calls: 1,
            },
          },
        };
      });
      try {
        expect(
          await worker.processJobById(trigger.message.assistantState!.jobId),
        ).toMatchObject({
          outcome: 'CANCELLED',
          failureCode: 'ACCESS_REVOKED',
          responseMessageId: null,
        });
      } finally {
        await nativeRepo.setBlock(userB, userA.id, false);
      }
    }

    // 8. INSUFFICIENT_EVIDENCE end-to-end saved cleanly & visible to both A and B
    {
      const dmId = await createFreshDirectDm();
      const trigger = await nativeRepo.sendMessage(
        userA,
        dmId,
        randomUUID(),
        '@continuumAI Mật khẩu server staging là gì?',
        [],
        undefined,
        [],
        {
          handle: CONTINUUM_AI_HANDLE,
          query: 'Mật khẩu server staging là gì?',
          timezone: 'Asia/Ho_Chi_Minh',
        },
      );
      const { worker } = createWorker((req) => {
        const body = req.body as SagDmAssistantAnswerRequest;
        expect(body.messages).toEqual([]);
        return Promise.resolve({
          status: 200,
          body: {
            status: 'INSUFFICIENT_EVIDENCE',
            answerText:
              'Chưa tìm thấy tin nhắn phù hợp trong cuộc trò chuyện này để trả lời câu hỏi của bạn.',
            citedRefIds: [],
            coverageNote: null,
            model: null,
            usage: {
              inputTokens: 0,
              cachedTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              calls: 0,
            },
          },
        });
      });
      const res = await worker.processJobById(
        trigger.message.assistantState!.jobId,
      );
      expect(res.outcome).toBe('INSUFFICIENT_EVIDENCE');
      expect(res.responseMessageId).toBeTruthy();

      const pageB = await nativeRepo.listMessages(userB, dmId, 10);
      const insufficientMsg = pageB.data.find(
        (m) => m.id === res.responseMessageId,
      );
      expect(insufficientMsg).toMatchObject({
        authorType: 'ASSISTANT',
        assistantStatus: 'INSUFFICIENT_EVIDENCE',
        sourceReferences: [],
        assistantMeta: expect.objectContaining({
          sourceState: 'FRESH',
        }) as unknown,
      });
    }
  });

  it('retries transient TIMEOUT/503/fabricated-refId up to maxAttempts and fails immediately on non-retryable AUTH_FAILED', async () => {
    // 1. Timeout retries (maxAttempts=2) -> RETRY_SCHEDULED then FAILED/TIMEOUT
    {
      const dmId = await createFreshDirectDm();
      await nativeRepo.sendMessage(userA, dmId, randomUUID(), 'PAY-801 test.');
      const trigger = await nativeRepo.sendMessage(
        userA,
        dmId,
        randomUUID(),
        '@continuumAI PAY-801?',
        [],
        undefined,
        [],
        {
          handle: CONTINUUM_AI_HANDLE,
          query: 'PAY-801?',
          timezone: 'Asia/Ho_Chi_Minh',
          maxAttempts: 2,
        },
      );
      const { worker } = createWorker(() =>
        Promise.reject(
          new GatewayTimeoutException({
            code: 'AI_ENGINE_TIMEOUT',
            message: 'Timed out',
          }),
        ),
      );
      const jobId = trigger.message.assistantState!.jobId;
      expect((await worker.processJobById(jobId)).outcome).toBe(
        'RETRY_SCHEDULED',
      );
      expect(await worker.processJobById(jobId)).toMatchObject({
        outcome: 'FAILED',
        failureCode: 'TIMEOUT',
      });
    }

    // 2. Fabricated unknown refId ('M999') -> rejected -> FAILED / INVALID_MODEL_OUTPUT, 0 AI messages
    {
      const dmId = await createFreshDirectDm();
      await nativeRepo.sendMessage(userA, dmId, randomUUID(), 'PAY-802 test.');
      const trigger = await nativeRepo.sendMessage(
        userA,
        dmId,
        randomUUID(),
        '@continuumAI PAY-802?',
        [],
        undefined,
        [],
        {
          handle: CONTINUUM_AI_HANDLE,
          query: 'PAY-802?',
          timezone: 'Asia/Ho_Chi_Minh',
          maxAttempts: 1,
        },
      );
      const { worker } = createWorker(() =>
        Promise.resolve({
          status: 200,
          body: {
            status: 'ANSWERED',
            answerText: 'Fabricated citation [M999].',
            citedRefIds: ['M999'],
            coverageNote: null,
            model: 'm',
            usage: {
              inputTokens: 10,
              cachedTokens: 0,
              outputTokens: 5,
              totalTokens: 15,
              calls: 1,
            },
          },
        }),
      );
      const res = await worker.processJobById(
        trigger.message.assistantState!.jobId,
      );
      expect(res).toMatchObject({
        outcome: 'FAILED',
        failureCode: 'INVALID_MODEL_OUTPUT',
      });
      const storedCount = await connection
        .db!.collection('chat_conversation_messages')
        .countDocuments({
          conversationId: new Types.ObjectId(dmId),
          authorType: 'ASSISTANT',
        });
      expect(storedCount).toBe(0);
    }

    // 3. Upstream 503 -> retryable SERVICE_UNAVAILABLE; 403 AUTH_FAILED -> non-retryable immediate FAILED/SERVICE_UNAVAILABLE
    {
      const dmId = await createFreshDirectDm();
      await nativeRepo.sendMessage(userA, dmId, randomUUID(), 'PAY-803 test.');
      const t503 = await nativeRepo.sendMessage(
        userA,
        dmId,
        randomUUID(),
        '@continuumAI PAY-803 503?',
        [],
        undefined,
        [],
        {
          handle: CONTINUUM_AI_HANDLE,
          query: 'PAY-803 503?',
          timezone: 'Asia/Ho_Chi_Minh',
          maxAttempts: 2,
        },
      );
      const w503 = createWorker(() =>
        Promise.reject(
          new ServiceUnavailableException({
            code: 'AI_ENGINE_UNAVAILABLE',
            message: 'LLM unavailable',
          }),
        ),
      );
      expect(
        (await w503.worker.processJobById(t503.message.assistantState!.jobId))
          .outcome,
      ).toBe('RETRY_SCHEDULED');
      expect(
        await w503.worker.processJobById(t503.message.assistantState!.jobId),
      ).toMatchObject({
        outcome: 'FAILED',
        failureCode: 'SERVICE_UNAVAILABLE',
      });

      const tAuth = await nativeRepo.sendMessage(
        userA,
        dmId,
        randomUUID(),
        '@continuumAI PAY-803 auth?',
        [],
        undefined,
        [],
        {
          handle: CONTINUUM_AI_HANDLE,
          query: 'PAY-803 auth?',
          timezone: 'Asia/Ho_Chi_Minh',
          maxAttempts: 3,
        },
      );
      const wAuth = createWorker(() =>
        Promise.reject(
          new BadGatewayException({
            code: 'AI_ENGINE_AUTH_FAILED',
            message: 'Auth failed',
          }),
        ),
      );
      expect(
        await wAuth.worker.processJobById(tAuth.message.assistantState!.jobId),
      ).toMatchObject({
        outcome: 'FAILED',
        failureCode: 'SERVICE_UNAVAILABLE',
      });
      const authJob = (await connection
        .db!.collection(CHAT_ASSISTANT_JOBS_COLLECTION)
        .findOne({
          _id: new Types.ObjectId(tAuth.message.assistantState!.jobId),
        })) as AssistantJobDocument | null;
      expect(authJob?.attempts).toBe(1); // Non-retryable!
    }

    // Ensure MessageDocument type import is exercised
    const sampleCheck: Pick<MessageDocument, 'senderId'> = {
      senderId: CONTINUUM_AI_SENDER_ID,
    };
    expect(sampleCheck.senderId).toBe(CONTINUUM_AI_SENDER_ID);
  });
});
