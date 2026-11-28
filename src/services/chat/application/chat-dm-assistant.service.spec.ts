import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ChatApplicationService } from './chat.service';
import { ChatFeaturesService } from './chat-features.service';
import {
  buildSagDmAssistantPayload,
  CONTINUUM_AI_HANDLE,
  extractAssistantQuery,
  MAX_SAG_REQUEST_JSON_BYTES,
  type ChatOrgMembershipChecker,
} from './chat-dm-assistant.types';
import { Types, type Connection, type Model } from 'mongoose';
import type { AiEngineClient } from '../../../integrations/ai-engine/ai-engine.port';
import {
  DmAssistantRetrievalService,
  parseAssistantQuery,
} from './chat-dm-assistant-retrieval.service';
import type { MessageDocument } from '../infrastructure/mongodb/mongo-chat.repository';
import { ChatDmAssistantWorkerService } from './chat-dm-assistant.worker';
import type { ChatActor, ChatRepository } from './chat.repository';
import type { ChatIamClient } from './chat-iam.client';
import type { ChatRealtimeService } from './chat-realtime.service';
import type { RedisService } from '../infrastructure/redis/redis.service';
import type { R2Storage } from '../infrastructure/storage/r2.storage';
import type { S3Storage } from '../infrastructure/storage/s3.storage';
import type { NotificationService } from '../../notification/notification.service';
import type { ChatHistoryCacheInvalidator } from './chat-history-cache';

