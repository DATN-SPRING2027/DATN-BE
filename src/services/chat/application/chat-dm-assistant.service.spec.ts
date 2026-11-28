import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AI_ENGINE_CLIENT } from '../../../integrations/ai-engine/ai-engine.port';
import { HttpAiEngineClient } from '../../../integrations/ai-engine/http-ai-engine.client';
import { ChatModule } from '../chat.module';
import { ChatApplicationService } from './chat.service';
import { ChatFeaturesService } from './chat-features.service';
import {
  CHAT_ORG_MEMBERSHIP_CHECKER,
  CONTINUUM_AI_HANDLE,
  extractAssistantQuery,
} from './chat-dm-assistant.types';
import { Types, type Model } from 'mongoose';
import {
  DmAssistantRetrievalService,
  parseAssistantQuery,
} from './chat-dm-assistant-retrieval.service';
import type { MessageDocument } from '../infrastructure/mongodb/mongo-chat.repository';
import { ChatDmAssistantWorkerService } from './chat-dm-assistant.worker';
import { MongoChatOrgMembershipChecker } from '../infrastructure/mongodb/mongo-chat-org-membership.checker';
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

  function makeServices(configValues: Record<string, unknown> = {}) {
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
    const listConversations = jest.fn();
    const getConversation = jest.fn();
    const saveDraft = jest.fn();
    const getDraft = jest.fn();
    const repository = {
      sendMessage,
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
    const realtime = {
      publishConversationEvent,
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
    );
    const featuresService = new ChatFeaturesService(
      repository,
      iam,
      realtime,
      historyCache,
      redis,
      config,
    );

    return {
      chatService,
      featuresService,
      repository,
      sendMessage,
      listConversations,
      getConversation,
      saveDraft,
      getDraft,
      consumeRateLimit,
      publishConversationEvent,
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
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [ChatModule],
      }).compile();

      const aiClient = moduleRef.get<unknown>(AI_ENGINE_CLIENT);
      const orgChecker = moduleRef.get<unknown>(CHAT_ORG_MEMBERSHIP_CHECKER);
      const worker = moduleRef.get<ChatDmAssistantWorkerService>(
        ChatDmAssistantWorkerService,
      );

      expect(aiClient).toBeInstanceOf(HttpAiEngineClient);
      expect(orgChecker).toBeInstanceOf(MongoChatOrgMembershipChecker);
      expect(worker).toBeInstanceOf(ChatDmAssistantWorkerService);

      // Fail-closed when connection is absent (never returns true without verifying IAM)
      await expect(
        (
          orgChecker as MongoChatOrgMembershipChecker
        ).isActiveOrganizationMember(
          '507f1f77bcf86cd799439001',
          '507f1f77bcf86cd799439011',
        ),
      ).rejects.toThrow(/unavailable/i);

      await moduleRef.close();
    } finally {
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
});
