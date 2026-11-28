import type {
  ChatActor,
  ChatRepository,
} from '../../application/chat.repository';
import type { RedisService } from './redis.service';
import { cachedChatRepository } from './chat-cache.repository';

const actor: ChatActor = {
  id: 'a',
  organizationId: 'org',
  name: 'A',
  avatarUrl: null,
};
function fixture() {
  const storage = new Map<string, string>();
  const redis = {
    get: jest.fn((key: string) => Promise.resolve(storage.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      storage.set(key, value);
      return Promise.resolve();
    }),
    increment: jest.fn((key: string) => {
      const value = Number(storage.get(key) ?? 0) + 1;
      storage.set(key, String(value));
      return Promise.resolve(value);
    }),
  } as unknown as RedisService;
  const isMember = jest.fn().mockResolvedValue(true);
  const listMessages = jest.fn().mockResolvedValue({
    data: [{ id: 'm', createdAt: '2026-01-01T00:00:00Z' }],
    nextCursor: { createdAt: new Date('2026-01-01'), id: 'm' },
  });
  const setPreferences = jest.fn().mockResolvedValue({ isPinned: true });
  const repository = {
    isMember,
    listMessages,
    setPreferences,
    setReaction: jest.fn().mockResolvedValue({}),
  } as unknown as ChatRepository;
  return {
    cached: cachedChatRepository(repository, redis, 'test'),
    redis,
    isMember,
    listMessages,
    setPreferences,
  };
}
it('rechecks membership on a cache hit, preserves message strings and revives only the cursor date', async () => {
  const { cached, isMember, listMessages } = fixture();
  await cached.listMessages(actor, 'conversation', 10);
  const page = await cached.listMessages(actor, 'conversation', 10);
  expect(listMessages).toHaveBeenCalledTimes(1);
  expect(isMember).toHaveBeenCalledTimes(2);
  expect(typeof page.data[0].createdAt).toBe('string');
  expect(page.nextCursor?.createdAt).toBeInstanceOf(Date);
  isMember.mockResolvedValue(false);
  listMessages.mockRejectedValue(new Error('revoked'));
  await expect(cached.listMessages(actor, 'conversation', 10)).rejects.toThrow(
    'revoked',
  );
});
it('isolates users, preserves history across preference writes and invalidates it on message changes', async () => {
  const { cached, listMessages } = fixture();
  await cached.listMessages(actor, 'conversation', 10);
  await cached.listMessages({ ...actor, id: 'b' }, 'conversation', 10);
  await cached.setPreferences(actor, 'conversation', { isPinned: true });
  await cached.listMessages(actor, 'conversation', 10);
  expect(listMessages).toHaveBeenCalledTimes(2);
  await cached.setReaction(actor, 'conversation', 'message', '👍', true);
  await cached.listMessages(actor, 'conversation', 10);
  expect(listMessages).toHaveBeenCalledTimes(3);
});
it('degrades softly to MongoDB when Redis get/set/increment fail (SEC-BE-012)', async () => {
  const { cached, redis, listMessages, setPreferences } = fixture();
  (redis.get as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));
  (redis.set as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));
  (redis.increment as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));

  const page = await cached.listMessages(actor, 'conversation', 10);
  expect(page.data).toHaveLength(1);
  expect(listMessages).toHaveBeenCalledTimes(1);

  const pref = await cached.setPreferences(actor, 'conversation', {
    isPinned: true,
  });
  expect(pref).toEqual({ isPinned: true });
  expect(setPreferences).toHaveBeenCalledTimes(1);
});

