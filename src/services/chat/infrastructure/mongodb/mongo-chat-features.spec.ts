import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import { MongoChatFeatures } from './mongo-chat-features';
import type { ChatActor, ChatMessage } from '../../application/chat.repository';
import type { MessageDocument } from './mongo-chat.repository';

const actor: ChatActor = {
  id: '507f1f77bcf86cd799439001',
  organizationId: '507f1f77bcf86cd799439002',
  name: 'Actor',
  avatarUrl: null,
};
class Repository extends MongoChatFeatures {
  protected requireMember() {
    return Promise.resolve();
  }
  protected mapMessages(): Promise<ChatMessage[]> {
    return Promise.resolve([]);
  }
  notify(message: MessageDocument) {
    return this.createNotifications(actor, message);
  }
  markNotifications(message: MessageDocument) {
    return this.readNotificationsThrough(
      actor,
      String(message.conversationId),
      message,
    );
  }
}
it('marks notifications read only through the observed cursor for the current member', async () => {
  const updateMany = jest
    .fn<Promise<unknown>, [Record<string, unknown>, unknown]>()
    .mockResolvedValue({});
  const repository = new Repository({
    db: { collection: () => ({ updateMany }) },
  } as unknown as Connection);
  const message = {
    _id: new Types.ObjectId(),
    conversationId: new Types.ObjectId(),
    createdAt: new Date(),
  } as MessageDocument;
  await repository.markNotifications(message);
  const filter = updateMany.mock.calls[0][0];
  expect(filter).toMatchObject({
    organizationId: new Types.ObjectId(actor.organizationId),
    userId: actor.id,
    conversationId: message.conversationId,
    readAt: null,
  });
  expect(JSON.stringify(filter)).toContain('$lte');
});
it('transfers the owner role atomically without rewriting the original creator', async () => {
  const changes: { collection: string; update: unknown }[] = [];
  const session = {
    withTransaction: (action: () => Promise<void>) => action(),
    endSession: jest.fn(),
  };
  const repository = new Repository({
    startSession: () => Promise.resolve(session),
    db: {
      collection: (name: string) => ({
        findOne: () => Promise.resolve({ userId: actor.id, role: 'OWNER' }),
        updateOne: (_filter: unknown, update: unknown) => {
          changes.push({ collection: name, update });
          return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
        },
      }),
    },
  } as unknown as Connection);
  await repository.transferOwnership(
    actor,
    '507f1f77bcf86cd799439003',
    '507f1f77bcf86cd799439004',
  );
  expect(changes.map((change) => change.update)).toEqual([
    { $inc: { membershipVersion: 1 } },
    { $set: { role: 'MEMBER' } },
    { $set: { role: 'OWNER' } },
  ]);
  expect(JSON.stringify(changes)).not.toContain('createdBy');
  expect(session.endSession).toHaveBeenCalled();
});
it('reports observed acknowledgment times separately from cursor timestamps and preserves unknown legacy times', async () => {
  const messageId = new Types.ObjectId('507f1f77bcf86cd799439005');
  const cursorTime = new Date('2026-10-21T10:00:00Z');
  const readTime = new Date('2026-10-21T12:00:00Z');
  const repository = new Repository({
    db: {
      collection: (name: string) =>
        name === 'chat_conversation_messages'
          ? {
              findOne: () =>
                Promise.resolve({
                  _id: messageId,
                  senderId: actor.id,
                  createdAt: cursorTime,
                }),
            }
          : {
              findOne: () => Promise.resolve({ userId: actor.id }),
              find: () => ({
                toArray: () =>
                  Promise.resolve([
                    {
                      userId: 'peer',
                      displayName: 'Peer',
                      lastReadMessageId: messageId,
                      lastReadAt: cursorTime,
                      readRecordedAt: readTime,
                      lastDeliveredMessageId: messageId,
                      lastDeliveredAt: cursorTime,
                    },
                  ]),
              }),
            },
    },
  } as unknown as Connection);
  const result = await repository.receipts(
    actor,
    '507f1f77bcf86cd799439003',
    String(messageId),
  );
  expect(result.data[0]).toMatchObject({
    read: true,
    delivered: true,
    readAt: readTime.toISOString(),
    deliveredAt: null,
  });
});
it('filters live membership before the global-search page limit and excludes deleted messages', async () => {
  const aggregate = jest
    .fn<unknown, [Record<string, unknown>[]]>()
    .mockReturnValue({ toArray: () => Promise.resolve([]) });
  const repository = new Repository({
    db: { collection: () => ({ aggregate }) },
  } as unknown as Connection);
  await repository.searchAcross(actor, { q: 'xin chao', kind: 'DOCUMENT' }, 20);
  const stages = aggregate.mock.calls[0][0];
  expect(JSON.stringify(stages[0])).toContain(actor.organizationId);
  expect(JSON.stringify(stages)).not.toMatch(/\$regex|wildcard/);
  const access = stages.findIndex((stage) =>
    JSON.stringify(stage).includes('access.0'),
  );
  expect(access).toBeLessThan(stages.findIndex((stage) => '$limit' in stage));
  expect(JSON.stringify(stages)).toContain('deletedAt');
  expect(JSON.stringify(stages)).toContain('DOCUMENT');
});
it('does not load source contents when a forwarding caller lacks membership', async () => {
  const collections: string[] = [];
  const session = {
    withTransaction: (action: () => Promise<void>) => action(),
    endSession: jest.fn(),
  };
  const repository = new Repository({
    startSession: () => Promise.resolve(session),
    db: {
      collection: (name: string) => {
        collections.push(name);
        return { findOne: () => Promise.resolve(null) };
      },
    },
  } as unknown as Connection);
  await expect(
    repository.forwardMessage(
      actor,
      '507f1f77bcf86cd799439003',
      '507f1f77bcf86cd799439004',
      '507f1f77bcf86cd799439005',
      'client',
    ),
  ).rejects.toMatchObject({ status: 404 });
  expect(collections).not.toContain('chat_conversation_messages');
  expect(session.endSession).toHaveBeenCalled();
});
it('honors mention-only preferences and deduplicates notifications by message and recipient', async () => {
  const bulkWrite = jest.fn().mockResolvedValue(undefined);
  const repository = new Repository({
    db: {
      collection: (name: string) =>
        name === 'chat_members'
          ? {
              find: () => ({
                toArray: () =>
                  Promise.resolve([
                    { userId: 'all', notificationMode: 'ALL' },
                    { userId: 'mentioned', notificationMode: 'MENTIONS' },
                    { userId: 'not-mentioned', notificationMode: 'MENTIONS' },
                  ]),
              }),
            }
          : { bulkWrite },
    },
  } as unknown as Connection);
  await repository.notify({
    _id: new Types.ObjectId(),
    conversationId: new Types.ObjectId(),
    content: 'Hello',
    createdAt: new Date(),
    mentionUserIds: ['mentioned'],
  } as MessageDocument);
  const writes = (bulkWrite.mock.calls as unknown[][])[0][0] as {
    updateOne: { filter: { userId: string } };
  }[];
  expect(writes.map((write) => write.updateOne.filter.userId)).toEqual([
    'all',
    'mentioned',
  ]);
  expect(JSON.stringify(writes)).toContain('messageId');
  expect(JSON.stringify(writes)).toContain('upsert');
});
