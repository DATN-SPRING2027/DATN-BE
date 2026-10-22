import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Connection, ClientSession } from 'mongoose';
import { Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { textSearchStage } from '../../../../common/search/indexed-search';
import type {
  ChatActor,
  ChatCursor,
  ChatMessage,
  ChatMessagePage,
} from '../../application/chat.repository';
import type {
  ChatFeatureRepository,
  ChatNotification,
  ChatPreferences,
  ChatSearchFilters,
} from '../../application/chat-features';
import type { MessageDocument } from './mongo-chat.repository';

const id = (value: string) => new Types.ObjectId(value);
const older = (before?: ChatCursor) =>
  before
    ? {
        $or: [
          { createdAt: { $lt: before.createdAt } },
          { createdAt: before.createdAt, _id: { $lt: id(before.id) } },
        ],
      }
    : {};
const preferences = (row: Record<string, unknown>): ChatPreferences => ({
  isPinned: row.isPinned === true,
  isArchived: row.isArchived === true,
  markedUnread: row.markedUnread === true,
  notificationMode:
    row.notificationMode === 'MENTIONS' || row.notificationMode === 'NONE'
      ? row.notificationMode
      : 'ALL',
});

export abstract class MongoChatFeatures implements ChatFeatureRepository {
  constructor(private readonly featureConnection: Connection) {}
  protected abstract requireMember(
    actor: ChatActor,
    conversationId: Types.ObjectId,
  ): Promise<void>;
  protected abstract mapMessages(
    actor: ChatActor,
    messages: MessageDocument[],
  ): Promise<ChatMessage[]>;
  private collection(name: string) {
    if (!this.featureConnection.db)
      throw new Error('Chat database is unavailable');
    return this.featureConnection.db.collection(name);
  }
  private scope(actor: ChatActor, conversationId: string) {
    return {
      organizationId: id(actor.organizationId),
      conversationId: id(conversationId),
    };
  }
  private async member(actor: ChatActor, conversationId: string) {
    const row = await this.collection('chat_members').findOne({
      ...this.scope(actor, conversationId),
      userId: actor.id,
      status: 'ACTIVE',
    });
    if (!row)
      throw new NotFoundException({
        code: 'CHAT_CONVERSATION_NOT_FOUND',
        message: 'Conversation not found.',
      });
    return row;
  }
  async getPreferences(actor: ChatActor, conversationId: string) {
    return preferences(await this.member(actor, conversationId));
  }
  async setPreferences(
    actor: ChatActor,
    conversationId: string,
    changes: Partial<ChatPreferences>,
  ) {
    await this.member(actor, conversationId);
    await this.collection('chat_members').updateOne(
      {
        ...this.scope(actor, conversationId),
        userId: actor.id,
        status: 'ACTIVE',
      },
      { $set: changes },
    );
    return this.getPreferences(actor, conversationId);
  }
  async getDraft(actor: ChatActor, conversationId: string) {
    const row = await this.member(actor, conversationId);
    return {
      content: typeof row.draft === 'string' ? row.draft : '',
      mentionUserIds: Array.isArray(row.draftMentionUserIds)
        ? row.draftMentionUserIds.filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : [],
      updatedAt:
        row.draftUpdatedAt instanceof Date
          ? row.draftUpdatedAt.toISOString()
          : null,
    };
  }
  async saveDraft(
    actor: ChatActor,
    conversationId: string,
    content: string,
    mentionUserIds: string[] = [],
  ) {
    await this.member(actor, conversationId);
    const updatedAt = new Date();
    await this.collection('chat_members').updateOne(
      {
        ...this.scope(actor, conversationId),
        userId: actor.id,
        status: 'ACTIVE',
      },
      {
        $set: {
          draft: content,
          draftMentionUserIds: mentionUserIds,
          draftUpdatedAt: updatedAt,
        },
      },
    );
    return { content, mentionUserIds, updatedAt: updatedAt.toISOString() };
  }
  async transferOwnership(
    actor: ChatActor,
    conversationId: string,
    userId: string,
  ) {
    const scope = this.scope(actor, conversationId);
    await this.member(actor, conversationId);
    const session = await this.featureConnection.startSession();
    try {
      await session.withTransaction(async () => {
        const current = await this.collection('chat_members').findOne(
          { ...scope, userId: actor.id, role: 'OWNER', status: 'ACTIVE' },
          { session },
        );
        if (!current) throw new NotFoundException('Room owner access required');
        const next = await this.collection('chat_members').findOne(
          { ...scope, userId, status: 'ACTIVE' },
          { session },
        );
        if (!next || userId === actor.id)
          throw new NotFoundException('New owner is unavailable');
        const changed = await this.collection('chat_conversations').updateOne(
          {
            _id: scope.conversationId,
            organizationId: scope.organizationId,
            type: 'ROOM',
            status: 'ACTIVE',
          },
          { $inc: { membershipVersion: 1 } },
          { session },
        );
        if (!changed.modifiedCount)
          throw new NotFoundException('Room owner access required');
        await this.collection('chat_members').updateOne(
          { ...scope, userId: actor.id, role: 'OWNER', status: 'ACTIVE' },
          { $set: { role: 'MEMBER' } },
          { session },
        );
        await this.collection('chat_members').updateOne(
          { ...scope, userId, status: 'ACTIVE' },
          { $set: { role: 'OWNER' } },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
  }
  async setManager(
    actor: ChatActor,
    conversationId: string,
    userId: string,
    active: boolean,
  ) {
    await this.member(actor, conversationId);
    const scope = this.scope(actor, conversationId);
    const session = await this.featureConnection.startSession();
    try {
      await session.withTransaction(async () => {
        const current = await this.collection('chat_members').findOne(
          { ...scope, userId: actor.id, role: 'OWNER', status: 'ACTIVE' },
          { session },
        );
        if (!current) throw new NotFoundException('Room owner access required');
        const owner = await this.collection('chat_conversations').updateOne(
          {
            _id: scope.conversationId,
            organizationId: scope.organizationId,
            type: 'ROOM',
            status: 'ACTIVE',
          },
          { $inc: { membershipVersion: 1 } },
          { session },
        );
        if (!owner.matchedCount || userId === actor.id)
          throw new NotFoundException('Room owner access required');
        const result = await this.collection('chat_members').updateOne(
          {
            ...scope,
            userId,
            status: 'ACTIVE',
            role: { $in: ['MEMBER', 'MANAGER'] },
          },
          { $set: { role: active ? 'MANAGER' : 'MEMBER' } },
          { session },
        );
        if (!result.matchedCount)
          throw new NotFoundException('Member is unavailable');
      });
    } finally {
      await session.endSession();
    }
  }
  private accessLookup(actor: ChatActor) {
    return {
      $lookup: {
        from: 'chat_members',
        localField: 'conversationId',
        foreignField: 'conversationId',
        pipeline: [
          {
            $match: {
              organizationId: id(actor.organizationId),
              userId: actor.id,
              status: 'ACTIVE',
            },
          },
        ],
        as: 'access',
      },
    };
  }
  private async page(
    actor: ChatActor,
    rows: Record<string, unknown>[],
    limit: number,
  ): Promise<ChatMessagePage> {
    const selected = rows.slice(0, limit) as unknown as MessageDocument[];
    const mapped: ChatMessage[] = [];
    // A global result page may contain quoted messages from several conversations.
    for (const conversationId of new Set(
      selected.map((row) => String(row.conversationId)),
    )) {
      mapped.push(
        ...(await this.mapMessages(
          actor,
          selected.filter(
            (row) => String(row.conversationId) === conversationId,
          ),
        )),
      );
    }
    const byId = new Map(mapped.map((message) => [message.id, message]));
    const last = selected.at(-1);
    return {
      data: selected.map((row) => byId.get(String(row._id))!),
      hasMore: rows.length > limit,
      nextCursor:
        rows.length > limit && last
          ? { createdAt: last.createdAt, id: String(last._id) }
          : null,
    };
  }
  async searchAcross(
    actor: ChatActor,
    filters: ChatSearchFilters,
    limit: number,
    before?: ChatCursor,
  ) {
    if (filters.conversationId)
      await this.requireMember(actor, id(filters.conversationId));
    const indexed: object[] = [
      { equals: { path: 'organizationId', value: id(actor.organizationId) } },
    ];
    if (filters.conversationId)
      indexed.push({
        equals: { path: 'conversationId', value: id(filters.conversationId) },
      });
    if (filters.senderId)
      indexed.push({ equals: { path: 'senderId', value: filters.senderId } });
    if (filters.from || filters.to)
      indexed.push({
        range: {
          path: 'createdAt',
          ...(filters.from ? { gte: filters.from } : {}),
          ...(filters.to ? { lte: filters.to } : {}),
        },
      });
    const rows = await this.collection('chat_conversation_messages')
      .aggregate([
        textSearchStage(filters.q, indexed),
        {
          $match: {
            organizationId: id(actor.organizationId),
            deletedAt: null,
            ...older(before),
            ...(filters.kind === 'LINK'
              ? { 'links.0': { $exists: true } }
              : filters.kind
                ? { 'attachments.kind': filters.kind }
                : {}),
          },
        },
        this.accessLookup(actor),
        { $match: { 'access.0': { $exists: true } } },
        { $sort: { createdAt: -1, _id: -1 } },
        { $limit: limit + 1 },
        { $unset: 'access' },
      ])
      .toArray();
    return this.page(actor, rows, limit);
  }
  async library(
    actor: ChatActor,
    conversationId: string,
    kind: 'IMAGE' | 'DOCUMENT' | 'LINK' | 'PIN',
    limit: number,
    before?: ChatCursor,
  ) {
    await this.member(actor, conversationId);
    const rows = await this.collection('chat_conversation_messages')
      .find({
        ...this.scope(actor, conversationId),
        deletedAt: null,
        ...older(before),
        ...(kind === 'PIN'
          ? { isPinned: true }
          : kind === 'LINK'
            ? { 'links.0': { $exists: true } }
            : { 'attachments.kind': kind }),
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    return this.page(actor, rows, limit);
  }
  async pinMessage(
    actor: ChatActor,
    conversationId: string,
    messageId: string,
    active: boolean,
  ) {
    await this.member(actor, conversationId);
    const result = await this.collection(
      'chat_conversation_messages',
    ).updateOne(
      {
        ...this.scope(actor, conversationId),
        _id: id(messageId),
        deletedAt: null,
      },
      { $set: { isPinned: active } },
    );
    if (!result.matchedCount) throw new NotFoundException('Message not found');
  }
  protected async assertCanSend(
    actor: ChatActor,
    conversationId: string,
    session?: ClientSession,
  ) {
    const scope = this.scope(actor, conversationId);
    const conversation = await this.collection('chat_conversations').findOne(
      {
        _id: scope.conversationId,
        organizationId: scope.organizationId,
        status: 'ACTIVE',
      },
      { session },
    );
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.type !== 'DIRECT') return;
    const peers = await this.collection('chat_members')
      .find(
        { ...scope, userId: { $ne: actor.id }, status: 'ACTIVE' },
        { session },
      )
      .toArray();
    const peerIds = peers.map((peer) => String(peer.userId));
    const blocked = await this.collection('chat_blocks').findOne(
      {
        organizationId: scope.organizationId,
        $or: [
          { userId: actor.id, targetId: { $in: peerIds } },
          { targetId: actor.id, userId: { $in: peerIds } },
        ],
      },
      { session },
    );
    if (blocked)
      throw new ConflictException({
        code: 'CHAT_DIRECT_UNAVAILABLE',
        message: 'Direct messaging is unavailable for this contact.',
      });
  }
  async forwardMessage(
    actor: ChatActor,
    conversationId: string,
    sourceConversationId: string,
    messageId: string,
    clientMessageId: string,
  ) {
    const session = await this.featureConnection.startSession();
    let message: MessageDocument | undefined;
    try {
      await session.withTransaction(async () => {
        for (const target of new Set([conversationId, sourceConversationId])) {
          const member = await this.collection('chat_members').findOne(
            {
              ...this.scope(actor, target),
              userId: actor.id,
              status: 'ACTIVE',
            },
            { session },
          );
          if (!member) throw new NotFoundException('Conversation not found');
          await this.collection('chat_conversations').updateOne(
            { _id: id(target), organizationId: id(actor.organizationId) },
            { $inc: { membershipVersion: 1 } },
            { session },
          );
        }
        await this.assertCanSend(actor, conversationId, session);
        const targetScope = this.scope(actor, conversationId);
        const existing = await this.collection(
          'chat_conversation_messages',
        ).findOne(
          { ...targetScope, senderId: actor.id, clientMessageId },
          { session },
        );
        if (existing) {
          if (
            String(existing.forwardSourceId) !== messageId ||
            String(existing.forwardSourceConversationId) !==
              sourceConversationId
          )
            throw new ConflictException({
              code: 'CHAT_IDEMPOTENCY_CONFLICT',
              message: 'clientMessageId was already used for another message.',
            });
          message = existing as unknown as MessageDocument;
          return;
        }
        const source = await this.collection(
          'chat_conversation_messages',
        ).findOne(
          {
            ...this.scope(actor, sourceConversationId),
            _id: id(messageId),
            deletedAt: null,
          },
          { session },
        );
        if (!source) throw new NotFoundException('Message not found');
        // The target receives its own attachment IDs and permission scope, never a source download URL.
        const forwarded = {
          _id: new Types.ObjectId(),
          ...targetScope,
          senderId: actor.id,
          senderName: actor.name,
          senderAvatarUrl: actor.avatarUrl,
          clientMessageId,
          content: String(source.content),
          createdAt: new Date(),
          editedAt: null,
          deletedAt: null,
          attachments: Array.isArray(source.attachments)
            ? source.attachments.map((attachment: Record<string, unknown>) => ({
                ...attachment,
                id: randomUUID(),
              }))
            : [],
          replyToMessageId: null,
          reactions: [],
          mentionUserIds: [],
          links: Array.isArray(source.links)
            ? source.links.filter(
                (link): link is string => typeof link === 'string',
              )
            : [],
          forwardSourceId: id(messageId),
          forwardSourceConversationId: id(sourceConversationId),
          forwardedFrom: { senderName: String(source.senderName) },
        };
        await this.collection('chat_conversation_messages').insertOne(
          forwarded,
          { session },
        );
        await this.collection('chat_conversations').updateOne(
          {
            _id: targetScope.conversationId,
            organizationId: targetScope.organizationId,
          },
          {
            $set: {
              lastMessageId: forwarded._id,
              lastMessageAt: forwarded.createdAt,
              lastMessagePreview: forwarded.content.slice(0, 160),
              lastMessageSenderId: actor.id,
            },
          },
          { session },
        );
        message = forwarded as unknown as MessageDocument;
      });
    } catch (error: unknown) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 11000
      )
        throw error;
      await this.member(actor, conversationId);
      await this.member(actor, sourceConversationId);
      const existing = await this.collection(
        'chat_conversation_messages',
      ).findOne({
        ...this.scope(actor, conversationId),
        senderId: actor.id,
        clientMessageId,
      });
      if (!existing) throw error;
      if (
        String(existing.forwardSourceId) !== messageId ||
        String(existing.forwardSourceConversationId) !== sourceConversationId
      )
        throw new ConflictException({
          code: 'CHAT_IDEMPOTENCY_CONFLICT',
          message: 'clientMessageId was already used for another message.',
        });
      message = existing as unknown as MessageDocument;
    } finally {
      await session.endSession();
    }
    if (!message) throw new Error('Forwarding did not produce a message');
    await this.createNotifications(actor, message);
    return (await this.mapMessages(actor, [message]))[0];
  }
  async receipts(actor: ChatActor, conversationId: string, messageId: string) {
    await this.member(actor, conversationId);
    const scope = this.scope(actor, conversationId);
    const message = await this.collection('chat_conversation_messages').findOne(
      { ...scope, _id: id(messageId) },
    );
    if (!message) throw new NotFoundException('Message not found');
    const members = await this.collection('chat_members')
      .find({ ...scope, status: 'ACTIVE' })
      .toArray();
    const reached = (at: unknown, cursor: unknown) =>
      at instanceof Date &&
      (at > message.createdAt ||
        (at.getTime() === (message.createdAt as Date).getTime() &&
          String(cursor) >= messageId));
    return {
      data: members
        .filter((member) => member.userId !== message.senderId)
        .map((member) => {
          const read = reached(member.lastReadAt, member.lastReadMessageId);
          const delivered = reached(
            member.lastDeliveredAt,
            member.lastDeliveredMessageId,
          );
          return {
            userId: String(member.userId),
            displayName: String(member.displayName),
            read,
            delivered,
            readAt:
              read && member.readRecordedAt instanceof Date
                ? member.readRecordedAt.toISOString()
                : null,
            deliveredAt:
              delivered && member.deliveredRecordedAt instanceof Date
                ? member.deliveredRecordedAt.toISOString()
                : null,
          };
        }),
    };
  }
  protected async createNotifications(
    actor: ChatActor,
    message: MessageDocument,
  ) {
    const members = await this.collection('chat_members')
      .find({
        ...this.scope(actor, String(message.conversationId)),
        status: 'ACTIVE',
        userId: { $ne: actor.id },
        notificationMode: { $ne: 'NONE' },
      })
      .toArray();
    const recipients = members.filter(
      (member) =>
        member.notificationMode !== 'MENTIONS' ||
        message.mentionUserIds?.includes(String(member.userId)),
    );
    if (!recipients.length) return;
    await this.collection('chat_notifications').bulkWrite(
      recipients.map((member) => ({
        updateOne: {
          filter: {
            organizationId: id(actor.organizationId),
            userId: String(member.userId),
            messageId: message._id,
          },
          update: {
            $setOnInsert: {
              conversationId: message.conversationId,
              senderName: actor.name,
              preview: message.content.slice(0, 160),
              createdAt: message.createdAt,
              readAt: null,
            },
          },
          upsert: true,
        },
      })),
    );
  }
  protected async readNotificationsThrough(
    actor: ChatActor,
    conversationId: string,
    message: MessageDocument,
  ) {
    await this.collection('chat_notifications').updateMany(
      {
        ...this.scope(actor, conversationId),
        userId: actor.id,
        readAt: null,
        $or: [
          { createdAt: { $lt: message.createdAt } },
          { createdAt: message.createdAt, messageId: { $lte: message._id } },
        ],
      },
      { $set: { readAt: new Date() } },
    );
  }
  async notifications(actor: ChatActor, limit: number, before?: ChatCursor) {
    const rows = await this.collection('chat_notifications')
      .aggregate([
        {
          $match: {
            organizationId: id(actor.organizationId),
            userId: actor.id,
            ...older(before),
          },
        },
        this.accessLookup(actor),
        { $match: { 'access.0': { $exists: true } } },
        {
          $lookup: {
            from: 'chat_conversation_messages',
            localField: 'messageId',
            foreignField: '_id',
            pipeline: [
              {
                $match: {
                  organizationId: id(actor.organizationId),
                  deletedAt: null,
                },
              },
            ],
            as: 'message',
          },
        },
        { $match: { 'message.0': { $exists: true } } },
        { $sort: { createdAt: -1, _id: -1 } },
        { $limit: limit + 1 },
      ])
      .toArray();
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return {
      data: selected.map((row): ChatNotification => ({
        id: String(row._id),
        conversationId: String(row.conversationId),
        messageId: String(row.messageId),
        senderName: String(row.senderName),
        preview: String(
          (row.message as { content: string }[])[0].content,
        ).slice(0, 160),
        createdAt: (row.createdAt as Date).toISOString(),
        readAt: row.readAt instanceof Date ? row.readAt.toISOString() : null,
      })),
      nextCursor:
        rows.length > limit && last
          ? { createdAt: last.createdAt as Date, id: String(last._id) }
          : null,
    };
  }
  async readNotification(actor: ChatActor, notificationId: string) {
    const result = await this.collection('chat_notifications').updateOne(
      {
        _id: id(notificationId),
        organizationId: id(actor.organizationId),
        userId: actor.id,
      },
      { $set: { readAt: new Date() } },
    );
    if (!result.matchedCount)
      throw new NotFoundException('Notification not found');
  }
  async setBlock(actor: ChatActor, userId: string, active: boolean) {
    const filter = {
      organizationId: id(actor.organizationId),
      userId: actor.id,
      targetId: userId,
    };
    if (active)
      await this.collection('chat_blocks').updateOne(
        filter,
        { $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      );
    else await this.collection('chat_blocks').deleteOne(filter);
  }
  async report(
    actor: ChatActor,
    conversationId: string,
    messageId: string | undefined,
    reason: string,
  ) {
    await this.member(actor, conversationId);
    const scope = this.scope(actor, conversationId);
    const evidence = messageId
      ? await this.collection('chat_conversation_messages').findOne(
          { ...scope, _id: id(messageId) },
          { projection: { content: 1, senderId: 1 } },
        )
      : null;
    if (messageId && !evidence)
      throw new NotFoundException('Message not found');
    const result = await this.collection('chat_reports').insertOne({
      ...scope,
      reporterId: actor.id,
      messageId: messageId ? id(messageId) : null,
      reason,
      evidence,
      status: 'OPEN',
      createdAt: new Date(),
    });
    return String(result.insertedId);
  }
}
