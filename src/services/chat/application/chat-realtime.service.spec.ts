import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import type { ChatActor } from './chat.repository';
import { ChatRealtimeService } from './chat-realtime.service';
import type { ChatIamClient } from './chat-iam.client';
import type { RedisService } from '../infrastructure/redis/redis.service';

describe('ChatRealtimeService', () => {
  it('does not relay room typing to sockets outside the active member list', async () => {
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
    } as unknown as RedisService;
    const realtime = new ChatRealtimeService(
      redis,
      {} as ChatIamClient,
      {
        get: (key: string) => (key === 'INFRA_ENABLED' ? 'true' : 'test'),
      } as unknown as ConfigService,
    );
    const sentToActiveMember = jest.fn();
    const sentToRemovedMember = jest.fn();
    const socket = (send: jest.Mock) =>
      ({
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        on: jest.fn(),
        send,
      }) as unknown as WebSocket;
    const activeSocket = socket(sentToActiveMember);
    const removedSocket = socket(sentToRemovedMember);
    const actor = (id: string): ChatActor => ({
      id,
      organizationId: '507f1f77bcf86cd799439011',
      name: id,
      avatarUrl: null,
    });

    await realtime.onModuleInit();
    await realtime.register(
      activeSocket,
      actor('active-user'),
      {},
      'a',
      Date.now() + 60_000,
    );
    await realtime.register(
      removedSocket,
      actor('removed-user'),
      {},
      'b',
      Date.now() + 60_000,
    );
    realtime.subscribeConversation(activeSocket, 'room-id');
    realtime.subscribeConversation(removedSocket, 'room-id');
    await realtime.publishConversationEvent(
      'typing',
      actor('active-user').organizationId,
      'room-id',
      ['active-user'],
      { conversationId: 'room-id', userId: 'sender', isTyping: true },
    );

    expect(sentToActiveMember).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'typing',
        data: { conversationId: 'room-id', userId: 'sender', isTyping: true },
      }),
    );
    expect(sentToRemovedMember).not.toHaveBeenCalled();

    await redis.publish(
      'test:notification.realtime.v1',
      JSON.stringify({
        version: 1,
        payload: {
          event: 'notification.created',
          organizationId: actor('active-user').organizationId,
          recipientIds: ['active-user'],
          data: { id: 'notification-1' },
        },
        traceContext: {},
      }),
    );
    expect(sentToActiveMember).toHaveBeenLastCalledWith(
      JSON.stringify({
        event: 'notification.created',
        data: { id: 'notification-1' },
      }),
    );
    expect(sentToRemovedMember).not.toHaveBeenCalled();

    await realtime.relayTyping(activeSocket, 'room-id', true, ['removed-user']);
    await realtime.relayTyping(activeSocket, 'room-id', true, ['removed-user']);
    await realtime.relayTyping(activeSocket, 'room-id', false, [
      'removed-user',
    ]);
    realtime.onModuleDestroy();

    expect(
      sentToRemovedMember.mock.calls.map(([packet]) => {
        const event = JSON.parse(packet as string) as {
          data: { isTyping: boolean };
        };
        return event.data.isTyping;
      }),
    ).toEqual([true, false]);
  });
});