describe('Chat DM @continuumAI — Service Guards, Capabilities, Query Parser, Standalone DI & OpenAPI 1.2.0', () => {
  const actorA: ChatActor = {
    id: '507f1f77bcf86cd799439011',
    organizationId: '507f1f77bcf86cd799439001',
    name: 'Nguyễn An',
    avatarUrl: null,
  };
  const actorBId = '507f1f77bcf86cd799439012';
  const convDirectId = '507f1f77bcf86cd799439021';
  const convRoomId = '507f1f77bcf86cd799439022';
  const validUuid = 'bb077bf1-0897-499d-9b82-d57510ff3b5d';

  function makeServices(
    configValues: Record<string, unknown> = {},
    orgMembershipChecker?: ChatOrgMembershipChecker,
  ) {
    const cfgMap: Record<string, unknown> = {
      BULLMQ_PREFIX: 'continuum',
      CHAT_DM_ASSISTANT_ENABLED: true,
      CHAT_DM_ASSISTANT_WORKER_ENABLED: false, // Split API pod semantics!
      SAG_API_BASE_URL: 'http://127.0.0.1:8000',
      SAG_BFF_SERVICE_TOKEN: 's'.repeat(40),
      CHAT_DM_ASSISTANT_RATE_LIMIT_PER_MINUTE: 15,
      CHAT_DM_ASSISTANT_MAX_RETRIES: 3,
      ...configValues,
    };
    const config = {
      get: jest.fn((key: string) => cfgMap[key]),
    } as unknown as ConfigService;

    const sendMessage = jest.fn();
    const listMessages = jest.fn();
    const reconcileCachedMessages = jest.fn();
    const listConversations = jest.fn();
    const getConversation = jest.fn();
    const saveDraft = jest.fn();
    const getDraft = jest.fn();
    const repository = {
      sendMessage,
      listMessages,
      reconcileCachedMessages,
      listConversations,
      getConversation,
      saveDraft,
      getDraft,
      isMember: jest.fn().mockResolvedValue(true),
      memberIds: jest.fn().mockResolvedValue([actorA.id, actorBId]),
    } as unknown as jest.Mocked<ChatRepository>;

    const iam = {
      getActor: jest.fn().mockResolvedValue(actorA),
    } as unknown as ChatIamClient;

    const consumeRateLimit = jest.fn().mockResolvedValue(true);
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      increment: jest.fn().mockResolvedValue(1),
      consumeRateLimit,
    } as unknown as jest.Mocked<RedisService>;

    const publishConversationEvent = jest.fn().mockResolvedValue(undefined);
    const revokeSessions = jest.fn().mockResolvedValue(undefined);
    const realtime = {
      publishConversationEvent,
      revokeSessions,
      areOnlineBatch: jest.fn().mockResolvedValue(new Map()),
      isOnline: jest.fn().mockResolvedValue(false),
    } as unknown as ChatRealtimeService;

    const notifyChatMention = jest.fn().mockResolvedValue(undefined);
    const notificationService = {
      notifyChatMention,
    } as unknown as NotificationService;

    const invalidate = jest.fn().mockResolvedValue(undefined);
    const historyCache = {
      invalidate,
      getVersion: jest.fn().mockResolvedValue('0'),
    } as unknown as ChatHistoryCacheInvalidator;

    const chatService = new ChatApplicationService(
      repository,
      iam,
      redis,
      realtime,
      {} as R2Storage,
      {} as S3Storage,
      config,
      notificationService,
      historyCache,
      orgMembershipChecker,
    );
    const featuresService = new ChatFeaturesService(
      repository,
      iam,
      realtime,
      historyCache,
      redis,
      config,
      orgMembershipChecker,
    );

    return {
      chatService,
      featuresService,
      repository,
      redis,
      sendMessage,
      listMessages,
      reconcileCachedMessages,
      listConversations,
      getConversation,
      saveDraft,
      getDraft,
      consumeRateLimit,
      publishConversationEvent,
      revokeSessions,
      notifyChatMention,
      invalidate,
    };
  }

  it('exposes capabilities.dmAssistantEnabled ONLY for DIRECT when enabled+configured (independent of WORKER_ENABLED for split-pod)', async () => {
    const { chatService, featuresService, listConversations, getConversation } =
      makeServices({
        CHAT_DM_ASSISTANT_ENABLED: true,
        CHAT_DM_ASSISTANT_WORKER_ENABLED: false,
      });

    const directConv = {
      id: convDirectId,
      type: 'DIRECT' as const,
      title: null,
      createdBy: actorA.id,
      lastMessageAt: null,
      lastMessagePreview: '',
      lastMessageSenderId: null,
      lastReadMessageId: null,
      lastReadAt: null,
      unreadCount: 0,
      members: [],
    };
    const roomConv = { ...directConv, id: convRoomId, type: 'ROOM' as const };
    listConversations.mockResolvedValue({
      data: [directConv, roomConv],
      hasMore: false,
      nextCursor: null,
    });

    const listed = await chatService.listConversations({}, {});
    expect(listed.capabilities).toEqual({ dmAssistantEnabled: true });
    expect(listed.data[0].capabilities).toEqual({ dmAssistantEnabled: true });
    expect(listed.data[1].capabilities).toEqual({ dmAssistantEnabled: false });

    getConversation.mockResolvedValueOnce(directConv);
    const directDetail = await featuresService.conversation({}, convDirectId);
    expect(directDetail.capabilities).toEqual({ dmAssistantEnabled: true });

    getConversation.mockResolvedValueOnce(roomConv);
    const roomDetail = await featuresService.conversation({}, convRoomId);
    expect(roomDetail.capabilities).toEqual({ dmAssistantEnabled: false });

    // Disabled flag OR missing SAG token -> false everywhere
    const disabled = makeServices({ CHAT_DM_ASSISTANT_ENABLED: false });
    disabled.listConversations.mockResolvedValue({
      data: [directConv],
      hasMore: false,
      nextCursor: null,
    });
    const disabledList = await disabled.chatService.listConversations({}, {});
    expect(disabledList.capabilities).toEqual({ dmAssistantEnabled: false });
    expect(disabledList.data[0].capabilities).toEqual({
      dmAssistantEnabled: false,
    });

    const unconfiguredSag = makeServices({
      CHAT_DM_ASSISTANT_ENABLED: true,
      SAG_BFF_SERVICE_TOKEN: '',
    });
    unconfiguredSag.getConversation.mockResolvedValue(directConv);
    const unconfiguredDetail =
      await unconfiguredSag.featuresService.conversation({}, convDirectId);
    expect(unconfiguredDetail.capabilities).toEqual({
      dmAssistantEnabled: false,
    });
  });

  it('validates assistantMention, enforces 503 disabled / 422 query / 429 rate-limit before DB write, and emits initial assistant.status', async () => {
    // 1. Disabled -> 503 CHAT_AI_NOT_ENABLED
    const disabled = makeServices({ CHAT_DM_ASSISTANT_ENABLED: false });
    await expect(
      disabled.chatService.sendMessage({}, convDirectId, {
        clientMessageId: validUuid,
        content: '@continuumAI Hôm qua chốt gì?',
        assistantMention: { handle: CONTINUUM_AI_HANDLE },
      }),
    ).rejects.toMatchObject({
      status: 503,
      response: { code: 'CHAT_AI_NOT_ENABLED' },
    });
    expect(disabled.sendMessage).not.toHaveBeenCalled();

    // 2. Invalid handle, extra field, invalid timezone -> 422 CHAT_VALIDATION_FAILED
    const enabled = makeServices();
    for (const badMention of [
      { handle: 'otherBot' },
      { handle: CONTINUUM_AI_HANDLE, question: 'wrong-key' },
      { handle: CONTINUUM_AI_HANDLE, timezone: 'Mars/Olympus' },
      'continuumAI',
    ]) {
      await expect(
        enabled.chatService.sendMessage({}, convDirectId, {
          clientMessageId: validUuid,
          content: '@continuumAI test',
          assistantMention: badMention,
        }),
      ).rejects.toMatchObject({
        status: 422,
        response: { code: 'CHAT_VALIDATION_FAILED' },
      });
    }

    // 3. Empty extracted query or > 2000 chars -> 422 CHAT_ASSISTANT_QUERY_INVALID
    await expect(
      enabled.chatService.sendMessage({}, convDirectId, {
        clientMessageId: validUuid,
        content: '@continuumAI   ',
        assistantMention: { handle: CONTINUUM_AI_HANDLE },
      }),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'CHAT_ASSISTANT_QUERY_INVALID' },
    });

    await expect(
      enabled.chatService.sendMessage({}, convDirectId, {
        clientMessageId: validUuid,
        content: '@continuumAI long',
        assistantMention: {
          handle: CONTINUUM_AI_HANDLE,
          query: 'a'.repeat(2001),
        },
      }),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'CHAT_ASSISTANT_QUERY_INVALID' },
    });

    // 4. Rate limit 15/min -> 429 CHAT_ASSISTANT_RATE_LIMITED BEFORE DB write
    enabled.consumeRateLimit.mockResolvedValueOnce(false);
    await expect(
      enabled.chatService.sendMessage({}, convDirectId, {
        clientMessageId: validUuid,
        content: '@continuumAI Hôm qua hai người chốt gì?',
        assistantMention: { handle: CONTINUUM_AI_HANDLE },
      }),
    ).rejects.toMatchObject({
      status: 429,
      response: { code: 'CHAT_ASSISTANT_RATE_LIMITED' },
    });
    expect(enabled.sendMessage).not.toHaveBeenCalled();

    // 5. Valid send extracts query from content, emits message.created + assistant.status ONLY to [A, B], and skips notifyChatMention
    const statusEvent = {
      conversationId: convDirectId,
      triggerMessageId: '507f1f77bcf86cd799439099',
      jobId: '507f1f77bcf86cd799439088',
      status: 'PENDING' as const,
      failureCode: null,
      responseMessageId: null,
      updatedAt: '2026-11-28T09:00:00.000Z',
    };
    enabled.sendMessage.mockResolvedValueOnce({
      message: {
        id: statusEvent.triggerMessageId,
        conversationId: convDirectId,
        senderId: actorA.id,
        senderName: actorA.name,
        senderAvatarUrl: null,
        content: '@continuumAI Hôm qua hai người chốt gì?',
        createdAt: '2026-11-28T09:00:00.000Z',
        editedAt: null,
        deletedAt: null,
        reactions: [],
        replyToMessageId: null,
        replyTo: null,
        attachments: [],
        authorType: 'USER',
        assistantState: {
          jobId: statusEvent.jobId,
          status: 'PENDING',
          failureCode: null,
          responseMessageId: null,
          updatedAt: statusEvent.updatedAt,
        },
      },
      recipientIds: [actorA.id, actorBId],
      assistantStatusEvent: statusEvent,
    });

    const created = await enabled.chatService.sendMessage({}, convDirectId, {
      clientMessageId: validUuid,
      content: '@continuumAI Hôm qua hai người chốt gì?',
      assistantMention: { handle: CONTINUUM_AI_HANDLE },
    });

    expect(enabled.sendMessage).toHaveBeenCalledWith(
      actorA,
      convDirectId,
      validUuid,
      '@continuumAI Hôm qua hai người chốt gì?',
      [],
      undefined,
      [],
      expect.objectContaining({
        handle: CONTINUUM_AI_HANDLE,
        query: 'Hôm qua hai người chốt gì?',
        timezone: 'Asia/Ho_Chi_Minh',
      }),
    );
    expect(created.assistantState?.status).toBe('PENDING');
    expect(enabled.publishConversationEvent).toHaveBeenCalledWith(
      'message.created',
      actorA.organizationId,
      convDirectId,
      [actorA.id, actorBId],
      created,
    );
    expect(enabled.publishConversationEvent).toHaveBeenCalledWith(
      'assistant.status',
      actorA.organizationId,
      convDirectId,
      [actorA.id, actorBId],
      statusEvent,
    );
    expect(enabled.notifyChatMention).not.toHaveBeenCalled();
  });

  it('rejects assistantMention on editMessage and validates boolean assistantMention on drafts', async () => {
    const { chatService, featuresService, saveDraft } = makeServices();

    await expect(
      chatService.editMessage({}, convDirectId, '507f1f77bcf86cd799439099', {
        content: '@continuumAI edited question',
        assistantMention: { handle: CONTINUUM_AI_HANDLE },
      }),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'CHAT_VALIDATION_FAILED' },
    });

    await expect(
      featuresService.draft({}, convDirectId, {
        content: '@continuumAI draft',
        assistantMention: 'yes',
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(saveDraft).not.toHaveBeenCalled();

    saveDraft.mockResolvedValueOnce({
      content: '@continuumAI draft',
      mentionUserIds: [],
      assistantMention: true,
      updatedAt: '2026-11-28T09:00:00.000Z',
    });
    const saved = await featuresService.draft({}, convDirectId, {
      content: '@continuumAI draft',
      assistantMention: true,
    });
    expect(saveDraft).toHaveBeenCalledWith(
      actorA,
      convDirectId,
      '@continuumAI draft',
      [],
      true,
    );
    expect(saved.assistantMention).toBe(true);
  });

  it('parses Vietnamese accented/unaccented and English time windows, keyword codes, and hybrid queries accurately', () => {
    const refNow = new Date('2026-11-28T09:00:00.000Z'); // 16:00 local Asia/Ho_Chi_Minh (UTC+7)

    // Accented & unaccented "hôm qua"
    const q1 = parseAssistantQuery(
      'Hôm qua hai người chốt những gì?',
      'Asia/Ho_Chi_Minh',
      refNow,
    );
    expect(q1.queryMode).toBe('TIME_WINDOW');
    expect(q1.timeWindow?.from.toISOString()).toBe('2026-11-26T17:00:00.000Z');
    expect(q1.timeWindow?.to.toISOString()).toBe('2026-11-27T16:59:59.999Z');

    const q2 = parseAssistantQuery(
      'hom qua hai nguoi chot nhung gi?',
      'Asia/Ho_Chi_Minh',
      refNow,
    );
    expect(q2.queryMode).toBe('TIME_WINDOW');
    expect(q2.timeWindow?.from.toISOString()).toBe('2026-11-26T17:00:00.000Z');

    // Explicit date dd/mm
    const q3 = parseAssistantQuery(
      'Ngày 25/11 hai người đã thống nhất những gì?',
      'Asia/Ho_Chi_Minh',
      refNow,
    );
    expect(q3.queryMode).toBe('TIME_WINDOW');
    expect(q3.timeWindow?.from.toISOString()).toBe('2026-11-24T17:00:00.000Z');
    expect(q3.timeWindow?.to.toISOString()).toBe('2026-11-25T16:59:59.999Z');

    // Last week ("tuần trước") — Nov 28, 2026 is Saturday; previous ISO week is Mon Nov 16..Sun Nov 22
    const q4 = parseAssistantQuery(
      'Tóm tắt tuần trước',
      'Asia/Ho_Chi_Minh',
      refNow,
    );
    expect(q4.queryMode).toBe('TIME_WINDOW');
    expect(q4.timeWindow?.from.toISOString()).toBe('2026-11-15T17:00:00.000Z');
    expect(q4.timeWindow?.to.toISOString()).toBe('2026-11-22T16:59:59.999Z');

    // Keyword query with ticket code & unaccented Vietnamese
    const q5 = parseAssistantQuery(
      'Deadline cua PAY-123 la khi nao?',
      'Asia/Ho_Chi_Minh',
      refNow,
    );
    expect(q5.queryMode).toBe('KEYWORD');
    expect(q5.codes).toContain('pay-123');
    expect(q5.keywords).toContain('deadline');

    // Hybrid query (time window + ticket code)
    const q6 = parseAssistantQuery(
      'Hôm qua hai người nói gì về PAY-123?',
      'Asia/Ho_Chi_Minh',
      refNow,
    );
    expect(q6.queryMode).toBe('HYBRID');
    expect(q6.timeWindow).not.toBeNull();
    expect(q6.codes).toContain('pay-123');

    // Extract query strips handle cleanly
    expect(extractAssistantQuery('@continuumAI: Deadline PAY-123?')).toBe(
      'Deadline PAY-123?',
    );
    expect(extractAssistantQuery('@continuumAI')).toBe('');
  });

  it('wires ChatModule standalone DI with HttpAiEngineClient and MongoChatOrgMembershipChecker without importing AiEngineModule or IamModule', async () => {
    const previousInfra = process.env.INFRA_ENABLED;
    process.env.INFRA_ENABLED = 'false';
    let moduleRef:
      | Awaited<
          ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>
        >
      | undefined;
    try {
      let isolated!: {
        ChatModule: new () => unknown;
        AI_ENGINE_CLIENT: symbol;
        HttpAiEngineClient: new (...args: unknown[]) => unknown;
        CHAT_ORG_MEMBERSHIP_CHECKER: symbol;
        MongoChatOrgMembershipChecker: new (...args: unknown[]) => {
          isActiveOrganizationMember: (
            organizationId: string,
            userId: string,
          ) => Promise<boolean>;
        };
        ChatDmAssistantWorkerService: new (...args: unknown[]) => unknown;
      };
      jest.isolateModules(() => {
        const chatMod =
          jest.requireActual<typeof import('../chat.module')>('../chat.module');
        const portMod = jest.requireActual<
          typeof import('../../../integrations/ai-engine/ai-engine.port')
        >('../../../integrations/ai-engine/ai-engine.port');
        const httpMod = jest.requireActual<
          typeof import('../../../integrations/ai-engine/http-ai-engine.client')
        >('../../../integrations/ai-engine/http-ai-engine.client');
        const typesMod = jest.requireActual<
          typeof import('./chat-dm-assistant.types')
        >('./chat-dm-assistant.types');
        const checkerMod = jest.requireActual<
          typeof import('../infrastructure/mongodb/mongo-chat-org-membership.checker')
        >('../infrastructure/mongodb/mongo-chat-org-membership.checker');
        const workerMod = jest.requireActual<
          typeof import('./chat-dm-assistant.worker')
        >('./chat-dm-assistant.worker');
        isolated = {
          ChatModule: chatMod.ChatModule,
          AI_ENGINE_CLIENT: portMod.AI_ENGINE_CLIENT,
          HttpAiEngineClient: httpMod.HttpAiEngineClient,
          CHAT_ORG_MEMBERSHIP_CHECKER: typesMod.CHAT_ORG_MEMBERSHIP_CHECKER,
          MongoChatOrgMembershipChecker:
            checkerMod.MongoChatOrgMembershipChecker,
          ChatDmAssistantWorkerService: workerMod.ChatDmAssistantWorkerService,
        };
      });
      moduleRef = await Test.createTestingModule({
        imports: [isolated.ChatModule],
      }).compile();

      const aiClient = moduleRef.get<unknown>(isolated.AI_ENGINE_CLIENT);
      const orgChecker = moduleRef.get<
        InstanceType<typeof isolated.MongoChatOrgMembershipChecker>
      >(isolated.CHAT_ORG_MEMBERSHIP_CHECKER);
      const worker = moduleRef.get<unknown>(
        isolated.ChatDmAssistantWorkerService,
      );

      expect(aiClient).toBeInstanceOf(isolated.HttpAiEngineClient);
      expect(orgChecker).toBeInstanceOf(isolated.MongoChatOrgMembershipChecker);
      expect(worker).toBeInstanceOf(isolated.ChatDmAssistantWorkerService);

      // Fail-closed when connection is absent (never returns true without verifying IAM)
      await expect(
        orgChecker.isActiveOrganizationMember(
          '507f1f77bcf86cd799439001',
          '507f1f77bcf86cd799439011',
        ),
      ).rejects.toThrow(/unavailable/i);
    } finally {
      await moduleRef?.close();
      if (previousInfra === undefined) delete process.env.INFRA_ENABLED;
      else process.env.INFRA_ENABLED = previousInfra;
    }
  });

  it('keeps docs/openapi/chat-v1.openapi.json synchronized at version 1.2.0 with all DM assistant schemas and error codes', () => {
    const specPath = join(
      __dirname,
      '../../../../docs/openapi/chat-v1.openapi.json',
    );
    const spec = JSON.parse(readFileSync(specPath, 'utf8')) as {
      info: { version: string };
      components: { schemas: Record<string, Record<string, unknown>> };
      paths: Record<
        string,
        Record<string, { responses: Record<string, unknown> }>
      >;
    };

    expect(spec.info.version).toBe('1.2.0');
    for (const schemaName of [
      'ChatConversationCapabilities',
      'ChatAssistantMentionRequest',
      'ChatAssistantStatus',
      'ChatAssistantPostedStatus',
      'ChatAssistantFailureCode',
      'ChatAssistantSourceStatus',
      'ChatAssistantSourceAggregateState',
      'ChatAssistantSourceReference',
      'ChatAssistantMeta',
      'ChatAssistantJobState',
      'AssistantStatusEvent',
    ]) {
      expect(spec.components.schemas[schemaName]).toBeDefined();
    }

    const sendResponses =
      spec.paths['/api/v1/chat/conversations/{conversationId}/messages'].post
        .responses;
    expect(sendResponses['409']).toBeDefined();
    expect(sendResponses['422']).toBeDefined();
    expect(sendResponses['429']).toBeDefined();
    expect(sendResponses['503']).toBeDefined();

    const msgPath =
      spec.paths[
        '/api/v1/chat/conversations/{conversationId}/messages/{messageId}'
      ];
    expect(msgPath.patch.responses['403']).toBeDefined();
    expect(msgPath.delete.responses['403']).toBeDefined();

    const forwardResponses =
      spec.paths['/api/v1/chat/conversations/{conversationId}/forward'].post
        .responses;
    expect(forwardResponses['422']).toBeDefined();
  });

  it('falls through to strongly-consistent MongoDB primary ($text and FOLDED_SCAN) when Atlas $search returns 0 hits due to oplog lag', async () => {
    const orgId = new Types.ObjectId('507f1f77bcf86cd799439001');
    const convId = new Types.ObjectId('507f1f77bcf86cd799439021');
    const freshMsgId = new Types.ObjectId('507f1f77bcf86cd799439055');
    const triggerId = new Types.ObjectId('507f1f77bcf86cd799439056');
    const freshDoc: MessageDocument = {
      _id: freshMsgId,
      organizationId: orgId,
      conversationId: convId,
      senderId: actorA.id,
      senderName: actorA.name,
      senderAvatarUrl: null,
      clientMessageId: 'fresh-1',
      content: 'Cập nhật E2E-EDIT-401 chốt lúc 17:00 thứ Sáu.',
      createdAt: new Date('2026-11-28T08:59:00.000Z'),
      editedAt: null,
      deletedAt: null,
      contentVersion: 0,
    };

    const makeCursor = (rows: unknown[]) => ({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(rows),
    });

    const retrievalService = new DmAssistantRetrievalService();

    // Case 1: Atlas $search succeeds with [] (mongot lag) -> $text recovers freshDoc
    const modelTextRecovery = {
      aggregate: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue([]),
      })),
      find: jest.fn((filter: Record<string, unknown>) => {
        if ('$text' in filter) {
          return makeCursor([freshDoc]);
        }
        // Neighbor expansion queries
        return makeCursor([]);
      }),
    } as unknown as Model<MessageDocument>;

    const textRecovered = await retrievalService.retrieveContext(
      {
        organizationId: orgId,
        conversationId: convId,
        triggerMessageId: triggerId,
        triggerCreatedAt: new Date('2026-11-28T09:00:00.000Z'),
        question: 'E2E-EDIT-401 chốt lúc mấy giờ?',
        timezone: 'Asia/Ho_Chi_Minh',
        maxMessages: 80,
        maxChars: 24_000,
      },
      modelTextRecovery,
    );
    expect(textRecovered.retrievalPath).toBe('ATLAS_SEARCH_THEN_MONGO_TEXT');
    expect(textRecovered.messages).toHaveLength(1);
    expect(String(textRecovered.messages[0].messageId)).toBe(
      String(freshMsgId),
    );

    // Case 2: Atlas $search returns [] AND $text returns [] -> FOLDED_SCAN recovers freshDoc from primary
    const modelFoldedRecovery = {
      aggregate: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue([]),
      })),
      find: jest.fn(
        (
          filter: Record<string, unknown>,
          projection?: Record<string, unknown>,
        ) => {
          if ('$text' in filter) return makeCursor([]);
          if (projection && '_id' in projection) {
            return makeCursor([
              {
                _id: freshDoc._id,
                content: freshDoc.content,
                createdAt: freshDoc.createdAt,
              },
            ]);
          }
          if (
            '_id' in filter &&
            typeof filter._id === 'object' &&
            filter._id !== null &&
            '$in' in filter._id
          ) {
            return makeCursor([freshDoc]);
          }
          return makeCursor([]);
        },
      ),
    } as unknown as Model<MessageDocument>;

    const foldedRecovered = await retrievalService.retrieveContext(
      {
        organizationId: orgId,
        conversationId: convId,
        triggerMessageId: triggerId,
        triggerCreatedAt: new Date('2026-11-28T09:00:00.000Z'),
        question: 'Cap nhat E2E-EDIT-401 chot luc may gio?',
        timezone: 'Asia/Ho_Chi_Minh',
        maxMessages: 80,
        maxChars: 24_000,
      },
      modelFoldedRecovery,
    );
    expect(foldedRecovered.retrievalPath).toBe('ATLAS_SEARCH_THEN_FOLDED_SCAN');
    expect(foldedRecovered.messages).toHaveLength(1);
    expect(String(foldedRecovered.messages[0].messageId)).toBe(
      String(freshMsgId),
    );
  });

  it('re-enriches stale Redis cached assistant DTOs and active assistantState in ChatApplicationService.listMessages while keeping human-only hits zero-overhead (P2-1)', async () => {
    const { chatService, redis, listMessages, reconcileCachedMessages } =
      makeServices();

    // 1. Human-only cached page -> served directly with 0 MongoDB calls
    const humanCached = {
      data: [
        {
          id: '507f1f77bcf86cd799439031',
          conversationId: convDirectId,
          senderId: actorA.id,
          senderName: actorA.name,
          senderAvatarUrl: null,
          content: 'Hello world',
          createdAt: '2026-11-28T08:00:00.000Z',
          editedAt: null,
          deletedAt: null,
          reactions: [],
          replyToMessageId: null,
          replyTo: null,
          attachments: [],
          authorType: 'USER',
        },
      ],
      nextCursor: null,
    };
    redis.get.mockResolvedValueOnce(JSON.stringify(humanCached));
    const humanRes = await chatService.listMessages({}, convDirectId, {});
    expect(humanRes).toEqual(humanCached);
    expect(reconcileCachedMessages).not.toHaveBeenCalled();
    expect(listMessages).not.toHaveBeenCalled();

    // 2. Stale cached page containing ASSISTANT message (cached ACTIVE + non-empty quoteSnippet)
    //    when MongoDB source was already EDITED/DELETED and Redis invalidation failed/lagged
    const staleAssistantCached = {
      data: [
        {
          id: '507f1f77bcf86cd799439040',
          conversationId: convDirectId,
          senderId: actorA.id,
          senderName: actorA.name,
          senderAvatarUrl: null,
          content: '@continuumAI PAY-123?',
          createdAt: '2026-11-28T08:50:00.000Z',
          editedAt: null,
          deletedAt: null,
          reactions: [],
          replyToMessageId: null,
          replyTo: null,
          attachments: [],
          authorType: 'USER',
          assistantState: {
            jobId: '507f1f77bcf86cd799439077',
            status: 'PENDING',
            failureCode: null,
            responseMessageId: null,
            updatedAt: '2026-11-28T08:50:00.000Z',
          },
        },
        {
          id: '507f1f77bcf86cd799439041',
          conversationId: convDirectId,
          senderId: 'assistant:continuum_ai',
          senderName: 'Continuum AI',
          senderAvatarUrl: null,
          content: 'PAY-123 summary [M1][M2].',
          createdAt: '2026-11-28T08:51:00.000Z',
          editedAt: null,
          deletedAt: null,
          reactions: [],
          replyToMessageId: '507f1f77bcf86cd799439040',
          replyTo: null,
          attachments: [],
          authorType: 'ASSISTANT',
          assistantStatus: 'COMPLETED',
          assistantMeta: {
            handle: CONTINUUM_AI_HANDLE,
            queryMode: 'KEYWORD',
            partialCoverage: false,
            coverageNote: null,
            sourceState: 'FRESH',
          },
          sourceReferences: [
            {
              refId: 'M1',
              messageId: '507f1f77bcf86cd799439051',
              senderName: actorA.name,
              createdAt: '2026-11-28T08:10:00.000Z',
              quoteSnippet: 'Edited quote text',
              status: 'ACTIVE',
            },
            {
              refId: 'M2',
              messageId: '507f1f77bcf86cd799439052',
              senderName: 'Trần Bình',
              createdAt: '2026-11-28T08:12:00.000Z',
              quoteSnippet: 'Deleted secret snippet',
              status: 'ACTIVE',
            },
          ],
        },
      ],
      nextCursor: null,
    };

    redis.get.mockResolvedValueOnce(JSON.stringify(staleAssistantCached));
    reconcileCachedMessages.mockResolvedValueOnce([
      {
        ...staleAssistantCached.data[0],
        assistantState: {
          ...staleAssistantCached.data[0].assistantState,
          status: 'COMPLETED',
          responseMessageId: '507f1f77bcf86cd799439041',
        },
      },
      {
        ...staleAssistantCached.data[1],
        assistantMeta: {
          ...staleAssistantCached.data[1].assistantMeta,
          sourceState: 'HAS_EDITED_AND_DELETED',
        },
        sourceReferences: [
          {
            ...staleAssistantCached.data[1].sourceReferences![0],
            status: 'EDITED',
          },
          {
            ...staleAssistantCached.data[1].sourceReferences![1],
            status: 'DELETED',
            quoteSnippet: '',
          },
        ],
      },
    ]);

    const freshRes = await chatService.listMessages({}, convDirectId, {});
    expect(reconcileCachedMessages).toHaveBeenCalledTimes(1);
    expect(reconcileCachedMessages).toHaveBeenCalledWith(
      actorA,
      convDirectId,
      staleAssistantCached.data,
    );
    expect(listMessages).not.toHaveBeenCalled();
    expect(freshRes.data[0].assistantState?.status).toBe('COMPLETED');
    expect(freshRes.data[1].assistantMeta?.sourceState).toBe(
      'HAS_EDITED_AND_DELETED',
    );
    expect(freshRes.data[1].sourceReferences?.[0].status).toBe('EDITED');
    expect(freshRes.data[1].sourceReferences?.[1].status).toBe('DELETED');
    expect(freshRes.data[1].sourceReferences?.[1].quoteSnippet).toBe('');
  });

  it('preserves the requested time window during HYBRID neighbor expansion so out-of-window neighbors are never pulled in (P2-2)', async () => {
    const orgId = new Types.ObjectId(actorA.organizationId);
    const convId = new Types.ObjectId(convDirectId);
    const triggerId = new Types.ObjectId('507f1f77bcf86cd799439099');
    // Ref now: 2026-11-28T09:00:00Z -> Yesterday in Asia/Ho_Chi_Minh: 2026-11-26T17:00:00Z .. 2026-11-27T16:59:59.999Z
    const seedDoc: MessageDocument = {
      _id: new Types.ObjectId('507f1f77bcf86cd799439061'),
      organizationId: orgId,
      conversationId: convId,
      senderId: actorA.id,
      senderName: actorA.name,
      senderAvatarUrl: null,
      clientMessageId: 'seed-1',
      content: 'Hôm qua chốt PAY-123 làm phần thanh toán.',
      createdAt: new Date('2026-11-26T17:05:00.000Z'),
      editedAt: null,
      deletedAt: null,
      contentVersion: 0,
    };

    const neighborFilters: Record<string, unknown>[] = [];
    const makeCursor = (rows: unknown[]) => ({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(rows),
    });

    const mockModel = {
      aggregate: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue([seedDoc]),
      })),
      find: jest.fn((filter: Record<string, unknown>) => {
        if ('$or' in filter) {
          neighborFilters.push(filter);
        }
        return makeCursor([]);
      }),
    } as unknown as Model<MessageDocument>;

    const retrievalService = new DmAssistantRetrievalService();
    const result = await retrievalService.retrieveContext(
      {
        organizationId: orgId,
        conversationId: convId,
        triggerMessageId: triggerId,
        triggerCreatedAt: new Date('2026-11-28T09:00:00.000Z'),
        question: 'Hôm qua PAY-123 chốt gì?',
        timezone: 'Asia/Ho_Chi_Minh',
        maxMessages: 80,
        maxChars: 24_000,
      },
      mockModel,
    );

    expect(result.queryMode).toBe('HYBRID');
    expect(neighborFilters).toHaveLength(2);
    for (const filter of neighborFilters) {
      expect(filter.createdAt).toEqual({
        $gte: new Date('2026-11-26T17:00:00.000Z'),
        $lte: new Date('2026-11-27T16:59:59.999Z'),
      });
    }
  });

  it('executes zero concurrent MongoDB ClientSession ops, enforces strict 3-attempt commit cap across inner withTransaction retries, re-runs IAM per attempt, and uses compound (createdAt, _id) tie-breaker (P2-3, P2-4)', async () => {
    const orgObjId = new Types.ObjectId(actorA.organizationId);
    const convObjId = new Types.ObjectId(convDirectId);
    const triggerObjId = new Types.ObjectId('507f1f77bcf86cd799439081');
    const jobObjId = new Types.ObjectId('507f1f77bcf86cd799439082');
    const srcObjId = new Types.ObjectId('507f1f77bcf86cd799439083');
    const aiMsgObjId = new Types.ObjectId('507f1f77bcf86cd799439084');
    const now = new Date('2026-11-28T09:00:00.000Z');

    const jobDoc = {
      _id: jobObjId,
      organizationId: orgObjId,
      conversationId: convObjId,
      triggerMessageId: triggerObjId,
      requesterUserId: actorA.id,
      requesterDisplayName: actorA.name,
      handle: CONTINUUM_AI_HANDLE,
      query: 'PAY-123?',
      timezone: 'Asia/Ho_Chi_Minh',
      status: 'PROCESSING' as const,
      failureCode: null,
      attempts: 1,
      maxAttempts: 3,
      nextAttemptAt: now,
      lockedBy: 'worker-unit',
      lockedUntil: new Date(now.getTime() + 60_000),
      responseMessageId: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const triggerDoc = {
      _id: triggerObjId,
      organizationId: orgObjId,
      conversationId: convObjId,
      senderId: actorA.id,
      senderName: actorA.name,
      content: '@continuumAI PAY-123?',
      createdAt: now,
      editedAt: null,
      deletedAt: null,
      contentVersion: 0,
    };

    function buildWorkerHarness(options: {
      innerRetryCount: number;
      revokeUserOnCommitAttempt?: { attempt: number; userId: string };
    }) {
      let inFlightSessionOps = 0;
      let maxConcurrentSessionOps = 0;
      let commitCallbackBodyRuns = 0;
      let commitAttemptIndex = 0;
      const lastMessageFilters: Record<string, unknown>[] = [];
      const createdNotifications: unknown[] = [];

      const trackSessionOp = async <T>(
        hasSession: boolean,
        fn: () => Promise<T>,
      ): Promise<T> => {
        if (!hasSession) return fn();
        inFlightSessionOps += 1;
        maxConcurrentSessionOps = Math.max(
          maxConcurrentSessionOps,
          inFlightSessionOps,
        );
        try {
          // Yield a microtask so any concurrent Promise.all sharing the same session is caught immediately
          await Promise.resolve();
          return await fn();
        } finally {
          inFlightSessionOps -= 1;
        }
      };

      const makeChain = (
        resolveFn: (hasSession: boolean) => Promise<unknown>,
      ) => {
        let hasSession = false;
        const chain = {
          session(s: unknown) {
            if (s) hasSession = true;
            return chain;
          },
          select() {
            return chain;
          },
          lean() {
            return chain;
          },
          exec() {
            return trackSessionOp(hasSession, () => resolveFn(hasSession));
          },
        };
        return chain;
      };

      const models: Record<string, unknown> = {
        continuum_chat_chat_assistant_jobs: {
          findOneAndUpdate: jest.fn((filter: Record<string, unknown>) => {
            if (filter.status === 'PROCESSING') {
              return makeChain(() => Promise.resolve(null));
            }
            return makeChain(() => Promise.resolve(jobDoc));
          }),
          findOne: jest.fn(() => makeChain(() => Promise.resolve(jobDoc))),
          updateOne: jest.fn(
            (_f: unknown, _u: unknown, opts?: { session?: unknown }) => ({
              exec: () =>
                trackSessionOp(Boolean(opts?.session), () =>
                  Promise.resolve({ matchedCount: 1, modifiedCount: 1 }),
                ),
            }),
          ),
        },
        continuum_chat_chat_conversation_messages: {
          findOne: jest.fn((filter: Record<string, unknown>) =>
            makeChain(() => {
              if (filter.authorType === 'ASSISTANT') {
                return Promise.resolve(null);
              }
              return Promise.resolve(triggerDoc);
            }),
          ),
          find: jest.fn(() =>
            makeChain(() =>
              Promise.resolve([
                {
                  _id: srcObjId,
                  deletedAt: null,
                  editedAt: null,
                  contentVersion: 0,
                },
              ]),
            ),
          ),
          create: jest.fn(
            (docs: Record<string, unknown>[], opts?: { session?: unknown }) =>
              trackSessionOp(Boolean(opts?.session), () =>
                Promise.resolve([
                  {
                    toObject: () => ({
                      ...docs[0],
                      _id: aiMsgObjId,
                      createdAt: now,
                    }),
                  },
                ]),
              ),
          ),
        },
        continuum_chat_chat_conversations: {
          findOne: jest.fn(() =>
            makeChain(() =>
              Promise.resolve({
                _id: convObjId,
                organizationId: orgObjId,
                type: 'DIRECT',
                status: 'ACTIVE',
                contextRevision: 0,
              }),
            ),
          ),
          updateOne: jest.fn(
            (
              filter: Record<string, unknown>,
              update: Record<string, unknown>,
              opts?: { session?: unknown },
            ) => ({
              exec: () =>
                trackSessionOp(Boolean(opts?.session), () => {
                  if (
                    update &&
                    typeof update === 'object' &&
                    '$set' in update &&
                    (update.$set as Record<string, unknown>).lastMessageId
                  ) {
                    lastMessageFilters.push(filter);
                  }
                  return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
                }),
            }),
          ),
        },
        continuum_chat_chat_members: {
          find: jest.fn(() =>
            makeChain(() =>
              Promise.resolve([
                {
                  _id: new Types.ObjectId(),
                  organizationId: orgObjId,
                  conversationId: convObjId,
                  userId: actorA.id,
                  status: 'ACTIVE',
                  notificationMode: 'ALL',
                },
                {
                  _id: new Types.ObjectId(),
                  organizationId: orgObjId,
                  conversationId: convObjId,
                  userId: actorBId,
                  status: 'ACTIVE',
                  notificationMode: 'ALL',
                },
              ]),
            ),
          ),
        },
      };

      const sessionObj = {
        withTransaction: jest.fn(async (cb: () => Promise<void>) => {
          let remainingTransientFailures = options.innerRetryCount;
          while (true) {
            await cb();
            commitCallbackBodyRuns += 1;
            if (remainingTransientFailures > 0) {
              remainingTransientFailures -= 1;
              continue;
            }
            return;
          }
        }),
        endSession: jest.fn().mockResolvedValue(undefined),
      };

      const connection = {
        model: (name: string) => models[name],
        startSession: jest.fn().mockResolvedValue(sessionObj),
        db: {
          collection: (name: string) => {
            if (name === 'chat_blocks') {
              return {
                findOne: jest.fn((_f: unknown, opts?: { session?: unknown }) =>
                  trackSessionOp(Boolean(opts?.session), () =>
                    Promise.resolve(null),
                  ),
                ),
              };
            }
            if (name === 'chat_notifications') {
              return {
                bulkWrite: jest.fn(
                  (ops: unknown[], opts?: { session?: unknown }) =>
                    trackSessionOp(Boolean(opts?.session), () => {
                      createdNotifications.push(...ops);
                      return Promise.resolve({ ok: 1 });
                    }),
                ),
              };
            }
            return {};
          },
        },
      } as unknown as Connection;

      const iamCheckCalls: string[] = [];
      let inCommitPhase = false;
      const orgChecker = {
        isActiveOrganizationMember: jest.fn(
          (_orgId: string, userId: string) => {
            iamCheckCalls.push(userId);
            if (inCommitPhase && userId === actorA.id) {
              commitAttemptIndex += 1;
            }
            if (
              options.revokeUserOnCommitAttempt &&
              commitAttemptIndex >= options.revokeUserOnCommitAttempt.attempt &&
              userId === options.revokeUserOnCommitAttempt.userId
            ) {
              return Promise.resolve(false);
            }
            return Promise.resolve(true);
          },
        ),
      };

      const retrievalStub = {
        retrieveContext: jest.fn().mockResolvedValue({
          queryMode: 'KEYWORD',
          retrievalPath: 'FOLDED_SCAN',
          candidateCount: 1,
          partialCoverage: false,
          coverageHint: null,
          messages: [
            {
              refId: 'M1',
              messageId: srcObjId,
              senderName: actorA.name,
              createdAt: now,
              sourceVersion: 0,
              sourceEditedAtMs: null,
              quoteSnippet: 'PAY-123 done',
              textForSag: 'PAY-123 done',
            },
          ],
        }),
      } as unknown as DmAssistantRetrievalService;

      const aiEngine = {
        request: jest.fn(() => {
          inCommitPhase = true;
          return Promise.resolve({
            status: 200,
            body: {
              status: 'ANSWERED',
              answerText: 'PAY-123 done [M1].',
              citedRefIds: ['M1'],
              coverageNote: null,
              model: 'test-model',
              usage: {
                inputTokens: 10,
                cachedTokens: 0,
                outputTokens: 5,
                totalTokens: 15,
                calls: 1,
              },
            },
          });
        }),
        requestStream: jest.fn(),
      } as unknown as AiEngineClient;

      const historyCache = {
        invalidate: jest.fn().mockResolvedValue(undefined),
        getVersion: jest.fn().mockResolvedValue('0'),
      } as unknown as ChatHistoryCacheInvalidator;

      const publishConversationEvent = jest.fn().mockResolvedValue(undefined);
      const realtime = {
        publishConversationEvent,
      } as unknown as ChatRealtimeService;

      const config = {
        get: jest.fn(() => undefined),
      } as unknown as ConfigService;

      const worker = new ChatDmAssistantWorkerService(
        config,
        retrievalStub,
        aiEngine,
        orgChecker,
        historyCache,
        realtime,
        connection,
      );
      worker.setRetryDelayOverrideMs(0);

      return {
        worker,
        getMaxConcurrentSessionOps: () => maxConcurrentSessionOps,
        getCommitCallbackBodyRuns: () => commitCallbackBodyRuns,
        getCommitAttemptIndex: () => commitAttemptIndex,
        iamCheckCalls,
        lastMessageFilters,
        createdNotifications,
        publishConversationEvent,
      };
    }

    // (a) Happy path: 0 concurrent session ops + compound (createdAt, _id) tie-breaker filter
    const happy = buildWorkerHarness({ innerRetryCount: 0 });
    const happyRes = await happy.worker.processJobById(
      jobObjId.toHexString(),
      'worker-unit',
    );
    expect(happyRes.outcome).toBe('COMPLETED');
    expect(happy.getMaxConcurrentSessionOps()).toBe(1);
    expect(happy.lastMessageFilters).toHaveLength(1);
    expect(happy.lastMessageFilters[0]).toEqual({
      _id: convObjId,
      organizationId: orgObjId,
      $or: [
        { lastMessageAt: null },
        { lastMessageAt: { $lt: now } },
        {
          lastMessageAt: now,
          $or: [
            { lastMessageId: null },
            { lastMessageId: { $lt: aiMsgObjId } },
          ],
        },
      ],
    });

    // (b) Inner withTransaction retries count strictly toward MAX_COMMIT_TX_ATTEMPTS = 3 and re-run IAM on every attempt
    const exhausted = buildWorkerHarness({ innerRetryCount: 5 });
    const exhaustedRes = await exhausted.worker.processJobById(
      jobObjId.toHexString(),
      'worker-unit',
    );
    expect(exhaustedRes).toMatchObject({
      outcome: 'RETRY_SCHEDULED',
      failureCode: 'SERVICE_UNAVAILABLE',
    });
    expect(exhausted.getMaxConcurrentSessionOps()).toBe(1);
    expect(exhausted.getCommitCallbackBodyRuns()).toBe(3);
    expect(exhausted.getCommitAttemptIndex()).toBe(3);

    // (c) IAM revocation between inner driver retry 1 and retry 2 excludes revoked peer B from notifications & WS!
    const revokedOnRetry = buildWorkerHarness({
      innerRetryCount: 1,
      revokeUserOnCommitAttempt: { attempt: 2, userId: actorBId },
    });
    const revokedRes = await revokedOnRetry.worker.processJobById(
      jobObjId.toHexString(),
      'worker-unit',
    );
    expect(revokedRes.outcome).toBe('COMPLETED');
    expect(revokedOnRetry.getCommitAttemptIndex()).toBe(2);
    const createdEventCalls = (
      revokedOnRetry.publishConversationEvent.mock.calls as [
        string,
        string,
        string,
        string[],
        unknown,
      ][]
    ).filter((call) => call[0] === 'message.created');
    expect(createdEventCalls).toHaveLength(1);
    expect(createdEventCalls[0][3]).toEqual([actorA.id]);
    expect(createdEventCalls[0][3]).not.toContain(actorBId);
  });

  it('wires standalone chat-service DM assistant env vars cleanly in both Docker Compose and Helm chart without hardcoded secrets (Deploy Parity)', () => {
    const composePath = join(
      __dirname,
      '../../../../docker-compose.microservices.yml',
    );
    const helmTemplatePath = join(
      __dirname,
      '../../../../charts/continuum-ai/templates/domain-services.yaml',
    );
    const helmValuesPath = join(
      __dirname,
      '../../../../charts/continuum-ai/values.yaml',
    );

    const compose = readFileSync(composePath, 'utf8');
    const chatComposeSection = compose.slice(
      compose.indexOf('  chat:'),
      compose.indexOf('  handover:'),
    );
    for (const envVar of [
      'SAG_API_BASE_URL: ${SAG_API_BASE_URL:-}',
      'SAG_BFF_SERVICE_TOKEN: ${SAG_BFF_SERVICE_TOKEN:-}',
      'CHAT_DM_ASSISTANT_ENABLED: ${CHAT_DM_ASSISTANT_ENABLED:-false}',
      'CHAT_DM_ASSISTANT_WORKER_ENABLED: ${CHAT_DM_ASSISTANT_WORKER_ENABLED:-${CHAT_DM_ASSISTANT_ENABLED:-false}}',
      'CHAT_DM_ASSISTANT_SAG_TIMEOUT_MS: ${CHAT_DM_ASSISTANT_SAG_TIMEOUT_MS:-45000}',
    ]) {
      expect(chatComposeSection).toContain(envVar);
    }

    const helmTemplate = readFileSync(helmTemplatePath, 'utf8');
    const chatHelmSection = helmTemplate.slice(
      helmTemplate.indexOf('{{- if eq $name "chat" }}'),
      helmTemplate.indexOf('{{- if eq $name "iam" }}'),
    );
    for (const envName of [
      'name: SAG_API_BASE_URL',
      'name: SAG_BFF_SERVICE_TOKEN',
      'name: CHAT_DM_ASSISTANT_ENABLED',
      'name: CHAT_DM_ASSISTANT_WORKER_ENABLED',
      'name: CHAT_DM_ASSISTANT_SAG_TIMEOUT_MS',
    ]) {
      expect(chatHelmSection).toContain(envName);
    }
    expect(chatHelmSection).toContain('secretKeyRef:');
    expect(chatHelmSection).toContain(
      'kindIs "invalid" $dmAssistant.workerEnabled',
    );

    const helmValues = readFileSync(helmValuesPath, 'utf8');
    expect(helmValues).toContain('dmAssistant:');
    expect(helmValues).toContain('enabled: false');
    expect(helmValues).toContain('workerEnabled: null');
    expect(helmValues).toContain('sagTimeoutMs: 45000');
  });

  it('filters initial sendMessage, editMessage, and deleteMessage fan-out & notifications through CHAT_ORG_MEMBERSHIP_CHECKER fail-closed (R2-P1)', async () => {
    const actorCId = '507f1f77bcf86cd799439013';
    const checker: ChatOrgMembershipChecker = {
      isActiveOrganizationMember: jest.fn((_orgId: string, uid: string) => {
        if (uid === actorBId) return Promise.resolve(false);
        if (uid === actorCId)
          return Promise.reject(new Error('IAM_LOOKUP_FAILED'));
        return Promise.resolve(true);
      }),
    };
    const services = makeServices({}, checker);
    services.repository.memberIds = jest
      .fn()
      .mockResolvedValue([actorA.id, actorBId, actorCId]);
    services.repository.editMessage = jest.fn();
    services.repository.deleteMessage = jest.fn();

    const statusEvent = {
      conversationId: convDirectId,
      triggerMessageId: '507f1f77bcf86cd799439099',
      jobId: '507f1f77bcf86cd799439088',
      status: 'PENDING' as const,
      failureCode: null,
      responseMessageId: null,
      updatedAt: '2026-11-28T09:00:00.000Z',
    };
    services.sendMessage.mockResolvedValueOnce({
      message: {
        id: statusEvent.triggerMessageId,
        conversationId: convDirectId,
        senderId: actorA.id,
        senderName: actorA.name,
        senderAvatarUrl: null,
        content: '@continuumAI Hôm qua chốt gì?',
        createdAt: '2026-11-28T09:00:00.000Z',
        editedAt: null,
        deletedAt: null,
        reactions: [],
        replyToMessageId: null,
        replyTo: null,
        attachments: [],
        authorType: 'USER',
        assistantState: {
          jobId: statusEvent.jobId,
          status: 'PENDING',
          failureCode: null,
          responseMessageId: null,
          updatedAt: statusEvent.updatedAt,
        },
      },
      recipientIds: [actorA.id, actorBId, actorCId],
      assistantStatusEvent: statusEvent,
    });

    await services.chatService.sendMessage({}, convDirectId, {
      clientMessageId: validUuid,
      content: '@continuumAI Hôm qua chốt gì?',
      mentionUserIds: [actorBId, actorCId],
      assistantMention: { handle: CONTINUUM_AI_HANDLE },
    });

    // ZERO message.created, ZERO assistant.status: PENDING, ZERO mention notifications for revoked B or errored C!
    expect(services.publishConversationEvent).toHaveBeenCalledTimes(2);
    expect(services.publishConversationEvent).toHaveBeenNthCalledWith(
      1,
      'message.created',
      actorA.organizationId,
      convDirectId,
      [actorA.id],
      expect.objectContaining({ id: statusEvent.triggerMessageId }),
    );
    expect(services.publishConversationEvent).toHaveBeenNthCalledWith(
      2,
      'assistant.status',
      actorA.organizationId,
      convDirectId,
      [actorA.id],
      statusEvent,
    );
    expect(services.notifyChatMention).not.toHaveBeenCalled();
    // Definitively revoked B gets proactive WS session revocation; transient error C does not
    expect(services.revokeSessions).toHaveBeenCalledTimes(1);
    expect(services.revokeSessions).toHaveBeenCalledWith({
      organizationId: actorA.organizationId,
      userId: actorBId,
    });

    // editMessage & deleteMessage also exclude revoked peer B
    services.publishConversationEvent.mockClear();
    (services.repository.editMessage as jest.Mock).mockResolvedValueOnce({
      message: { id: '507f1f77bcf86cd799439099', content: 'edited' },
      recipientIds: [actorA.id, actorBId],
      newlyMentionedUserIds: [actorBId],
    });
    await services.chatService.editMessage(
      {},
      convDirectId,
      '507f1f77bcf86cd799439099',
      { content: 'edited', mentionUserIds: [actorBId] },
    );
    expect(services.publishConversationEvent).toHaveBeenCalledWith(
      'message.updated',
      actorA.organizationId,
      convDirectId,
      [actorA.id],
      expect.objectContaining({ content: 'edited' }),
    );
    expect(services.notifyChatMention).not.toHaveBeenCalled();

    services.publishConversationEvent.mockClear();
    (services.repository.deleteMessage as jest.Mock).mockResolvedValueOnce({
      message: {
        id: '507f1f77bcf86cd799439099',
        content: '',
        deletedAt: '2026-11-28T09:10:00.000Z',
      },
      recipientIds: [actorA.id, actorBId],
    });
    await services.chatService.deleteMessage(
      {},
      convDirectId,
      '507f1f77bcf86cd799439099',
    );
    expect(services.publishConversationEvent).toHaveBeenCalledWith(
      'message.deleted',
      actorA.organizationId,
      convDirectId,
      [actorA.id],
      expect.objectContaining({ content: '' }),
    );
  });

  it('bypasses stale ChatApplicationService.listMessages Redis cache when conversation contextRevision changes in MongoDB (R2-P2)', async () => {
    const services = makeServices();
    let liveRevision = 0;
    services.repository.getConversationContextRevisions = jest.fn(
      (_actor: ChatActor, ids: readonly string[]) =>
        Promise.resolve(new Map(ids.map((id) => [id, liveRevision]))),
    );
    const cacheStore = new Map<string, string>();
    services.redis.get.mockImplementation((key: string) =>
      Promise.resolve(cacheStore.get(key) ?? null),
    );
    services.redis.set.mockImplementation((key: string, value: string) => {
      cacheStore.set(key, value);
      return Promise.resolve();
    });

    services.listMessages.mockResolvedValueOnce({
      data: [
        {
          id: '507f1f77bcf86cd799439031',
          conversationId: convDirectId,
          senderId: actorA.id,
          senderName: actorA.name,
          senderAvatarUrl: null,
          content: 'Secret human text before deletion',
          createdAt: '2026-11-28T08:00:00.000Z',
          editedAt: null,
          deletedAt: null,
          reactions: [],
          replyToMessageId: null,
          replyTo: null,
          attachments: [],
          authorType: 'USER',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });

    // Prime cache at contextRevision = 0
    const first = await services.chatService.listMessages({}, convDirectId, {});
    expect(first.data[0].content).toBe('Secret human text before deletion');
    expect(first).not.toHaveProperty('contextRevision');
    expect(first).not.toHaveProperty('__v');

    // Hit at same contextRevision = 0 -> served from Redis with 0 additional DB queries
    const hit = await services.chatService.listMessages({}, convDirectId, {});
    expect(hit.data[0].content).toBe('Secret human text before deletion');
    expect(services.listMessages).toHaveBeenCalledTimes(1);

    // Human message deleted in MongoDB (bumping contextRevision -> 1) WITHOUT bumping Redis history-version!
    liveRevision = 1;
    services.listMessages.mockResolvedValueOnce({
      data: [
        {
          id: '507f1f77bcf86cd799439031',
          conversationId: convDirectId,
          senderId: actorA.id,
          senderName: actorA.name,
          senderAvatarUrl: null,
          content: '',
          createdAt: '2026-11-28T08:00:00.000Z',
          editedAt: null,
          deletedAt: '2026-11-28T08:05:00.000Z',
          reactions: [],
          replyToMessageId: null,
          replyTo: null,
          attachments: [],
          authorType: 'USER',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });

    const afterDelete = await services.chatService.listMessages(
      {},
      convDirectId,
      {},
    );
    expect(services.listMessages).toHaveBeenCalledTimes(2);
    expect(afterDelete.data[0].content).toBe('');
    expect(afterDelete.data[0].deletedAt).toBe('2026-11-28T08:05:00.000Z');
  });

  it('enforces explicit serialized UTF-8 JSON byte budget (<= 114,688 bytes < SAG 128 KiB cap) on worst-case 3-byte Vietnamese UTF-8 + escaped quotes/newlines while keeping top-ranked hit (R2-P2)', async () => {
    const orgId = new Types.ObjectId(actorA.organizationId);
    const convId = new Types.ObjectId(convDirectId);
    const triggerId = new Types.ObjectId('507f1f77bcf86cd799439099');
    const triggerNow = new Date('2026-11-28T09:00:00.000Z');

    // Construct 80 worst-case 3-byte Vietnamese UTF-8 messages with JSON-escaped quotes/newlines/control chars + 120-char 3-byte Vietnamese sender names!
    // 80 * 300 chars = 24,000 chars (passes <= 80 msgs, <= 1,200 chars/msg, <= 24,000 chars),
    // yet raw serialized UTF-8 JSON exceeds SAG's 128 KiB (131,072-byte) cap without byte-budget trimming!
    const heavyUnit = 'ệ\u000b\u000c\u001c\u001d\u001e\u001f"\n';
    const heavySender = 'ệớửữự"'.repeat(20).slice(0, 120);
    const heavyContent = (label: string) =>
      `${label} ${heavyUnit.repeat(40)}`.slice(0, 300);

    const docs: MessageDocument[] = Array.from({ length: 80 }, (_, i) => ({
      _id: new Types.ObjectId((0x1000 + i).toString(16).padStart(24, '0')),
      organizationId: orgId,
      conversationId: convId,
      senderId: i % 2 === 0 ? actorA.id : actorBId,
      senderName: heavySender,
      senderAvatarUrl: null,
      clientMessageId: `heavy-${i}`,
      content:
        i === 0
          ? heavyContent('TOP-RANKED-HIT PAY-999 chốt lúc 17:00')
          : heavyContent(`LOWER-PRIORITY-${i} PAY-999 thảo luận`),
      createdAt: new Date(triggerNow.getTime() - (80 - i) * 60_000),
      editedAt: null,
      deletedAt: null,
      contentVersion: 0,
    }));

    const question =
      'Quyết định PAY-999 về tiến độ triển khai dự án của hai người là gì? '
        .repeat(29)
        .trim()
        .slice(0, 1990);

    // Verify our fixture truly exceeds BOTH MAX_SAG_REQUEST_JSON_BYTES (112 KiB) AND SAG's 128 KiB cap before trimming!
    const untrimmedBytes = Buffer.byteLength(
      JSON.stringify(
        buildSagDmAssistantPayload({
          question,
          timezone: 'Asia/Ho_Chi_Minh',
          referenceNowIso: triggerNow.toISOString(),
          queryMode: 'KEYWORD',
          partialCoverage: false,
          coverageHint: null,
          messages: docs.map((d, idx) => ({
            refId: `M${idx + 1}`,
            senderName: d.senderName.trim().slice(0, 120),
            createdAt: d.createdAt,
            textForSag: d.content,
          })),
        }),
      ),
      'utf8',
    );
    expect(untrimmedBytes).toBeGreaterThan(131_072);

    // Note: top-ranked hit is docs[0] (oldest timestamp, rank 0) to prove rank beats recency!
    const makeCursor = (rows: unknown[]) => ({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(rows),
    });
    const mockModel = {
      aggregate: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue(docs),
      })),
      find: jest.fn(() => makeCursor([])),
    } as unknown as Model<MessageDocument>;

    const retrievalService = new DmAssistantRetrievalService();
    const result = await retrievalService.retrieveContext(
      {
        organizationId: orgId,
        conversationId: convId,
        triggerMessageId: triggerId,
        triggerCreatedAt: triggerNow,
        question,
        timezone: 'Asia/Ho_Chi_Minh',
        maxMessages: 80,
        maxChars: 24_000,
      },
      mockModel,
    );

    const payload = buildSagDmAssistantPayload({
      question,
      timezone: 'Asia/Ho_Chi_Minh',
      referenceNowIso: triggerNow.toISOString(),
      queryMode: result.queryMode,
      partialCoverage: result.partialCoverage,
      coverageHint: result.coverageHint,
      messages: result.messages,
    });
    const serializedBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');

    expect(serializedBytes).toBeLessThanOrEqual(MAX_SAG_REQUEST_JSON_BYTES);
    expect(serializedBytes).toBeLessThan(131_072);
    expect(result.partialCoverage).toBe(true);
    expect(result.coverageHint).toBeTruthy();
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(docs.length);
    // Highest-ranked hit (docs[0], rank 0) MUST be preserved even though it has the oldest timestamp!
    expect(result.messages.map((m) => String(m.messageId))).toContain(
      String(docs[0]._id),
    );
    // Ref IDs must be strictly contiguous M1..Mk
    expect(result.messages.map((m) => m.refId)).toEqual(
      result.messages.map((_, idx) => `M${idx + 1}`),
    );

    // Single oversized top-hit message under tight byte cap is truncated safely without lone UTF-16 surrogates
    const tightResult = await retrievalService.retrieveContext(
      {
        organizationId: orgId,
        conversationId: convId,
        triggerMessageId: triggerId,
        triggerCreatedAt: triggerNow,
        question: 'PAY-999?',
        timezone: 'Asia/Ho_Chi_Minh',
        maxMessages: 80,
        maxChars: 24_000,
        maxJsonBytes: 1024,
      },
      {
        aggregate: jest.fn(() => ({
          exec: jest.fn().mockResolvedValue([
            {
              ...docs[0],
              senderName: 'An',
              content: `PAY-999 ${'🚀ệ'.repeat(400)}`,
            },
          ]),
        })),
        find: jest.fn(() => makeCursor([])),
      } as unknown as Model<MessageDocument>,
    );
    const tightPayload = buildSagDmAssistantPayload({
      question: 'PAY-999?',
      timezone: 'Asia/Ho_Chi_Minh',
      referenceNowIso: triggerNow.toISOString(),
      queryMode: tightResult.queryMode,
      partialCoverage: tightResult.partialCoverage,
      coverageHint: tightResult.coverageHint,
      messages: tightResult.messages,
    });
    expect(
      Buffer.byteLength(JSON.stringify(tightPayload), 'utf8'),
    ).toBeLessThanOrEqual(1024);
    expect(tightResult.partialCoverage).toBe(true);
    expect(tightResult.messages).toHaveLength(1);
    expect(tightResult.messages[0].textForSag).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/,
    );
  });
});
