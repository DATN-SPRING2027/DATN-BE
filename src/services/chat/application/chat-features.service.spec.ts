import type { ChatRepository } from './chat.repository';
import type { ChatIamClient } from './chat-iam.client';
import type { ChatRealtimeService } from './chat-realtime.service';
import { ChatFeaturesService } from './chat-features.service';

const actor = {
  id: '507f1f77bcf86cd799439001',
  organizationId: '507f1f77bcf86cd799439002',
};
const cid = '507f1f77bcf86cd799439003';
function fixture() {
  const repository = {
    setPreferences: jest.fn().mockResolvedValue({ isPinned: true }),
    searchAcross: jest.fn().mockResolvedValue({ data: [], nextCursor: null }),
    saveDraft: jest.fn(),
  } as unknown as jest.Mocked<ChatRepository>;
  const iam = {
    getActor: jest.fn().mockResolvedValue(actor),
  } as unknown as ChatIamClient;
  const realtime = {
    publishConversationEvent: jest.fn().mockResolvedValue(undefined),
  } as unknown as ChatRealtimeService;
  return {
    service: new ChatFeaturesService(repository, iam, realtime),
    repository,
  };
}
it('rejects extra preference fields and malformed values without writing', async () => {
  const { service, repository } = fixture();
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
  expect(repository.setPreferences.mock.calls).toHaveLength(0);
  await service.preferences({}, cid, { isPinned: true });
  expect(repository.setPreferences.mock.calls[0]).toEqual([
    actor,
    cid,
    { isPinned: true },
  ]);
});
it('validates global search filters and forwards the authenticated organization scope', async () => {
  const { service, repository } = fixture();
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
  expect(repository.searchAcross.mock.calls[0]).toEqual([
    actor,
    { q: 'xin chào', conversationId: cid, kind: 'IMAGE' },
    20,
    undefined,
  ]);
});
it('bounds draft content and never accepts another user identifier', async () => {
  const { service, repository } = fixture();
  await expect(
    service.draft({}, cid, { content: 'a'.repeat(8001) }),
  ).rejects.toMatchObject({ status: 422 });
  await expect(
    service.draft({}, cid, { content: 'text', userId: 'someone' }),
  ).rejects.toMatchObject({ status: 422 });
  expect(repository.saveDraft.mock.calls).toHaveLength(0);
});
