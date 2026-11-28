import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import type { ChatActor } from './chat.repository';
import { ChatRealtimeService } from './chat-realtime.service';
import type { ChatIamClient } from './chat-iam.client';
import type { RedisService } from '../infrastructure/redis/redis.service';
import { ChatRealtimeGateway } from '../controllers/chat-realtime.gateway';
import type { ChatApplicationService } from './chat.service';

interface MockSocketHandle {
  socket: WebSocket;
  send: jest.Mock;
  close: jest.Mock;
}

function createMockSocket(
  send = jest.fn(),
  close = jest.fn(),
): MockSocketHandle {
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    on: jest.fn(),
    send,
    close,
    ping: jest.fn(),
    terminate: jest.fn(),
  } as unknown as WebSocket;
  return { socket, send, close };
}

function makeActor(
  id: string,
  organizationId = '507f1f77bcf86cd799439011',
): ChatActor {
  return {
    id,
    organizationId,
    name: id,
    avatarUrl: null,
  };
}

describe('ChatRealtimeService & ChatRealtimeGateway', () => {
  it('does not relay room typing to sockets outside the active member list and throttles BOTH isTyping true & false', async () => {
    const subscribers = new Map<string, (value: string) => void>();
    const redis = {
      subscribe: (channel: string, handler: (value: string) => void) => {
        subscribers.set(channel, handler);
        return Promise.resolve(() => undefined);
      },
      publish: (channel: string, value: string) => {
        subscribers.get(channel)?.(value);
        return Promise.resolve();
      },
      touchPresenceSession: () => Promise.resolve(false),
      removePresenceSession: () => Promise.resolve(false),
    } as unknown as RedisService;
    const realtime = new ChatRealtimeService(
      redis,
      {} as ChatIamClient,
      {
        get: (key: string) => (key === 'INFRA_ENABLED' ? 'true' : 'test'),
      } as unknown as ConfigService,
    );
    const activeHandle = createMockSocket();
    const removedHandle = createMockSocket();

    await realtime.onModuleInit();
    await realtime.register(
      activeHandle.socket,
      makeActor('active-user'),
      {},
      'a',
      Date.now() + 60_000,
    );
    await realtime.register(
      removedHandle.socket,
      makeActor('removed-user'),
      {},
      'b',
      Date.now() + 60_000,
    );
    realtime.subscribeConversation(activeHandle.socket, 'room-id');
    realtime.subscribeConversation(removedHandle.socket, 'room-id');
    await realtime.publishConversationEvent(
      'typing',
      makeActor('active-user').organizationId,
      'room-id',
      ['active-user'],
      { conversationId: 'room-id', userId: 'sender', isTyping: true },
    );

    expect(activeHandle.send).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'typing',
        data: { conversationId: 'room-id', userId: 'sender', isTyping: true },
      }),
    );
    expect(removedHandle.send).not.toHaveBeenCalled();

    await redis.publish(
      'test:notification.realtime.v1',
      JSON.stringify({
        version: 1,
        payload: {
          event: 'notification.created',
          organizationId: makeActor('active-user').organizationId,
          recipientIds: ['active-user'],
          data: { id: 'notification-1' },
        },
        traceContext: {},
      }),
    );
    expect(activeHandle.send).toHaveBeenLastCalledWith(
      JSON.stringify({
        event: 'notification.created',
        data: { id: 'notification-1' },
      }),
    );
    expect(removedHandle.send).not.toHaveBeenCalled();

    // SEC-BE-004: null-org notification MUST NOT broadcast across orgs
    activeHandle.send.mockClear();
    await redis.publish(
      'test:notification.realtime.v1',
      JSON.stringify({
        version: 1,
        payload: {
          event: 'notification.created',
          organizationId: null,
          recipientIds: ['active-user'],
          data: { id: 'notification-null-org' },
        },
        traceContext: {},
      }),
    );
    expect(activeHandle.send).not.toHaveBeenCalled();

    // Rapid duplicate isTyping: true AND rapid duplicate isTyping: false are both throttled
    await realtime.relayTyping(activeHandle.socket, 'room-id', true, [
      'removed-user',
    ]);
    await realtime.relayTyping(activeHandle.socket, 'room-id', true, [
      'removed-user',
    ]);
    await realtime.relayTyping(activeHandle.socket, 'room-id', false, [
      'removed-user',
    ]);
    await realtime.relayTyping(activeHandle.socket, 'room-id', false, [
      'removed-user',
    ]);
    realtime.onModuleDestroy();

    expect(
      removedHandle.send.mock.calls.map(([packet]) => {
        const event = JSON.parse(packet as string) as {
          data: { isTyping: boolean };
        };
        return event.data.isTyping;
      }),
    ).toEqual([true, false]);
  });

  it('enforces max sockets per user and global socket cap (SEC-BE-004)', async () => {
    const redis = {
      subscribe: jest.fn().mockResolvedValue(() => undefined),
      publish: jest.fn().mockResolvedValue(undefined),
      touchPresenceSession: jest.fn().mockResolvedValue(false),
      removePresenceSession: jest.fn().mockResolvedValue(false),
    } as unknown as RedisService;
    const realtime = new ChatRealtimeService(
      redis,
      {} as ChatIamClient,
      {
        get: (key: string) => {
          if (key === 'CHAT_WS_MAX_SOCKETS_PER_USER') return '2';
          if (key === 'CHAT_WS_MAX_SOCKETS_GLOBAL') return '3';
          return undefined;
        },
      } as unknown as ConfigService,
    );

    const s1 = createMockSocket();
    const s2 = createMockSocket();
    const s3 = createMockSocket();
    const s4 = createMockSocket();
    const s5 = createMockSocket();

    expect(
      await realtime.register(
        s1.socket,
        makeActor('u1'),
        {},
        't1',
        Date.now() + 60_000,
      ),
    ).toBe(true);
    expect(
      await realtime.register(
        s2.socket,
        makeActor('u1'),
        {},
        't1',
        Date.now() + 60_000,
      ),
    ).toBe(true);
    expect(
      await realtime.register(
        s3.socket,
        makeActor('u1'),
        {},
        't1',
        Date.now() + 60_000,
      ),
    ).toBe(false);
    expect(s3.close).toHaveBeenCalledWith(
      1008,
      'Too many concurrent realtime connections',
    );

    expect(
      await realtime.register(
        s4.socket,
        makeActor('u2'),
        {},
        't2',
        Date.now() + 60_000,
      ),
    ).toBe(true);
    expect(
      await realtime.register(
        s5.socket,
        makeActor('u3'),
        {},
        't3',
        Date.now() + 60_000,
      ),
    ).toBe(false);
    expect(s5.close).toHaveBeenCalledWith(
      1013,
      'Realtime connection limit reached',
    );
    realtime.onModuleDestroy();
  });

  it('enforces per-socket token-bucket RL on all WS handlers and closes expired sockets on frame arrival (SEC-BE-004)', async () => {
    const arePresenceOnlineBatch = jest.fn().mockResolvedValue([true]);
    const redis = {
      subscribe: jest.fn().mockResolvedValue(() => undefined),
      publish: jest.fn().mockResolvedValue(undefined),
      touchPresenceSession: jest.fn().mockResolvedValue(false),
      removePresenceSession: jest.fn().mockResolvedValue(false),
      arePresenceOnlineBatch,
    } as unknown as RedisService;
    const config = {
      get: () => undefined,
    } as unknown as ConfigService;
    const realtime = new ChatRealtimeService(
      redis,
      {} as ChatIamClient,
      config,
    );
    const requireSocketMember = jest.fn().mockResolvedValue(undefined);
    const socketMemberIds = jest.fn().mockResolvedValue(['u1', 'u2']);
    const watchableContacts = jest.fn().mockResolvedValue(['u2']);
    const chat = {
      requireSocketMember,
      socketMemberIds,
      watchableContacts,
    } as unknown as ChatApplicationService;
    const gateway = new ChatRealtimeGateway(config, chat, realtime);

    const sockHandle = createMockSocket();
    await realtime.register(
      sockHandle.socket,
      makeActor('u1'),
      {},
      't1',
      Date.now() + 60_000,
    );
    for (let i = 0; i < 10; i += 1) {
      await gateway.typing(sockHandle.socket, {
        conversationId: 'c1',
        isTyping: false,
      });
    }
    expect(requireSocketMember).toHaveBeenCalledTimes(10);
    sockHandle.send.mockClear();
    await gateway.typing(sockHandle.socket, {
      conversationId: 'c1',
      isTyping: false,
    });
    expect(requireSocketMember).toHaveBeenCalledTimes(10);
    expect(sockHandle.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'error', data: { code: 'CHAT_RATE_LIMITED' } }),
    );

    for (let i = 0; i < 5; i += 1) {
      await gateway.watchPresence(sockHandle.socket, { userIds: ['u2'] });
    }
    sockHandle.send.mockClear();
    await gateway.watchPresence(sockHandle.socket, { userIds: ['u2'] });
    expect(watchableContacts).toHaveBeenCalledTimes(5);
    expect(sockHandle.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'error', data: { code: 'CHAT_RATE_LIMITED' } }),
    );

    for (let i = 0; i < 10; i += 1) {
      gateway.heartbeat(sockHandle.socket);
    }
    sockHandle.send.mockClear();
    gateway.heartbeat(sockHandle.socket);
    expect(sockHandle.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'error', data: { code: 'CHAT_RATE_LIMITED' } }),
    );

    const expiringHandle = createMockSocket();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await realtime.register(
      expiringHandle.socket,
      makeActor('u2'),
      {},
      't2',
      1_005_000,
    );
    nowSpy.mockReturnValue(1_006_000);
    gateway.heartbeat(expiringHandle.socket);
    expect(expiringHandle.close).toHaveBeenCalledWith(1008, 'Session expired');
    nowSpy.mockRestore();
    realtime.onModuleDestroy();
  });

  it('evicts blocked users from presenceWatchers, kicks from conversationSockets, and closes revoked sessions immediately (SEC-BE-004)', async () => {
    const subscribers = new Map<string, (value: string) => void>();
    const arePresenceOnlineBatch = jest.fn().mockResolvedValue([true]);
    const redis = {
      subscribe: (channel: string, handler: (value: string) => void) => {
        subscribers.set(channel, handler);
        return Promise.resolve(() => undefined);
      },
      publish: (channel: string, value: string) => {
        subscribers.get(channel)?.(value);
        return Promise.resolve();
      },
      touchPresenceSession: jest.fn().mockResolvedValue(false),
      removePresenceSession: jest.fn().mockResolvedValue(false),
      arePresenceOnlineBatch,
    } as unknown as RedisService;
    const realtime = new ChatRealtimeService(
      redis,
      {} as ChatIamClient,
      {
        get: (key: string) => (key === 'INFRA_ENABLED' ? 'true' : 'test'),
      } as unknown as ConfigService,
    );
    await realtime.onModuleInit();

    const blockerHandle = createMockSocket();
    const blockedHandle = createMockSocket();
    const orgId = '507f1f77bcf86cd799439011';
    await realtime.register(
      blockerHandle.socket,
      makeActor('blocker', orgId),
      {},
      'tok-1',
      Date.now() + 60_000,
    );
    await realtime.register(
      blockedHandle.socket,
      makeActor('blocked', orgId),
      {},
      'tok-2',
      Date.now() + 60_000,
    );

    await realtime.watchPresence(blockedHandle.socket, ['blocker']);
    expect(arePresenceOnlineBatch).toHaveBeenCalledTimes(1);

    await realtime.evictBlockedPresence(orgId, 'blocker', 'blocked');
    blockedHandle.send.mockClear();

    await redis.publish(
      'test:chat:events:v1',
      JSON.stringify({
        type: 'presence',
        userId: 'blocker',
        organizationId: orgId,
        isOnline: false,
      }),
    );
    expect(blockedHandle.send).not.toHaveBeenCalled();

    realtime.subscribeConversation(blockedHandle.socket, 'conv-1');
    await realtime.evictConversationMembers(orgId, 'conv-1', ['blocked']);
    await realtime.publishConversationEvent(
      'typing',
      orgId,
      'conv-1',
      ['blocked'],
      { isTyping: true },
    );
    expect(blockedHandle.send).not.toHaveBeenCalled();

    await realtime.revokeSessions({ userId: 'blocked', organizationId: orgId });
    expect(blockedHandle.close).toHaveBeenCalledWith(1008, 'Session revoked');

    realtime.onModuleDestroy();
  });

  it('forces IAM revalidation when Redis revocation lookup fails instead of silently skipping (SEC-BE-004)', async () => {
    const redis = {
      subscribe: jest.fn().mockResolvedValue(() => undefined),
      publish: jest.fn().mockResolvedValue(undefined),
      touchPresenceSession: jest.fn().mockResolvedValue(false),
      removePresenceSession: jest.fn().mockResolvedValue(false),
      areTokensRevokedBatch: jest
        .fn()
        .mockRejectedValue(new Error('REDIS_DOWN')),
    } as unknown as RedisService;
    const getActor = jest.fn().mockRejectedValue(new Error('401 revoked'));
    const iam = { getActor } as unknown as ChatIamClient;
    const realtime = new ChatRealtimeService(redis, iam, {
      get: () => undefined,
    } as unknown as ConfigService);
    const sockHandle = createMockSocket();
    await realtime.register(
      sockHandle.socket,
      makeActor('u1'),
      {},
      't1',
      Date.now() + 60_000,
    );

    await (
      realtime as unknown as { pingAndExpireSessions: () => Promise<void> }
    ).pingAndExpireSessions();

    expect(getActor).toHaveBeenCalledTimes(1);
    expect(sockHandle.close).toHaveBeenCalledWith(1008, 'Session expired');
    realtime.onModuleDestroy();
  });

  it('retries Redis pub/sub startup failures with backoff and recovers once Redis is up (BE-REL-007)', async () => {
    jest.useFakeTimers();
    try {
      const subscribers = new Map<string, (value: string) => void>();
      let eventAttempts = 0;
      const redis = {
        subscribe: jest.fn(
          (channel: string, handler: (value: string) => void) => {
            if (channel.includes(':chat:events:v1')) {
              eventAttempts += 1;
              if (eventAttempts === 1) {
                return Promise.reject(new Error('ECONNREFUSED'));
              }
            }
            subscribers.set(channel, handler);
            return Promise.resolve(() => undefined);
          },
        ),
        publish: jest.fn((channel: string, value: string) => {
          subscribers.get(channel)?.(value);
          return Promise.resolve();
        }),
        touchPresenceSession: jest.fn().mockResolvedValue(false),
        removePresenceSession: jest.fn().mockResolvedValue(false),
      } as unknown as RedisService;
      const realtime = new ChatRealtimeService(
        redis,
        {} as ChatIamClient,
        {
          get: (key: string) => (key === 'INFRA_ENABLED' ? 'true' : 'test'),
        } as unknown as ConfigService,
      );

      await realtime.onModuleInit();
      expect(eventAttempts).toBe(1);

      await jest.advanceTimersByTimeAsync(2_000);
      expect(eventAttempts).toBe(2);
      expect(subscribers.has('test:chat:events:v1')).toBe(true);

      const sockHandle = createMockSocket();
      await realtime.register(
        sockHandle.socket,
        makeActor('u1'),
        {},
        't1',
        Date.now() + 60_000,
      );
      await realtime.publishConversationEvent(
        'message.created',
        '507f1f77bcf86cd799439011',
        'c1',
        ['u1'],
        { id: 'm1' },
      );
      expect(sockHandle.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'message.created', data: { id: 'm1' } }),
      );
      realtime.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('delivers assistant/conversation events strictly to non-expired, deduplicated authorized recipients only (P1-1)', async () => {
    const subscribers = new Map<string, (value: string) => void>();
    const redis = {
      subscribe: (channel: string, handler: (value: string) => void) => {
        subscribers.set(channel, handler);
        return Promise.resolve(() => undefined);
      },
      publish: (channel: string, value: string) => {
        subscribers.get(channel)?.(value);
        return Promise.resolve();
      },
      touchPresenceSession: jest.fn().mockResolvedValue(false),
      removePresenceSession: jest.fn().mockResolvedValue(false),
    } as unknown as RedisService;
    const realtime = new ChatRealtimeService(
      redis,
      {} as ChatIamClient,
      {
        get: (key: string) => (key === 'INFRA_ENABLED' ? 'true' : 'test'),
      } as unknown as ConfigService,
    );
    await realtime.onModuleInit();

    const orgId = '507f1f77bcf86cd799439011';
    const userA = createMockSocket();
    const userBRevoked = createMockSocket();
    const userCExpired = createMockSocket();

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      await realtime.register(
        userA.socket,
        makeActor('user-a', orgId),
        {},
        'tok-a',
        1_060_000,
      );
      await realtime.register(
        userBRevoked.socket,
        makeActor('user-b', orgId),
        {},
        'tok-b',
        1_060_000,
      );
      await realtime.register(
        userCExpired.socket,
        makeActor('user-c', orgId),
        {},
        'tok-c',
        1_005_000,
      );

      // Advance time past userCExpired's expiresAt without running heartbeat yet
      nowSpy.mockReturnValue(1_010_000);

      // Publish assistant message ONLY to caller-verified [user-a, user-a (duplicate), user-c (expired)]
      // user-b is excluded by caller IAM check; user-c is expired on its socket!
      await realtime.publishConversationEvent(
        'message.created',
        orgId,
        'dm-1',
        ['user-a', 'user-a', 'user-c'],
        { id: 'ai-msg-1', authorType: 'ASSISTANT' },
      );

      expect(userA.send).toHaveBeenCalledTimes(1);
      expect(userA.send).toHaveBeenCalledWith(
        JSON.stringify({
          event: 'message.created',
          data: { id: 'ai-msg-1', authorType: 'ASSISTANT' },
        }),
      );
      expect(userBRevoked.send).not.toHaveBeenCalled();
      expect(userCExpired.send).not.toHaveBeenCalled();
      expect(userCExpired.close).toHaveBeenCalledWith(1008, 'Session expired');
    } finally {
      nowSpy.mockRestore();
      realtime.onModuleDestroy();
    }
  });

  it('filters recipients through CHAT_ORG_MEMBERSHIP_CHECKER on publish & cross-pod delivery, fails closed, and revokes open sockets of IAM-revoked peers (R2-P1)', async () => {
    const subscribers = new Map<string, (value: string) => void>();
    const redis = {
      subscribe: (channel: string, handler: (value: string) => void) => {
        subscribers.set(channel, handler);
        return Promise.resolve(() => undefined);
      },
      publish: (channel: string, value: string) => {
        subscribers.get(channel)?.(value);
        return Promise.resolve();
      },
      touchPresenceSession: jest.fn().mockResolvedValue(false),
      removePresenceSession: jest.fn().mockResolvedValue(false),
    } as unknown as RedisService;

    const orgId = '507f1f77bcf86cd799439011';
    const activeStatus = new Map<string, boolean | 'THROW'>([
      ['user-a', true],
      ['user-b', false],
      ['user-c', 'THROW'],
    ]);
    const orgMembershipChecker = {
      isActiveOrganizationMember: jest.fn((_org: string, userId: string) => {
        const state = activeStatus.get(userId);
        if (state === 'THROW') {
          return Promise.reject(new Error('IAM_DB_UNAVAILABLE'));
        }
        return Promise.resolve(state === true);
      }),
    };

    const realtime = new ChatRealtimeService(
      redis,
      {} as ChatIamClient,
      {
        get: (key: string) => (key === 'INFRA_ENABLED' ? 'true' : 'test'),
      } as unknown as ConfigService,
      undefined,
      orgMembershipChecker,
    );
    await realtime.onModuleInit();

    const userA = createMockSocket();
    const userB = createMockSocket();
    const userC = createMockSocket();
    await realtime.register(
      userA.socket,
      makeActor('user-a', orgId),
      {},
      'tok-a',
      Date.now() + 60_000,
    );
    await realtime.register(
      userB.socket,
      makeActor('user-b', orgId),
      {},
      'tok-b',
      Date.now() + 60_000,
    );
    await realtime.register(
      userC.socket,
      makeActor('user-c', orgId),
      {},
      'tok-c',
      Date.now() + 60_000,
    );

    await realtime.publishConversationEvent(
      'message.created',
      orgId,
      'dm-1',
      ['user-a', 'user-b', 'user-c'],
      { id: 'msg-1', content: '@continuumAI secret' },
    );
    await realtime.publishConversationEvent(
      'assistant.status',
      orgId,
      'dm-1',
      ['user-a', 'user-b', 'user-c'],
      { status: 'PENDING', jobId: 'job-1' },
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(userA.send).toHaveBeenCalledTimes(2);
    expect(userB.send).not.toHaveBeenCalled();
    expect(userB.close).toHaveBeenCalledWith(1008, 'Session revoked');
    expect(userC.send).not.toHaveBeenCalled();
    // Transient IAM check error fails closed without falsely closing socket as revoked
    expect(userC.close).not.toHaveBeenCalled();

    // Cross-pod notification arriving via Redis pub/sub also enforces live IAM check & revokes newly revoked user
    const userD = createMockSocket();
    activeStatus.set('user-d', false);
    await realtime.register(
      userD.socket,
      makeActor('user-d', orgId),
      {},
      'tok-d',
      Date.now() + 60_000,
    );
    userA.send.mockClear();
    await redis.publish(
      'test:notification.realtime.v1',
      JSON.stringify({
        version: 1,
        payload: {
          event: 'notification.created',
          organizationId: orgId,
          recipientIds: ['user-a', 'user-d'],
          data: { id: 'notif-1' },
        },
        traceContext: {},
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(userA.send).toHaveBeenCalledTimes(1);
    expect(userD.send).not.toHaveBeenCalled();
    expect(userD.close).toHaveBeenCalledWith(1008, 'Session revoked');
    realtime.onModuleDestroy();
  });
});
