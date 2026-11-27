import type { ChatRepository } from './chat.repository';
import type { ChatIamClient } from './chat-iam.client';
import type { ChatHistoryCacheInvalidator } from './chat-history-cache';
import type { ChatRealtimeService } from './chat-realtime.service';
import type { RedisService } from '../infrastructure/redis/redis.service';
import { ChatFeaturesService } from './chat-features.service';

const actor = {
  id: '507f1f77bcf86cd799439001',
  organizationId: '507f1f77bcf86cd799439002',
};
const cid = '507f1f77bcf86cd799439003';
const mid = '507f1f77bcf86cd799439004';
const targetUserId = '507f1f77bcf86cd799439005';

function fixture() {
  const setPreferences = jest.fn().mockResolvedValue({ isPinned: true });
  const searchAcross = jest
    .fn()
    .mockResolvedValue({ data: [], nextCursor: null });
  const saveDraft = jest.fn();
  const pinMessage = jest.fn().mockResolvedValue(undefined);
  const forwardMessage = jest
    .fn()
    .mockResolvedValue({ id: mid, content: 'hi' });
  const memberIds = jest.fn().mockResolvedValue([actor.id, targetUserId]);
  const setBlock = jest.fn().mockResolvedValue(undefined);
  const repository = {
    setPreferences,
    searchAcross,
    saveDraft,
    pinMessage,
    forwardMessage,
    memberIds,
    setBlock,
  } as unknown as ChatRepository;
  const getActor = jest.fn().mockResolvedValue(actor);
  const getCandidates = jest.fn().mockResolvedValue({
    actor,
    data: [{ id: targetUserId, fullName: 'Target', avatarUrl: null }],
  });
  const iam = { getActor, getCandidates } as unknown as ChatIamClient;
  const publishConversationEvent = jest.fn().mockResolvedValue(undefined);
  const evictBlockedPresence = jest.fn().mockResolvedValue(undefined);
  const realtime = {
    publishConversationEvent,
    evictBlockedPresence,
  } as unknown as ChatRealtimeService;
  const invalidate = jest.fn().mockResolvedValue(undefined);
  const historyCache = { invalidate } as unknown as ChatHistoryCacheInvalidator;
  const consumeRateLimit = jest.fn().mockResolvedValue(true);
  const redis = { consumeRateLimit } as unknown as RedisService;
  return {
    service: new ChatFeaturesService(
      repository,
      iam,
      realtime,
      historyCache,
      redis,
    ),
    setPreferences,
    searchAcross,
    saveDraft,
    getCandidates,
    evictBlockedPresence,
    invalidate,
    consumeRateLimit,
  };
}

it('rejects extra preference fields and malformed values without writing', async () => {
  const { service, setPreferences } = fixture();
  for (const changes of [
    { userId: actor.id },
    { isPinned: 'true' },
    { notificationMode: 'EVERYTHING' },
    {},
  ]) {
    await expect(service.preferences({}, cid, changes)).rejects.toMatchObject({
      status: 422,
    });
  }
  expect(setPreferences.mock.calls).toHaveLength(0);
  await service.preferences({}, cid, { isPinned: true });
  expect(setPreferences.mock.calls[0]).toEqual([
    actor,
    cid,
    { isPinned: true },
  ]);
});

it('validates global search filters and forwards the authenticated organization scope', async () => {
  const { service, searchAcross } = fixture();
  await expect(
    service.search({}, { q: 'hello', from: '2026-12-01', to: '2026-01-01' }),
  ).rejects.toMatchObject({ status: 422 });
  await expect(
    service.search({}, { q: 'hello', conversationId: 'wrong' }),
  ).rejects.toMatchObject({ status: 422 });
  await service.search(
    {},
    { q: '  xin chào ', conversationId: cid, kind: 'IMAGE', limit: '20' },
  );
  expect(searchAcross.mock.calls[0]).toEqual([
    actor,
    { q: 'xin chào', conversationId: cid, kind: 'IMAGE' },
    20,
    undefined,
  ]);
});

it('bounds draft content and never accepts another user identifier', async () => {
  const { service, saveDraft } = fixture();
  await expect(
    service.draft({}, cid, { content: 'a'.repeat(8001) }),
  ).rejects.toMatchObject({ status: 422 });
  await expect(
    service.draft({}, cid, { content: 'text', userId: 'someone' }),
  ).rejects.toMatchObject({ status: 422 });
  expect(saveDraft.mock.calls).toHaveLength(0);
});

it('invalidates Redis history-version cache on pin/unpin and forward (BE-DATA-008)', async () => {
  const { service, invalidate } = fixture();
  await service.pin({}, cid, mid, { active: true });
  await service.pin({}, cid, mid, { active: false });
  await service.forward({}, cid, {
    sourceConversationId: '507f1f77bcf86cd799439006',
    messageId: mid,
    clientMessageId: 'bb077bf1-0897-499d-9b82-d57510ff3b5d',
  });
  expect(invalidate).toHaveBeenCalledTimes(3);
  expect(invalidate).toHaveBeenCalledWith(actor.organizationId, cid);
});

it('evicts blocked user from presenceWatchers immediately on block and rate-limits before IAM candidates (SEC-BE-004 / SEC-BE-012)', async () => {
  const { service, evictBlockedPresence, getCandidates, consumeRateLimit } =
    fixture();
  await service.block({}, targetUserId, { active: true });
  expect(evictBlockedPresence).toHaveBeenCalledWith(
    actor.organizationId,
    actor.id,
    targetUserId,
  );

  getCandidates.mockClear();
  consumeRateLimit.mockResolvedValue(false);
  await expect(
    service.block({}, targetUserId, { active: true }),
  ).rejects.toMatchObject({ status: 429 });
  expect(getCandidates).not.toHaveBeenCalled();
});
