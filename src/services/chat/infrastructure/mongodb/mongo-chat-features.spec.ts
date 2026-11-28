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
  protected mapMessages(
    _actor: ChatActor,
    messages: MessageDocument[],
  ): Promise<ChatMessage[]> {
    return Promise.resolve(
      messages.map((m) => ({
        id: String(m._id),
        conversationId: String(m.conversationId),
        senderId: m.senderId,
        senderName: m.senderName,
        senderAvatarUrl: null,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
        editedAt: null,
        deletedAt: null,
        reactions: [],
        replyToMessageId: null,
        replyTo: null,
        attachments: [],
      })),
    );
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

it('creates forwarded message notifications inside the MongoDB transaction (BE-DATA-007)', async () => {
  const session = {
    withTransaction: jest.fn((action: () => Promise<void>) => action()),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
  const bulkWrite = jest.fn().mockResolvedValue(undefined);
  const findMembers = jest.fn().mockReturnValue({
    toArray: () =>
      Promise.resolve([{ userId: 'peer-1', notificationMode: 'ALL' }]),
  });
  let msgFindCount = 0;
  const repository = new Repository({
    startSession: () => Promise.resolve(session),
    db: {
      collection: (name: string) => {
        if (name === 'chat_members') {
          return {
            findOne: () =>
              Promise.resolve({ userId: actor.id, status: 'ACTIVE' }),
            find: findMembers,
          };
        }
        if (name === 'chat_conversations') {
          return {
            findOne: () => Promise.resolve({ type: 'ROOM', status: 'ACTIVE' }),
            updateOne: () => Promise.resolve({ matchedCount: 1 }),
          };
        }
        if (name === 'chat_conversation_messages') {
          return {
            findOne: () => {
              msgFindCount += 1;
              if (msgFindCount === 1) return Promise.resolve(null);
              return Promise.resolve({
                _id: new Types.ObjectId('507f1f77bcf86cd799439005'),
                content: 'forwarded body',
                senderName: 'Origin',
                attachments: [],
                links: [],
              });
            },
            insertOne: () => Promise.resolve({}),
          };
        }
        if (name === 'chat_notifications') {
          return { bulkWrite };
        }
        return { findOne: () => Promise.resolve(null) };
      },
    },
  } as unknown as Connection);

  await repository.forwardMessage(
    actor,
    '507f1f77bcf86cd799439003',
    '507f1f77bcf86cd799439004',
    '507f1f77bcf86cd799439005',
    'bb077bf1-0897-499d-9b82-d57510ff3b5d',
  );
  expect(session.withTransaction).toHaveBeenCalledTimes(1);
  expect(bulkWrite).toHaveBeenCalledWith(expect.any(Array), { session });
  expect(findMembers).toHaveBeenCalledWith(expect.any(Object), { session });
});

it('applies $sort and bounded $limit BEFORE $lookup stages in notifications (BE-PERF-007)', async () => {
  const aggregate = jest
    .fn<unknown, [Record<string, unknown>[]]>()
    .mockReturnValue({ toArray: () => Promise.resolve([]) });
  const repository = new Repository({
    db: { collection: () => ({ aggregate }) },
  } as unknown as Connection);

  await repository.notifications(actor, 30);
  const stages = aggregate.mock.calls[0][0];
  const sortIndex = stages.findIndex((stage) => '$sort' in stage);
  const firstLimitIndex = stages.findIndex((stage) => '$limit' in stage);
  const firstLookupIndex = stages.findIndex((stage) => '$lookup' in stage);

  expect(sortIndex).toBeGreaterThan(0);
  expect(firstLimitIndex).toBeGreaterThan(sortIndex);
  expect(firstLimitIndex).toBeLessThan(firstLookupIndex);
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

it('bumps contextRevision on DIRECT conversations atomically inside a transaction on block and unblock, with standalone fallback', async () => {
  const targetUserId = '507f1f77bcf86cd799439099';
  const dmConvId = new Types.ObjectId('507f1f77bcf86cd799439055');
  const ops: {
    collection: string;
    op: string;
    hasSession: boolean;
    filter?: unknown;
    update?: unknown;
  }[] = [];
  const session = {
    withTransaction: jest.fn((action: () => Promise<void>) => action()),
    endSession: jest.fn().mockResolvedValue(undefined),
  };

  let memberFindCall = 0;
  const makeConnection = (mode: 'tx' | 'standalone-error' | 'no-session') =>
    ({
      ...(mode === 'no-session'
        ? {}
        : {
            startSession: () =>
              Promise.resolve(
                mode === 'tx'
                  ? session
                  : {
                      withTransaction: () =>
                        Promise.reject(
                          Object.assign(
                            new Error(
                              'Transaction numbers are only allowed on a replica set member or mongos',
                            ),
                            { code: 20 },
                          ),
                        ),
                      endSession: jest.fn().mockResolvedValue(undefined),
                    },
              ),
          }),
      db: {
        collection: (name: string) => {
          if (name === 'chat_blocks') {
            return {
              updateOne: (
                filter: unknown,
                update: unknown,
                options?: { session?: unknown },
              ) => {
                ops.push({
                  collection: name,
                  op: 'updateOne',
                  hasSession: Boolean(options?.session),
                  filter,
                  update,
                });
                return Promise.resolve({ upsertedCount: 1 });
              },
              deleteOne: (filter: unknown, options?: { session?: unknown }) => {
                ops.push({
                  collection: name,
                  op: 'deleteOne',
                  hasSession: Boolean(options?.session),
                  filter,
                });
                return Promise.resolve({ deletedCount: 1 });
              },
            };
          }
          if (name === 'chat_members') {
            return {
              find: (_filter: unknown, options?: { session?: unknown }) => ({
                toArray: () => {
                  memberFindCall += 1;
                  ops.push({
                    collection: name,
                    op: `find#${memberFindCall}`,
                    hasSession: Boolean(options?.session),
                  });
                  return Promise.resolve([{ conversationId: dmConvId }]);
                },
              }),
            };
          }
          if (name === 'chat_conversations') {
            return {
              updateMany: (
                filter: unknown,
                update: unknown,
                options?: { session?: unknown },
              ) => {
                ops.push({
                  collection: name,
                  op: 'updateMany',
                  hasSession: Boolean(options?.session),
                  filter,
                  update,
                });
                return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
              },
            };
          }
          return {};
        },
      },
    }) as unknown as Connection;

  // 1. Transactional block + unblock
  const txRepo = new Repository(makeConnection('tx'));
  await txRepo.setBlock(actor, targetUserId, true);
  await txRepo.setBlock(actor, targetUserId, false);

  expect(session.withTransaction).toHaveBeenCalledTimes(2);
  const convUpdates = ops.filter((o) => o.collection === 'chat_conversations');
  expect(convUpdates).toHaveLength(2);
  for (const upd of convUpdates) {
    expect(upd.hasSession).toBe(true);
    expect(upd.update).toEqual({ $inc: { contextRevision: 1 } });
    expect(upd.filter).toMatchObject({
      organizationId: new Types.ObjectId(actor.organizationId),
      type: 'DIRECT',
    });
  }

  // 2. Standalone MongoDB code-20 fallback still writes block & bumps contextRevision cleanly
  ops.length = 0;
  const fallbackRepo = new Repository(makeConnection('standalone-error'));
  await fallbackRepo.setBlock(actor, targetUserId, true);
  expect(
    ops.some(
      (o) =>
        o.collection === 'chat_blocks' &&
        o.op === 'updateOne' &&
        o.hasSession === false,
    ),
  ).toBe(true);
  expect(
    ops.some(
      (o) =>
        o.collection === 'chat_conversations' &&
        o.op === 'updateMany' &&
        o.hasSession === false,
    ),
  ).toBe(true);
});
