import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import type { ChatActor } from '../../application/chat.repository';
import { CHAT_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
import { MongoChatRepository } from './mongo-chat.repository';

describe('MongoChatRepository message history, transactions, redaction & indexes', () => {
  it('returns bounded chronological context and an older cursor, including tied timestamps', async () => {
    const scope = {
      organizationId: new Types.ObjectId('507f1f77bcf86cd799439002'),
      conversationId: new Types.ObjectId('507f1f77bcf86cd799439003'),
    };
    const stored = (index: number) => ({
      ...scope,
      _id: new Types.ObjectId(index.toString(16).padStart(24, '0')),
      senderId: 'peer',
      senderName: 'Peer',
      content: `Message ${index}`,
      createdAt: new Date('2026-10-21T10:00:00Z'),
    });
    const filters: Record<string, unknown>[] = [];
    const limits: number[] = [];
    const query = (rows: object[]) => ({
      sort: () => ({
        limit: (limit: number) => {
          limits.push(limit);
          return { lean: () => ({ exec: () => Promise.resolve(rows) }) };
        },
      }),
    });
    const model = {
      exists: () => Promise.resolve(true),
      findOne: (filter: Record<string, unknown>) => {
        filters.push(filter);
        return { lean: () => ({ exec: () => Promise.resolve(stored(3)) }) };
      },
      find: (filter: Record<string, unknown>) => {
        filters.push(filter);
        return query(
          filters.length === 2
            ? [stored(2), stored(1), stored(0)]
            : [stored(4), stored(5)],
        );
      },
    };
    const repository = new MongoChatRepository({
      model: () => model,
    } as unknown as Connection);
    const page = await repository.messagesAround(
      {
        id: 'actor',
        organizationId: String(scope.organizationId),
        name: 'Actor',
        avatarUrl: null,
      },
      String(scope.conversationId),
      String(stored(3)._id),
      5,
    );
    expect(page.data.map((message) => message.content)).toEqual([
      'Message 1',
      'Message 2',
      'Message 3',
      'Message 4',
      'Message 5',
    ]);
    expect(page.nextCursor?.id).toBe(String(stored(1)._id));
    expect(limits).toEqual([3, 2]);
    for (const filter of filters) expect(filter).toMatchObject(scope);
  });

  const actor: ChatActor = {
    id: '507f1f77bcf86cd799439001',
    organizationId: '507f1f77bcf86cd799439002',
    name: 'Member',
    avatarUrl: null,
  };

  it('filters permitted conversations before pagination, matches only the direct peer, and caps unread $lookup at 100 (BE-PERF-007)', async () => {
    const aggregate = jest
      .fn<unknown, [Record<string, unknown>[]]>()
      .mockReturnValue({ exec: jest.fn().mockResolvedValue([]) });
    const repository = new MongoChatRepository({
      model: () => ({ aggregate }),
    } as unknown as Connection);
    await repository.listConversations(actor, 1, undefined, 'kế hoạch');
    const pipeline = aggregate.mock.calls[0][0];
    expect(pipeline[0]).toHaveProperty('$search.index', 'chat_search_v1');
    expect(JSON.stringify(pipeline[0])).toContain(actor.id);
    expect(JSON.stringify(pipeline[0])).toContain(actor.organizationId);
    expect(JSON.stringify(pipeline[0])).toContain('searchLabel');
    expect(JSON.stringify(pipeline)).not.toContain('$regex');
    const membershipIndex = pipeline.findIndex((stage) => '$match' in stage);
    expect(pipeline[membershipIndex]).toEqual({
      $match: {
        organizationId: new Types.ObjectId(actor.organizationId),
        userId: actor.id,
        status: 'ACTIVE',
        isArchived: { $ne: true },
      },
    });
    expect(membershipIndex).toBeLessThan(
      pipeline.findIndex((stage) => '$limit' in stage),
    );

    const unreadLookup = pipeline.find(
      (stage) =>
        '$lookup' in stage &&
        (stage.$lookup as { as?: string }).as === 'unread',
    ) as { $lookup: { pipeline: Record<string, unknown>[] } };
    expect(unreadLookup).toBeDefined();
    const limitIdx = unreadLookup.$lookup.pipeline.findIndex(
      (stage) => '$limit' in stage && stage.$limit === 100,
    );
    const countIdx = unreadLookup.$lookup.pipeline.findIndex(
      (stage) => '$count' in stage,
    );
    expect(limitIdx).toBeGreaterThanOrEqual(0);
    expect(limitIdx).toBeLessThan(countIdx);
  });

  it('rejects a non-member message search before accessing message contents', async () => {
    const find = jest.fn();
    const repository = new MongoChatRepository({
      model: () => ({ exists: jest.fn().mockResolvedValue(null), find }),
    } as unknown as Connection);
    await expect(
      repository.searchMessages(actor, '507f1f77bcf86cd799439003', 'notes', 30),
    ).rejects.toMatchObject({ status: 404 });
    expect(find).not.toHaveBeenCalled();
  });

  it('returns replies in timeline order with a compact preview of their target message', async () => {
    const conversationId = '507f1f77bcf86cd799439003';
    const rootId = new Types.ObjectId('507f1f77bcf86cd799439004');
    const replyId = new Types.ObjectId('507f1f77bcf86cd799439005');
    const nestedReplyId = new Types.ObjectId('507f1f77bcf86cd799439006');
    const root = {
      _id: rootId,
      conversationId: new Types.ObjectId(conversationId),
      senderId: 'leader',
      senderName: 'Leader',
      senderAvatarUrl: null,
      clientMessageId: 'root-client-id',
      content: 'A message to quote',
      createdAt: new Date('2026-10-21T10:00:00.000Z'),
      replyToMessageId: null,
      attachments: [],
    };
    const reply = {
      _id: replyId,
      conversationId: new Types.ObjectId(conversationId),
      senderId: actor.id,
      senderName: actor.name,
      senderAvatarUrl: null,
      clientMessageId: 'reply-client-id',
      content: 'This is the inline reply',
      createdAt: new Date('2026-10-21T10:01:00.000Z'),
      replyToMessageId: rootId,
      attachments: [],
    };
    const nestedReply = {
      _id: nestedReplyId,
      conversationId: new Types.ObjectId(conversationId),
      senderId: 'leader',
      senderName: 'Leader',
      senderAvatarUrl: null,
      clientMessageId: 'nested-reply-client-id',
      content: 'A reply to the reply',
      createdAt: new Date('2026-10-21T10:02:00.000Z'),
      replyToMessageId: replyId,
      attachments: [],
    };
    const query = (rows: readonly object[]) => {
      const cursor: {
        sort: jest.Mock;
        limit: jest.Mock;
        lean: jest.Mock;
        exec: jest.Mock;
      } = {
        sort: jest.fn(),
        limit: jest.fn(),
        lean: jest.fn(),
        exec: jest.fn().mockResolvedValue(rows),
      };
      cursor.sort.mockReturnValue(cursor);
      cursor.limit.mockReturnValue(cursor);
      cursor.lean.mockReturnValue(cursor);
      return cursor;
    };
    const messageQueries: Record<string, unknown>[] = [];
    const messageModel = {
      find: jest.fn((filter: Record<string, unknown>) => {
        messageQueries.push(filter);
        if ('_id' in filter) return query([reply, root]);
        if (filter.replyToMessageId === null) return query([root]);
        return query([nestedReply, reply, root]);
      }),
    };
    const memberModel = {
      exists: jest.fn().mockResolvedValue(true),
    };
    const connection = {
      model: jest.fn((name: string) =>
        name.endsWith('chat_members') ? memberModel : messageModel,
      ),
    } as unknown as Connection;
    const repository = new MongoChatRepository(connection);

    const page = await repository.listMessages(actor, conversationId, 50);

    expect(page.data.map((message) => message.id)).toEqual([
      String(rootId),
      String(replyId),
      String(nestedReplyId),
    ]);
    expect(page.data[1]).toMatchObject({
      replyToMessageId: String(rootId),
      replyTo: {
        id: String(rootId),
        senderName: 'Leader',
        preview: 'A message to quote',
        deleted: false,
      },
    });
    expect(page.data[2]).toMatchObject({
      replyToMessageId: String(replyId),
      replyTo: {
        id: String(replyId),
        senderName: 'Member',
        preview: 'This is the inline reply',
        deleted: false,
      },
    });
    const replyTargetQuery = messageQueries.find((filter) => '_id' in filter);
    expect(replyTargetQuery?.organizationId).toBeInstanceOf(Types.ObjectId);
    expect(replyTargetQuery?.conversationId).toBeInstanceOf(Types.ObjectId);
    expect(messageQueries[0]).not.toHaveProperty('replyToMessageId', null);
  });

  it('wraps renameRoom and removeRoomMember in transactions, allows removing MANAGER, and includes organizationId predicates (BE-DATA-007 / BE-LOGIC-007 / SEC-BE-010)', async () => {
    const session = {
      withTransaction: jest.fn((action: () => Promise<void>) => action()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    const existsQuery = () => ({
      session: jest.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    });
    const convUpdateOne = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    });
    const memberUpdateMany = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({ matchedCount: 2, modifiedCount: 2 }),
    });
    const memberUpdateOne = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    });
    const memberFind = jest.fn().mockReturnValue({
      lean: () => ({
        exec: jest.fn().mockResolvedValue([{ userId: actor.id }]),
      }),
    });
    const connection = {
      startSession: jest.fn().mockResolvedValue(session),
      model: jest.fn((name: string) => {
        if (name.endsWith('chat_conversations')) {
          return { exists: existsQuery, updateOne: convUpdateOne };
        }
        return {
          exists: existsQuery,
          updateMany: memberUpdateMany,
          updateOne: memberUpdateOne,
          find: memberFind,
        };
      }),
    } as unknown as Connection;

    const repository = new MongoChatRepository(connection);
    const cid = '507f1f77bcf86cd799439003';
    const managerId = '507f1f77bcf86cd799439009';

    await repository.renameRoom(actor, cid, 'Renamed');
    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(convUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: new Types.ObjectId(actor.organizationId),
      }),
      { $set: { title: 'Renamed' } },
      { session },
    );
    expect(memberUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: new Types.ObjectId(actor.organizationId),
      }),
      { $set: { searchLabel: 'Renamed' } },
      { session },
    );

    convUpdateOne.mockClear();
    await repository.removeRoomMember(actor, cid, managerId);
    expect(session.withTransaction).toHaveBeenCalledTimes(2);
    expect(session.endSession).toHaveBeenCalledTimes(2);
    expect(memberUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: new Types.ObjectId(actor.organizationId),
        userId: managerId,
        role: { $in: ['MEMBER', 'MANAGER'] },
        status: 'ACTIVE',
      }),
      { $set: { status: 'LEFT' } },
      { session },
    );
    expect(convUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: new Types.ObjectId(cid),
        organizationId: new Types.ObjectId(actor.organizationId),
      }),
      { $inc: { membershipVersion: 1 } },
      { session },
    );
  });

  it('purges attachments, mentionUserIds, links, and isPinned on deleteMessage and redacts legacy deleted rows (SEC-BE-012)', async () => {
    const cid = new Types.ObjectId('507f1f77bcf86cd799439003');
    const mid = new Types.ObjectId('507f1f77bcf86cd799439004');
    const orgId = new Types.ObjectId(actor.organizationId);
    const storedMessage = {
      _id: mid,
      organizationId: orgId,
      conversationId: cid,
      senderId: actor.id,
      senderName: actor.name,
      senderAvatarUrl: null,
      clientMessageId: 'cid-1',
      content: 'secret message',
      createdAt: new Date('2026-10-21T10:00:00Z'),
      deletedAt: null,
      mentionUserIds: ['507f1f77bcf86cd799439099'],
      isPinned: true,
      attachments: [
        {
          id: 'att-1',
          name: 'secret-salary.pdf',
          contentType: 'application/pdf',
          size: 1234,
          kind: 'DOCUMENT',
          provider: 'R2',
          objectKey: 'chat/secret',
        },
      ],
    };
    const findOneAndUpdate = jest.fn().mockReturnValue({
      lean: () => ({
        exec: jest.fn().mockResolvedValue({
          ...storedMessage,
          deletedAt: new Date(),
        }),
      }),
    });
    const connection = {
      model: jest.fn((name: string) => {
        if (name.endsWith('chat_members')) {
          return {
            exists: jest.fn().mockResolvedValue(true),
            find: jest.fn().mockReturnValue({
              lean: () => ({
                exec: jest.fn().mockResolvedValue([{ userId: actor.id }]),
              }),
            }),
          };
        }
        if (name.endsWith('chat_conversations')) {
          return {
            updateOne: jest
              .fn()
              .mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
          };
        }
        return {
          findOne: jest.fn().mockReturnValue({
            lean: () => ({ exec: jest.fn().mockResolvedValue(storedMessage) }),
          }),
          findOneAndUpdate,
        };
      }),
    } as unknown as Connection;

    const repository = new MongoChatRepository(connection);
    const result = await repository.deleteMessage(
      actor,
      String(cid),
      String(mid),
    );
    const [deleteFilter, deleteUpdate, deleteOpts] = findOneAndUpdate.mock
      .calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
      Record<string, unknown>,
    ];
    expect(deleteFilter).toMatchObject({ _id: mid, organizationId: orgId });
    expect(deleteUpdate.$set).toMatchObject({
      content: '',
      reactions: [],
      attachments: [],
      mentionUserIds: [],
      links: [],
      isPinned: false,
    });
    expect(deleteOpts).toEqual({ new: true });
    // Even if a legacy deleted doc still had fields, toMessage redacts them completely
    expect(result.message.content).toBe('');
    expect(result.message.attachments).toEqual([]);
    expect(result.message.mentionUserIds).toEqual([]);
    expect(result.message.isPinned).toBe(false);
    expect(result.message.reactions).toEqual([]);
  });

  it('computes newlyMentionedUserIds atomically in editMessage (SEC-BE-017)', async () => {
    const cid = new Types.ObjectId('507f1f77bcf86cd799439003');
    const mid = new Types.ObjectId('507f1f77bcf86cd799439004');
    const existingMention = '507f1f77bcf86cd799439088';
    const newMention = '507f1f77bcf86cd799439099';
    const previousDoc = {
      _id: mid,
      organizationId: new Types.ObjectId(actor.organizationId),
      conversationId: cid,
      senderId: actor.id,
      senderName: actor.name,
      senderAvatarUrl: null,
      clientMessageId: 'c1',
      content: 'old',
      createdAt: new Date('2026-10-21T10:00:00Z'),
      mentionUserIds: [existingMention],
      attachments: [],
    };
    const connection = {
      model: jest.fn((name: string) => {
        if (name.endsWith('chat_members')) {
          return {
            exists: jest.fn().mockResolvedValue(true),
            find: jest.fn().mockReturnValue({
              lean: () => ({
                exec: jest.fn().mockResolvedValue([{ userId: actor.id }]),
              }),
            }),
          };
        }
        if (name.endsWith('chat_conversations')) {
          return {
            updateOne: jest
              .fn()
              .mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
          };
        }
        return {
          findOneAndUpdate: jest.fn().mockReturnValue({
            lean: () => ({ exec: jest.fn().mockResolvedValue(previousDoc) }),
          }),
        };
      }),
    } as unknown as Connection;

    const repository = new MongoChatRepository(connection);
    const result = await repository.editMessage(
      actor,
      String(cid),
      String(mid),
      'new content',
      [existingMention, newMention],
    );
    expect(result.newlyMentionedUserIds).toEqual([newMention]);
    expect(result.message.content).toBe('new content');
  });

  it('declares chat_blocks reverse index & partial message indexes and clones schemas without duplicates (BE-PERF-002 / TEST-004)', () => {
    const blocks = CHAT_PERSISTENCE.collections.find(
      (c) => c.name === 'chat_blocks',
    );
    expect(blocks?.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fields: { organizationId: 1, targetId: 1, userId: 1 },
        }),
      ]),
    );
    const messages = CHAT_PERSISTENCE.collections.find(
      (c) => c.name === 'chat_conversation_messages',
    );
    const pinnedIdx = messages?.indexes?.find(
      (idx) => idx.options?.name === 'chat_messages_pinned_partial',
    );
    expect(pinnedIdx?.fields).toEqual({
      conversationId: 1,
      isPinned: 1,
      createdAt: -1,
    });
    expect(pinnedIdx?.options?.partialFilterExpression).toEqual({
      isPinned: true,
    });
    const attachIdx = messages?.indexes?.find(
      (idx) => idx.options?.name === 'chat_messages_attachments_kind_partial',
    );
    expect(attachIdx?.fields).toEqual({
      conversationId: 1,
      'attachments.kind': 1,
      createdAt: -1,
    });
    expect(attachIdx?.options?.partialFilterExpression).toEqual({
      'attachments.kind': { $exists: true },
    });

    const first = createCollectionSchema(messages!);
    const second = createCollectionSchema(messages!);
    expect(first).not.toBe(second);
    expect(first.indexes().length).toBe(messages!.indexes!.length);
    expect(second.indexes().length).toBe(messages!.indexes!.length);
  });
});