it('re-enriches cached assistant sourceReferences and active assistantState from MongoDB on cache hit while keeping human-only pages zero-overhead (P2-1)', async () => {
  const storage = new Map<string, string>();
  const redis = {
    get: jest.fn((key: string) => Promise.resolve(storage.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      storage.set(key, value);
      return Promise.resolve();
    }),
    increment: jest.fn().mockRejectedValue(new Error('REDIS_BUMP_FAILED')),
  } as unknown as RedisService;

  const isMember = jest.fn().mockResolvedValue(true);
  const humanPage = {
    data: [
      {
        id: '507f1f77bcf86cd799439011',
        conversationId: 'conv-1',
        senderId: 'a',
        senderName: 'A',
        senderAvatarUrl: null,
        content: 'Normal human message',
        createdAt: '2026-11-28T09:00:00.000Z',
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
  };
  const staleAssistantPage = {
    data: [
      {
        id: '507f1f77bcf86cd799439012',
        conversationId: 'conv-2',
        senderId: 'assistant:continuum_ai',
        senderName: 'Continuum AI',
        senderAvatarUrl: null,
        content: 'Summary [M1][M2].',
        createdAt: '2026-11-28T09:01:00.000Z',
        editedAt: null,
        deletedAt: null,
        reactions: [],
        replyToMessageId: null,
        replyTo: null,
        attachments: [],
        authorType: 'ASSISTANT',
        assistantStatus: 'COMPLETED',
        assistantMeta: {
          handle: 'continuumAI',
          queryMode: 'KEYWORD',
          partialCoverage: false,
          coverageNote: null,
          sourceState: 'FRESH',
        },
        sourceReferences: [
          {
            refId: 'M1',
            messageId: '507f1f77bcf86cd799439021',
            senderName: 'A',
            createdAt: '2026-11-28T08:00:00.000Z',
            quoteSnippet: 'Original edited quote',
            status: 'ACTIVE',
          },
          {
            refId: 'M2',
            messageId: '507f1f77bcf86cd799439022',
            senderName: 'B',
            createdAt: '2026-11-28T08:05:00.000Z',
            quoteSnippet: 'Deleted secret quote',
            status: 'ACTIVE',
          },
        ],
      },
    ],
    hasMore: false,
    nextCursor: null,
  };

  const listMessages = jest.fn((_actor: ChatActor, convId: string) =>
    Promise.resolve(convId === 'conv-1' ? humanPage : staleAssistantPage),
  );
  const messagesAround = jest.fn().mockResolvedValue(staleAssistantPage);
  const reconcileCachedMessages = jest.fn(
    (
      _actor: ChatActor,
      _convId: string | undefined,
      msgs: Record<string, unknown>[],
    ) =>
      Promise.resolve(
        msgs.map((m) => ({
          ...m,
          assistantMeta: {
            ...(m.assistantMeta as Record<string, unknown>),
            sourceState: 'HAS_EDITED_AND_DELETED',
          },
          sourceReferences: [
            {
              ...(m.sourceReferences as Record<string, unknown>[])[0],
              status: 'EDITED',
            },
            {
              ...(m.sourceReferences as Record<string, unknown>[])[1],
              status: 'DELETED',
              quoteSnippet: '',
            },
          ],
        })),
      ),
  );

  const repository = {
    isMember,
    listMessages,
    messagesAround,
    reconcileCachedMessages,
  } as unknown as ChatRepository;
  const cached = cachedChatRepository(repository, redis, 'test');

  // 1. Human-only cached page: cache hit has ZERO reconcileCachedMessages overhead!
  await cached.listMessages(actor, 'conv-1', 20);
  await cached.listMessages(actor, 'conv-1', 20);
  expect(listMessages).toHaveBeenCalledTimes(1);
  expect(reconcileCachedMessages).not.toHaveBeenCalled();

  // 2. Assistant cached page (both listMessages & messagesAround): cache hit ALWAYS reconciles!
  await cached.listMessages(actor, 'conv-2', 20);
  const hitList = await cached.listMessages(actor, 'conv-2', 20);
  expect(listMessages).toHaveBeenCalledTimes(2);
  expect(reconcileCachedMessages).toHaveBeenCalledTimes(1);
  expect(hitList.data[0].assistantMeta?.sourceState).toBe(
    'HAS_EDITED_AND_DELETED',
  );
  expect(hitList.data[0].sourceReferences?.[0].status).toBe('EDITED');
  expect(hitList.data[0].sourceReferences?.[1].status).toBe('DELETED');
  expect(hitList.data[0].sourceReferences?.[1].quoteSnippet).toBe('');

  await cached.messagesAround(actor, 'conv-2', '507f1f77bcf86cd799439012', 20);
  const hitAround = await cached.messagesAround(
    actor,
    'conv-2',
    '507f1f77bcf86cd799439012',
    20,
  );
  expect(messagesAround).toHaveBeenCalledTimes(1);
  expect(reconcileCachedMessages).toHaveBeenCalledTimes(2);
  expect(hitAround.data[0].sourceReferences?.[1].status).toBe('DELETED');
  expect(hitAround.data[0].sourceReferences?.[1].quoteSnippet).toBe('');
});
