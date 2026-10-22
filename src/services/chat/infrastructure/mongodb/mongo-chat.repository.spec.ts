import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import type { ChatActor } from '../../application/chat.repository';
import { MongoChatRepository } from './mongo-chat.repository';

describe('MongoChatRepository message history', () => {
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

  it('filters permitted conversations before pagination and matches only the direct peer', async () => {
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
    const actor: ChatActor = {
      id: '507f1f77bcf86cd799439001',
      organizationId: '507f1f77bcf86cd799439002',
      name: 'Member',
      avatarUrl: null,
    };
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
});
