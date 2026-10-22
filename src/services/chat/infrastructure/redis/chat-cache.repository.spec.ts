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
