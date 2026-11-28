import { MongoChatFeatures } from './mongo-chat-features';
import { chatLinks } from '../../../../common/search/chat-links';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ClientSession, Connection, Model, PipelineStage } from 'mongoose';
import { Types } from 'mongoose';
import {
  autocompleteClause,
  CHAT_SEARCH_INDEX,
  textSearchStage,
} from '../../../../common/search/indexed-search';
import { normalizeSearchText } from '../../../../common/search/literal-search';
import {
  CHAT_ASSISTANT_JOBS_COLLECTION,
  CONTINUUM_AI_HANDLE,
  CONTINUUM_AI_SENDER_ID,
} from './mongodb.schemas';
import {
  computeSourceAggregateState,
  pageNeedsAssistantReEnrichment,
  type AssistantStatusEvent,
  type ChatAssistantFailureCode,
  type ChatAssistantJobState,
  type ChatAssistantMentionNormalized,
  type ChatAssistantMeta,
  type ChatAssistantPostedStatus,
  type ChatAssistantQueryMode,
  type ChatAssistantSourceReference,
  type ChatAssistantSourceStatus,
  type ChatAssistantStatus,
  type ChatMessageAuthorType,
} from '../../application/chat-dm-assistant.types';
import type {
  ChatActor,
  ChatCandidate,
  ChatConversation,
  ChatConversationPage,
  ChatCursor,
  ChatDeliveryState,
  ChatMessage,
  ChatMessagePage,
  ChatMessageWrite,
  ChatReplyPreview,
  ChatParticipant,
  ChatReadState,
  ChatUpload,
  ChatAttachment,
  ChatRepository,
} from '../../application/chat.repository';

interface ConversationDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  type: 'DIRECT' | 'ROOM';
  directKey?: string;
  creationKey?: string;
  title: string | null;
  createdBy: string;
  lastMessageAt: Date | null;
  lastMessageId: Types.ObjectId | null;
  lastMessagePreview: string;
  lastMessageSenderId: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: Date;
}

interface MemberDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  conversationId: Types.ObjectId;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'OWNER' | 'MANAGER' | 'MEMBER';
  status: 'ACTIVE' | 'LEFT';
  lastReadMessageId: Types.ObjectId | null;
  lastReadAt: Date | null;
  lastDeliveredMessageId: Types.ObjectId | null;
  lastDeliveredAt: Date | null;
  notificationMode?: 'ALL' | 'MENTIONS' | 'NONE';
  isPinned?: boolean;
  isArchived?: boolean;
  markedUnread?: boolean;
  joinedAt: Date;
}

interface StoredAttachmentDocument extends ChatAttachment {
  provider: 'S3' | 'R2';
  objectKey: string;
}

export interface StoredAssistantSourceReferenceDocument {
  refId: string;
  messageId: Types.ObjectId;
  senderName: string;
  createdAt: Date;
  sourceEditedAt?: Date | null;
  sourceVersion: number;
  quoteSnippet: string;
}

export interface StoredAssistantMetaDocument {
  handle: typeof CONTINUUM_AI_HANDLE;
  queryMode: ChatAssistantQueryMode;
  partialCoverage: boolean;
  coverageNote?: string | null;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
}

export interface MessageDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  conversationId: Types.ObjectId;
  senderId: string;
  senderName: string;
  senderAvatarUrl: string | null;
  clientMessageId: string;
  content: string;
  createdAt: Date;
  editedAt?: Date | null;
  deletedAt?: Date | null;
  mentionUserIds?: string[];
  isPinned?: boolean;
  forwardedFrom?: { senderName: string } | null;
  reactions?: { emoji: string; userIds: string[] }[];
  replyToMessageId?: Types.ObjectId | null;
  attachments?: StoredAttachmentDocument[];
  contentVersion?: number;
  authorType?: ChatMessageAuthorType;
  assistantMention?: {
    handle: typeof CONTINUUM_AI_HANDLE;
    query: string;
    timezone: string;
  } | null;
  triggerMessageId?: Types.ObjectId | null;
  assistantStatus?: ChatAssistantStatus;
  assistantFailureCode?: ChatAssistantFailureCode | null;
  assistantMeta?: StoredAssistantMetaDocument | null;
  sourceReferences?: StoredAssistantSourceReferenceDocument[];
}

export interface AssistantJobDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  conversationId: Types.ObjectId;
  triggerMessageId: Types.ObjectId;
  requesterUserId: string;
  requesterDisplayName: string;
  handle: typeof CONTINUUM_AI_HANDLE;
  query: string;
  timezone: string;
  status: ChatAssistantStatus;
  failureCode: ChatAssistantFailureCode | null;
  failureReason?: string | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lockedBy: string | null;
  lockedUntil: Date | null;
  responseMessageId: Types.ObjectId | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface LiveSourceProjection {
  _id: Types.ObjectId;
  deletedAt?: Date | null;
  editedAt?: Date | null;
  contentVersion?: number;
}

interface UploadDocument extends Omit<ChatUpload, 'id'> {
  _id: Types.ObjectId;
  uploadId: string;
  organizationId: Types.ObjectId;
  uploaderId: string;
}

interface ConversationAggregate {
  conversation: ConversationDocument;
  lastReadMessageId: Types.ObjectId | null;
  lastReadAt: Date | null;
  activityAt: Date;
  isPinned?: boolean;
  isArchived?: boolean;
  markedUnread?: boolean;
  notificationMode?: 'ALL' | 'MENTIONS' | 'NONE';
  participants: MemberDocument[];
  unread: { count: number }[];
}

const modelPrefix = 'continuum_chat_';
const ACTIVE = 'ACTIVE';

function duplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 11000
  );
}

function toReplyPreview(message: MessageDocument): ChatReplyPreview {
  return {
    id: String(message._id),
    senderName: message.senderName,
    preview: message.deletedAt
      ? ''
      : (message.content || message.attachments?.[0]?.name || '').slice(0, 160),
    deleted: Boolean(message.deletedAt),
  };
}

function assistantMentionsEqual(
  stored: MessageDocument['assistantMention'],
  incoming: ChatAssistantMentionNormalized | undefined,
): boolean {
  if (!stored && !incoming) return true;
  if (!stored || !incoming) return false;
  return (
    stored.handle === incoming.handle &&
    stored.query === incoming.query &&
    stored.timezone === incoming.timezone
  );
}

function toAssistantJobState(job: AssistantJobDocument): ChatAssistantJobState {
  return {
    jobId: String(job._id),
    status: job.status,
    failureCode: job.failureCode ?? null,
    responseMessageId: job.responseMessageId
      ? String(job.responseMessageId)
      : null,
    updatedAt: (job.updatedAt ?? job.createdAt).toISOString(),
  };
}

export function enrichSourceReferences(
  storedRefs: readonly StoredAssistantSourceReferenceDocument[],
  liveSourceById: ReadonlyMap<string, LiveSourceProjection>,
): ChatAssistantSourceReference[] {
  return storedRefs.map((ref) => {
    const live = liveSourceById.get(String(ref.messageId));
    let status: ChatAssistantSourceStatus;
    let quoteSnippet: string;
    if (!live || live.deletedAt != null) {
      status = 'DELETED';
      quoteSnippet = '';
    } else if (
      (live.contentVersion ?? 0) !== ref.sourceVersion ||
      (live.editedAt ? live.editedAt.getTime() : null) !==
        (ref.sourceEditedAt ? ref.sourceEditedAt.getTime() : null)
    ) {
      status = 'EDITED';
      quoteSnippet = ref.quoteSnippet ?? '';
    } else {
      status = 'ACTIVE';
      quoteSnippet = ref.quoteSnippet ?? '';
    }
    return {
      refId: ref.refId,
      messageId: String(ref.messageId),
      senderName: ref.senderName,
      createdAt: ref.createdAt.toISOString(),
      quoteSnippet,
      status,
    };
  });
}

function toMessage(
  message: MessageDocument,
  actorId: string,
  replyTarget?: MessageDocument,
  liveSourceById?: ReadonlyMap<string, LiveSourceProjection>,
  jobByTriggerId?: ReadonlyMap<string, AssistantJobDocument>,
): ChatMessage {
  const isDeleted = Boolean(message.deletedAt);
  const isAssistant =
    message.authorType === 'ASSISTANT' ||
    message.senderId === CONTINUUM_AI_SENDER_ID;
  const base: ChatMessage = {
    id: String(message._id),
    conversationId: String(message.conversationId),
    senderId: message.senderId,
    senderName: message.senderName,
    senderAvatarUrl: message.senderAvatarUrl ?? null,
    content: isDeleted ? '' : message.content,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
    reactions: isDeleted
      ? []
      : (message.reactions ?? []).map((reaction) => ({
          emoji: reaction.emoji,
          count: reaction.userIds.length,
          reactedByMe: reaction.userIds.includes(actorId),
        })),
    replyToMessageId: message.replyToMessageId
      ? String(message.replyToMessageId)
      : null,
    replyTo: replyTarget ? toReplyPreview(replyTarget) : null,
    mentionUserIds: isDeleted ? [] : (message.mentionUserIds ?? []),
    isPinned: isDeleted ? false : (message.isPinned ?? false),
    forwardedFrom: isDeleted ? null : (message.forwardedFrom ?? null),
    attachments: isDeleted
      ? []
      : (message.attachments ?? []).map(
          ({ id, name, contentType, size, kind }) => ({
            id,
            name,
            contentType,
            size,
            kind,
          }),
        ),
    authorType: isAssistant ? 'ASSISTANT' : 'USER',
  };

  if (isAssistant) {
    const sourceReferences = enrichSourceReferences(
      message.sourceReferences ?? [],
      liveSourceById ?? new Map<string, LiveSourceProjection>(),
    );
    const postedStatus: ChatAssistantPostedStatus | null =
      message.assistantStatus === 'COMPLETED' ||
      message.assistantStatus === 'INSUFFICIENT_EVIDENCE'
        ? message.assistantStatus
        : null;
    const assistantMeta: ChatAssistantMeta = {
      handle: message.assistantMeta?.handle ?? CONTINUUM_AI_HANDLE,
      queryMode: message.assistantMeta?.queryMode ?? 'KEYWORD',
      partialCoverage: Boolean(message.assistantMeta?.partialCoverage),
      coverageNote: message.assistantMeta?.coverageNote ?? null,
      sourceState: computeSourceAggregateState(sourceReferences),
    };
    return {
      ...base,
      triggerMessageId: message.triggerMessageId
        ? String(message.triggerMessageId)
        : null,
      assistantStatus: postedStatus,
      assistantFailureCode: message.assistantFailureCode ?? null,
      assistantMeta,
      sourceReferences,
    };
  }

  if (message.assistantMention != null) {
    if (isDeleted) {
      return { ...base, assistantState: null };
    }
    const job = jobByTriggerId?.get(String(message._id));
    return {
      ...base,
      assistantState: job ? toAssistantJobState(job) : null,
    };
  }

  return base;
}

function toParticipant(member: MemberDocument): ChatParticipant {
  return {
    userId: member.userId,
    displayName: member.displayName,
    avatarUrl: member.avatarUrl ?? null,
    role: member.role,
    lastReadMessageId: member.lastReadMessageId
      ? String(member.lastReadMessageId)
      : null,
    lastReadAt: member.lastReadAt?.toISOString() ?? null,
    lastDeliveredMessageId: member.lastDeliveredMessageId
      ? String(member.lastDeliveredMessageId)
      : null,
    lastDeliveredAt: member.lastDeliveredAt?.toISOString() ?? null,
  };
}

function toUpload(upload: UploadDocument): ChatUpload {
  return {
    id: upload.uploadId,
    conversationId: String(upload.conversationId),
    uploaderId: upload.uploaderId,
    name: upload.name,
    contentType: upload.contentType,
    size: upload.size,
    kind: upload.kind,
    provider: upload.provider,
    objectKey: upload.objectKey,
    status: upload.status,
    expiresAt: upload.expiresAt,
  };
}

@Injectable()
export class MongoChatRepository
  extends MongoChatFeatures
  implements ChatRepository
{
  private readonly conversations: Model<ConversationDocument>;
  private readonly members: Model<MemberDocument>;
  private readonly messages: Model<MessageDocument>;
  private readonly uploads: Model<UploadDocument>;
  private readonly assistantJobs: Model<AssistantJobDocument>;

  constructor(private readonly connection: Connection) {
    super(connection);
    this.conversations = connection.model<ConversationDocument>(
      `${modelPrefix}chat_conversations`,
    );
    this.members = connection.model<MemberDocument>(
      `${modelPrefix}chat_members`,
    );
    this.messages = connection.model<MessageDocument>(
      `${modelPrefix}chat_conversation_messages`,
    );
    this.uploads = connection.model<UploadDocument>(
      `${modelPrefix}chat_uploads`,
    );
    this.assistantJobs = connection.model<AssistantJobDocument>(
      `${modelPrefix}${CHAT_ASSISTANT_JOBS_COLLECTION}`,
    );
  }

  async getConversation(
    actor: ChatActor,
    conversationId: string,
  ): Promise<ChatConversation | null> {
    const page = await this.listConversations(
      actor,
      1,
      undefined,
      undefined,
      false,
      conversationId,
    );
    return page.data[0] ?? null;
  }

  async listConversations(
    actor: ChatActor,
    limit: number,
    before?: ChatCursor,
    search?: string,
    archived = false,
    conversationId?: string,
  ): Promise<ChatConversationPage> {
    if (search && normalizeSearchText(search).length < 2) {
      return this.filterConversationsFallback(
        actor,
        limit,
        before,
        search,
        archived,
        conversationId,
      );
    }
    const stages: PipelineStage[] = [
      ...(search
        ? [
            {
              $search: {
                index: CHAT_SEARCH_INDEX,
                compound: {
                  must: [autocompleteClause('searchLabel', search)],
                  filter: [
                    {
                      equals: {
                        path: 'organizationId',
                        value: new Types.ObjectId(actor.organizationId),
                      },
                    },
                    { equals: { path: 'userId', value: actor.id } },
                  ],
                },
              },
            },
          ]
        : []),
      {
        $match: {
          organizationId: new Types.ObjectId(actor.organizationId),
          userId: actor.id,
          status: ACTIVE,
          ...(conversationId
            ? { conversationId: new Types.ObjectId(conversationId) }
            : { isArchived: archived ? true : { $ne: true } }),
        },
      },
      {
        $lookup: {
          from: 'chat_conversations',
          localField: 'conversationId',
          foreignField: '_id',
          as: 'conversation',
        },
      },
      { $unwind: '$conversation' },
      {
        $match: {
          'conversation.organizationId': new Types.ObjectId(
            actor.organizationId,
          ),
          'conversation.status': ACTIVE,
        },
      },
      {
        $addFields: {
          isPinned: { $ifNull: ['$isPinned', false] },
          activityAt: {
            $ifNull: ['$conversation.lastMessageAt', '$conversation.createdAt'],
          },
        },
      },
      ...(before
        ? [
            {
              $match: {
                $or: [
                  ...(before.isPinned ? [{ isPinned: false }] : []),
                  {
                    isPinned: before.isPinned ?? false,
                    $or: [
                      { activityAt: { $lt: before.createdAt } },
                      {
                        activityAt: before.createdAt,
                        'conversation._id': {
                          $lt: new Types.ObjectId(before.id),
                        },
                      },
                    ],
                  },
                ],
              },
            } as PipelineStage,
          ]
        : []),
      ...(!search
        ? ([
            { $sort: { isPinned: -1, activityAt: -1, 'conversation._id': -1 } },
            { $limit: limit + 1 },
          ] as PipelineStage[])
        : []),
      {
        $lookup: {
          from: 'chat_members',
          let: { conversationId: '$conversationId' },
          pipeline: [
            {
              $match: {
                organizationId: new Types.ObjectId(actor.organizationId),
                $expr: { $eq: ['$conversationId', '$$conversationId'] },
                status: ACTIVE,
              },
            },
            {
              $project: {
                _id: 0,
                userId: 1,
                displayName: 1,
                avatarUrl: 1,
                role: 1,
                lastReadMessageId: 1,
                lastReadAt: 1,
                lastDeliveredMessageId: 1,
                lastDeliveredAt: 1,
              },
            },
          ],
          as: 'participants',
        },
      },
      ...(search
        ? ([
            { $sort: { isPinned: -1, activityAt: -1, 'conversation._id': -1 } },
            { $limit: limit + 1 },
          ] as PipelineStage[])
        : []),
      {
        $lookup: {
          from: 'chat_conversation_messages',
          let: {
            conversationId: '$conversationId',
            lastReadAt: { $ifNull: ['$lastReadAt', new Date(0)] },
            lastReadMessageId: '$lastReadMessageId',
          },
          pipeline: [
            {
              $match: {
                organizationId: new Types.ObjectId(actor.organizationId),
                $expr: {
                  $and: [
                    { $eq: ['$conversationId', '$$conversationId'] },
                    { $ne: ['$senderId', actor.id] },
                    {
                      $or: [
                        { $gt: ['$createdAt', '$$lastReadAt'] },
                        {
                          $and: [
                            { $eq: ['$createdAt', '$$lastReadAt'] },
                            { $ne: ['$$lastReadMessageId', null] },
                            { $gt: ['$_id', '$$lastReadMessageId'] },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
            { $limit: 100 },
            { $count: 'count' },
          ],
          as: 'unread',
        },
      },
      {
        $project: {
          _id: 0,
          conversation: 1,
          isPinned: 1,
          isArchived: 1,
          markedUnread: 1,
          notificationMode: 1,
          lastReadMessageId: 1,
          lastReadAt: 1,
          activityAt: 1,
          participants: 1,
          unread: 1,
        },
      },
    ];
    let rows: ConversationAggregate[];
    try {
      rows = await this.members.aggregate<ConversationAggregate>(stages).exec();
    } catch (error) {
      if (!search) throw error;
      return this.filterConversationsFallback(
        actor,
        limit,
        before,
        search,
        archived,
        conversationId,
      );
    }
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const next = page.at(-1);
    return {
      data: page.map((row) => this.toConversation(row)),
      hasMore,
      nextCursor:
        hasMore && next
          ? {
              createdAt: next.activityAt,
              id: String(next.conversation._id),
              isPinned: next.isPinned ?? false,
            }
          : null,
    };
  }

  private async filterConversationsFallback(
    actor: ChatActor,
    limit: number,
    before: ChatCursor | undefined,
    search: string,
    archived: boolean,
    conversationId?: string,
  ): Promise<ChatConversationPage> {
    const fallbackPage = await this.listConversations(
      actor,
      Math.max(limit, 50),
      before,
      undefined,
      archived,
      conversationId,
    );
    const tokens = normalizeSearchText(search).split(/\s+/).filter(Boolean);
    const filtered = fallbackPage.data
      .filter((conversation) => {
        const label =
          conversation.type === 'ROOM'
            ? (conversation.title ?? '')
            : (conversation.members.find((m) => m.userId !== actor.id)
                ?.displayName ?? '');
        const normalizedLabel = normalizeSearchText(label);
        return (
          tokens.length === 0 ||
          tokens.every((token) => normalizedLabel.includes(token))
        );
      })
      .slice(0, limit);
    return {
      data: filtered,
      hasMore: false,
      nextCursor: null,
    };
  }

  async createDirect(
    actor: ChatActor,
    recipient: ChatCandidate,
  ): Promise<string> {
    const sortedIds = [actor.id, recipient.id].sort();
    const directKey = `${actor.organizationId}:${sortedIds[0]}:${sortedIds[1]}`;
    const organizationId = new Types.ObjectId(actor.organizationId);
    let conversation: ConversationDocument | null;
    try {
      conversation = await this.conversations
        .findOneAndUpdate(
          { organizationId, directKey },
          {
            $setOnInsert: {
              organizationId,
              type: 'DIRECT',
              directKey,
              title: null,
              createdBy: actor.id,
              status: ACTIVE,
              lastMessageAt: null,
              lastMessageId: null,
              lastMessagePreview: '',
              lastMessageSenderId: null,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        )
        .lean()
        .exec();
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      conversation = await this.conversations
        .findOne({ organizationId, directKey })
        .lean()
        .exec();
    }
    if (!conversation)
      throw new Error('Direct conversation could not be created');
    await Promise.all([
      this.upsertMember(
        conversation._id,
        organizationId,
        actor,
        'OWNER',
        recipient.fullName,
      ),
      this.upsertMember(
        conversation._id,
        organizationId,
        recipient,
        'MEMBER',
        actor.name,
      ),
    ]);
    return String(conversation._id);
  }

  async createRoom(
    actor: ChatActor,
    title: string,
    recipients: ChatCandidate[],
    clientRoomId: string,
  ): Promise<string> {
    const organizationId = new Types.ObjectId(actor.organizationId);
    const creationKey = `${actor.organizationId}:${actor.id}:${clientRoomId}`;
    const existing = await this.conversations
      .findOne({ creationKey, organizationId })
      .lean()
      .exec();
    if (existing) return String(existing._id);
    const session = await this.connection.startSession();
    let conversationId = '';
    try {
      await session.withTransaction(
        async () => {
          const [conversation] = await this.conversations.create(
            [
              {
                organizationId,
                type: 'ROOM',
                creationKey,
                title,
                createdBy: actor.id,
                status: ACTIVE,
                lastMessageAt: null,
                lastMessageId: null,
                lastMessagePreview: '',
                lastMessageSenderId: null,
                membershipVersion: 0,
              },
            ],
            { session },
          );
          conversationId = String(conversation._id);
          await this.members.insertMany(
            [
              {
                organizationId,
                conversationId: conversation._id,
                userId: actor.id,
                displayName: actor.name,
                searchLabel: title,
                avatarUrl: actor.avatarUrl,
                role: 'OWNER',
                status: ACTIVE,
                joinedAt: new Date(),
              },
              ...recipients.map((person) => ({
                organizationId,
                conversationId: conversation._id,
                userId: person.id,
                displayName: person.fullName,
                searchLabel: title,
                avatarUrl: person.avatarUrl,
                role: 'MEMBER' as const,
                status: ACTIVE,
                joinedAt: new Date(),
              })),
            ],
            { session },
          );
        },
        { writeConcern: { w: 'majority', wtimeoutMS: 5_000 } },
      );
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      const duplicate = await this.conversations
        .findOne({ creationKey, organizationId })
        .lean()
        .exec();
      if (!duplicate) throw error;
      return String(duplicate._id);
    } finally {
      await session.endSession();
    }
    return conversationId;
  }

  async renameRoom(
    actor: ChatActor,
    conversationId: string,
    title: string,
  ): Promise<string[]> {
    const id = new Types.ObjectId(conversationId);
    const organizationId = new Types.ObjectId(actor.organizationId);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(
        async () => {
          await this.requireRoomOwner(actor, id, session);
          const updated = await this.conversations
            .updateOne(
              {
                _id: id,
                organizationId,
                type: 'ROOM',
                status: ACTIVE,
              },
              { $set: { title } },
              { session },
            )
            .exec();
          if (!updated.matchedCount) throw this.conversationNotFound();
          await this.members
            .updateMany(
              {
                conversationId: id,
                organizationId,
              },
              { $set: { searchLabel: title } },
              { session },
            )
            .exec();
        },
        { writeConcern: { w: 'majority', wtimeoutMS: 5_000 } },
      );
    } finally {
      await session.endSession();
    }
    return this.memberIds(actor, conversationId);
  }

  async addRoomMembers(
    actor: ChatActor,
    conversationId: string,
    people: ChatCandidate[],
  ): Promise<string[]> {
    const id = new Types.ObjectId(conversationId);
    const organizationId = new Types.ObjectId(actor.organizationId);
    await this.requireRoomOwner(actor, id);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(
        async () => {
          const existing = await this.members
            .find(
              {
                organizationId,
                conversationId: id,
                userId: { $in: people.map((person) => person.id) },
              },
              { userId: 1, status: 1, _id: 0 },
            )
            .session(session)
            .lean()
            .exec();
          const existingByUserId = new Map(
            existing.map((member) => [member.userId, member.status]),
          );
          const newCount = people.filter(
            (person) => existingByUserId.get(person.id) !== ACTIVE,
          ).length;
          const activeCount = await this.members
            .countDocuments({
              organizationId,
              conversationId: id,
              status: ACTIVE,
            })
            .session(session)
            .exec();
          if (activeCount + newCount > 50) {
            throw new ConflictException({
              code: 'CHAT_ROOM_MEMBER_LIMIT',
              message: 'A room can have at most 50 members.',
            });
          }
          if (newCount > 0) {
            const lock = await this.conversations
              .updateOne(
                {
                  _id: id,
                  organizationId,
                  type: 'ROOM',
                  status: ACTIVE,
                },
                { $inc: { membershipVersion: 1 } },
                { session },
              )
              .exec();
            if (!lock.matchedCount) throw this.conversationNotFound();
          }
          const room = await this.conversations
            .findOne({ _id: id, organizationId })
            .session(session)
            .lean()
            .exec();
          for (const person of people) {
            if (existingByUserId.get(person.id) === ACTIVE) continue;
            await this.members
              .updateOne(
                { organizationId, conversationId: id, userId: person.id },
                {
                  $set: {
                    displayName: person.fullName,
                    searchLabel: room?.title ?? '',
                    avatarUrl: person.avatarUrl,
                    role: 'MEMBER',
                    status: ACTIVE,
                    joinedAt: new Date(),
                  },
                  $setOnInsert: {
                    organizationId,
                    conversationId: id,
                    userId: person.id,
                  },
                },
                { upsert: true, session },
              )
              .exec();
          }
        },
        { writeConcern: { w: 'majority', wtimeoutMS: 5_000 } },
      );
    } finally {
      await session.endSession();
    }
    return this.memberIds(actor, conversationId);
  }

  async removeRoomMember(
    actor: ChatActor,
    conversationId: string,
    userId: string,
  ): Promise<string[]> {
    if (userId === actor.id) throw this.conversationNotFound();
    const id = new Types.ObjectId(conversationId);
    const organizationId = new Types.ObjectId(actor.organizationId);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(
        async () => {
          await this.requireRoomOwner(actor, id, session);
          const result = await this.members
            .updateOne(
              {
                organizationId,
                conversationId: id,
                userId,
                role: { $in: ['MEMBER', 'MANAGER'] },
                status: ACTIVE,
              },
              { $set: { status: 'LEFT' } },
              { session },
            )
            .exec();
          if (!result.modifiedCount) throw this.conversationNotFound();
          const bumped = await this.conversations
            .updateOne(
              {
                _id: id,
                organizationId,
                type: 'ROOM',
                status: ACTIVE,
              },
              { $inc: { membershipVersion: 1 } },
              { session },
            )
            .exec();
          if (!bumped.matchedCount) throw this.conversationNotFound();
        },
        { writeConcern: { w: 'majority', wtimeoutMS: 5_000 } },
      );
    } finally {
      await session.endSession();
    }
    return [...(await this.memberIds(actor, conversationId)), userId];
  }

  async leaveRoom(actor: ChatActor, conversationId: string): Promise<string[]> {
    const id = new Types.ObjectId(conversationId);
    const organizationId = new Types.ObjectId(actor.organizationId);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(
        async () => {
          const room = await this.conversations
            .exists({
              _id: id,
              organizationId,
              type: 'ROOM',
              status: ACTIVE,
            })
            .session(session);
          if (!room) throw this.conversationNotFound();
          const result = await this.members
            .updateOne(
              {
                organizationId,
                conversationId: id,
                userId: actor.id,
                role: { $in: ['MEMBER', 'MANAGER'] },
                status: ACTIVE,
              },
              { $set: { status: 'LEFT' } },
              { session },
            )
            .exec();
          if (!result.modifiedCount) throw this.conversationNotFound();
          const bumped = await this.conversations
            .updateOne(
              {
                _id: id,
                organizationId,
                type: 'ROOM',
                status: ACTIVE,
              },
              { $inc: { membershipVersion: 1 } },
              { session },
            )
            .exec();
          if (!bumped.matchedCount) throw this.conversationNotFound();
        },
        { writeConcern: { w: 'majority', wtimeoutMS: 5_000 } },
      );
    } finally {
      await session.endSession();
    }
    return [...(await this.memberIds(actor, conversationId)), actor.id];
  }

  async listMessages(
    actor: ChatActor,
    conversationId: string,
    limit: number,
    before?: ChatCursor,
  ): Promise<ChatMessagePage> {
    const id = new Types.ObjectId(conversationId);
    await this.requireMember(actor, id);
    const query = {
      organizationId: new Types.ObjectId(actor.organizationId),
      conversationId: id,
      ...(before
        ? {
            $or: [
              { createdAt: { $lt: before.createdAt } },
              {
                createdAt: before.createdAt,
                _id: { $lt: new Types.ObjectId(before.id) },
              },
            ],
          }
        : {}),
    };
    const rows = await this.messages
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean()
      .exec();
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const oldest = page.at(-1);
    return {
      data: await this.mapMessages(actor, page.reverse()),
      hasMore,
      nextCursor:
        hasMore && oldest
          ? { createdAt: oldest.createdAt, id: String(oldest._id) }
          : null,
    };
  }

  async messagesAround(
    actor: ChatActor,
    conversationId: string,
    messageId: string,
    limit: number,
  ): Promise<ChatMessagePage> {
    const scope = {
      organizationId: new Types.ObjectId(actor.organizationId),
      conversationId: new Types.ObjectId(conversationId),
    };
    await this.requireMember(actor, scope.conversationId);
    const target = await this.messages
      .findOne({ ...scope, _id: new Types.ObjectId(messageId) })
      .lean()
      .exec();
    if (!target) throw this.conversationNotFound();
    const beforeCount = Math.floor((limit - 1) / 2);
    const afterCount = limit - 1 - beforeCount;
    const [before, after] = await Promise.all([
      this.messages
        .find({
          ...scope,
          $or: [
            { createdAt: { $lt: target.createdAt } },
            { createdAt: target.createdAt, _id: { $lt: target._id } },
          ],
        })
        .sort({ createdAt: -1, _id: -1 })
        .limit(beforeCount + 1)
        .lean()
        .exec(),
      afterCount > 0
        ? this.messages
            .find({
              ...scope,
              $or: [
                { createdAt: { $gt: target.createdAt } },
                { createdAt: target.createdAt, _id: { $gt: target._id } },
              ],
            })
            .sort({ createdAt: 1, _id: 1 })
            .limit(afterCount)
            .lean()
            .exec()
        : Promise.resolve([]),
    ]);
    const page = [...before.slice(0, beforeCount).reverse(), target, ...after];
    const hasMore = before.length > beforeCount;
    return {
      data: await this.mapMessages(actor, page),
      hasMore,
      nextCursor: hasMore
        ? { createdAt: page[0].createdAt, id: String(page[0]._id) }
        : null,
    };
  }

  async searchMessages(
    actor: ChatActor,
    conversationId: string,
    search: string,
    limit: number,
    before?: ChatCursor,
  ): Promise<ChatMessagePage> {
    const id = new Types.ObjectId(conversationId);
    await this.requireMember(actor, id);
    const rows = await this.messages
      .aggregate<MessageDocument>([
        textSearchStage(search, [
          {
            equals: {
              path: 'organizationId',
              value: new Types.ObjectId(actor.organizationId),
            },
          },
          { equals: { path: 'conversationId', value: id } },
        ]),
        {
          $match: {
            organizationId: new Types.ObjectId(actor.organizationId),
            conversationId: id,
            deletedAt: null,
            ...(before
              ? {
                  $or: [
                    { createdAt: { $lt: before.createdAt } },
                    {
                      createdAt: before.createdAt,
                      _id: { $lt: new Types.ObjectId(before.id) },
                    },
                  ],
                }
              : {}),
          },
        },
        { $sort: { createdAt: -1, _id: -1 } },
        { $limit: limit + 1 },
      ])
      .exec();
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const oldest = page.at(-1);
    return {
      data: await this.mapMessages(actor, page.reverse()),
      hasMore,
      nextCursor:
        hasMore && oldest
          ? { createdAt: oldest.createdAt, id: String(oldest._id) }
          : null,
    };
  }

  async createUpload(actor: ChatActor, upload: ChatUpload): Promise<void> {
    const conversationId = new Types.ObjectId(upload.conversationId);
    await this.requireMember(actor, conversationId);
    await this.uploads.create(
      [
        {
          uploadId: upload.id,
          organizationId: new Types.ObjectId(actor.organizationId),
          conversationId,
          uploaderId: actor.id,
          name: upload.name,
          contentType: upload.contentType,
          size: upload.size,
          kind: upload.kind,
          provider: upload.provider,
          objectKey: upload.objectKey,
          status: 'PENDING',
          expiresAt: upload.expiresAt,
        },
      ],
      { w: 'majority', wtimeout: 5_000 },
    );
  }

  async getUpload(
    actor: ChatActor,
    conversationId: string,
    uploadId: string,
  ): Promise<ChatUpload | null> {
    const conversationObjectId = new Types.ObjectId(conversationId);
    await this.requireMember(actor, conversationObjectId);
    const upload = await this.uploads
      .findOne({
        uploadId,
        organizationId: new Types.ObjectId(actor.organizationId),
        conversationId: conversationObjectId,
        uploaderId: actor.id,
        expiresAt: { $gt: new Date() },
      })
      .lean()
      .exec();
    return upload ? toUpload(upload) : null;
  }

  async completeUpload(
    actor: ChatActor,
    conversationId: string,
    uploadId: string,
  ): Promise<ChatUpload | null> {
    const conversationObjectId = new Types.ObjectId(conversationId);
    await this.requireMember(actor, conversationObjectId);
    const upload = await this.uploads
      .findOneAndUpdate(
        {
          uploadId,
          organizationId: new Types.ObjectId(actor.organizationId),
          conversationId: conversationObjectId,
          uploaderId: actor.id,
          status: { $in: ['PENDING', 'READY'] },
          expiresAt: { $gt: new Date() },
        },
        { $set: { status: 'READY' } },
        { new: true },
      )
      .lean()
      .exec();
    return upload ? toUpload(upload) : null;
  }

  async getAttachmentObject(
    actor: ChatActor,
    conversationId: string,
    attachmentId: string,
  ): Promise<Pick<
    ChatUpload,
    'provider' | 'objectKey' | 'name' | 'contentType' | 'kind'
  > | null> {
    const conversationObjectId = new Types.ObjectId(conversationId);
    await this.requireMember(actor, conversationObjectId);
    const message = await this.messages
      .findOne({
        organizationId: new Types.ObjectId(actor.organizationId),
        conversationId: conversationObjectId,
        deletedAt: null,
        'attachments.id': attachmentId,
      })
      .lean()
      .exec();
    const attachment = message?.attachments?.find(
      (item) => item.id === attachmentId,
    );
    return attachment
      ? {
          provider: attachment.provider,
          objectKey: attachment.objectKey,
          name: attachment.name,
          contentType: attachment.contentType,
          kind: attachment.kind,
        }
      : null;
  }

  async markDelivered(
    actor: ChatActor,
    conversationId: string,
    messageId: string,
  ): Promise<ChatDeliveryState> {
    const conversationObjectId = new Types.ObjectId(conversationId);
    const messageObjectId = new Types.ObjectId(messageId);
    await this.requireMember(actor, conversationObjectId);
    const message = await this.messages
      .findOne({
        _id: messageObjectId,
        organizationId: new Types.ObjectId(actor.organizationId),
        conversationId: conversationObjectId,
      })
      .select({ _id: 1, createdAt: 1 })
      .lean()
      .exec();
    if (!message) throw this.conversationNotFound();
    const memberFilter = {
      organizationId: new Types.ObjectId(actor.organizationId),
      conversationId: conversationObjectId,
      userId: actor.id,
      status: ACTIVE,
      $or: [
        { lastDeliveredAt: null },
        { lastDeliveredMessageId: message._id, deliveredRecordedAt: null },
        { lastDeliveredAt: { $lt: message.createdAt } },
        {
          lastDeliveredAt: message.createdAt,
          lastDeliveredMessageId: { $lt: message._id },
        },
      ],
    };
    const membership = await this.members
      .findOneAndUpdate(
        memberFilter,
        {
          $set: {
            lastDeliveredMessageId: message._id,
            lastDeliveredAt: message.createdAt,
            deliveredRecordedAt: new Date(),
          },
        },
        { new: true },
      )
      .lean()
      .exec();
    const current =
      membership ??
      (await this.members
        .findOne({
          organizationId: new Types.ObjectId(actor.organizationId),
          conversationId: conversationObjectId,
          userId: actor.id,
          status: ACTIVE,
        })
        .lean()
        .exec());
    if (!current) throw this.conversationNotFound();
    return {
      conversationId,
      userId: actor.id,
      lastDeliveredMessageId: String(
        current.lastDeliveredMessageId ?? message._id,
      ),
      lastDeliveredAt: (
        current.lastDeliveredAt ?? message.createdAt
      ).toISOString(),
    };
  }

  async sendMessage(
    actor: ChatActor,
    conversationId: string,
    clientMessageId: string,
    content: string,
    attachmentIds: string[] = [],
    replyToMessageId?: string,
    mentionUserIds: string[] = [],
    assistantMention?: ChatAssistantMentionNormalized,
  ): Promise<ChatMessageWrite> {
    const conversationObjectId = new Types.ObjectId(conversationId);
    const organizationObjectId = new Types.ObjectId(actor.organizationId);
    await this.requireMember(actor, conversationObjectId);
    const conversation = await this.assertCanSend(actor, conversationId);
    if (assistantMention && conversation.type !== 'DIRECT') {
      throw new UnprocessableEntityException({
        code: 'CHAT_ASSISTANT_DIRECT_ONLY',
        message:
          'Continuum AI assistant is only available in 1-on-1 direct conversations.',
      });
    }
    let message: MessageDocument | null = null;
    let assistantStatusEvent: AssistantStatusEvent | undefined;

    if (attachmentIds.length > 0 || replyToMessageId || assistantMention) {
      const existing = await this.messages
        .findOne({
          organizationId: organizationObjectId,
          conversationId: conversationObjectId,
          senderId: actor.id,
          clientMessageId,
        })
        .lean()
        .exec();
      if (existing) {
        const matches =
          existing.content === content &&
          String(existing.replyToMessageId ?? '') ===
            (replyToMessageId ?? '') &&
          (existing.attachments ?? []).map(({ id }) => id).join(',') ===
            attachmentIds.join(',') &&
          assistantMentionsEqual(existing.assistantMention, assistantMention);
        if (!matches) {
          throw new ConflictException({
            code: 'CHAT_IDEMPOTENCY_CONFLICT',
            message: 'clientMessageId was already used for different content.',
          });
        }
        message = existing;
      } else {
        const session = await this.connection.startSession();
        try {
          await session.withTransaction(
            async () => {
              if (assistantMention) {
                const txConversation = await this.assertCanSend(
                  actor,
                  conversationId,
                  session,
                );
                if (txConversation.type !== 'DIRECT') {
                  throw new UnprocessableEntityException({
                    code: 'CHAT_ASSISTANT_DIRECT_ONLY',
                    message:
                      'Continuum AI assistant is only available in 1-on-1 direct conversations.',
                  });
                }
              }
              const uploads = attachmentIds.length
                ? await this.uploads
                    .find({
                      uploadId: { $in: attachmentIds },
                      organizationId: organizationObjectId,
                      conversationId: conversationObjectId,
                      uploaderId: actor.id,
                      status: 'READY',
                      expiresAt: { $gt: new Date() },
                    })
                    .session(session)
                    .lean()
                    .exec()
                : [];
              if (uploads.length !== attachmentIds.length) {
                throw new ConflictException({
                  code: 'CHAT_UPLOAD_NOT_READY',
                  message: 'One or more attachments are unavailable.',
                });
              }
              if (replyToMessageId) {
                const root = await this.messages
                  .exists({
                    _id: new Types.ObjectId(replyToMessageId),
                    organizationId: organizationObjectId,
                    conversationId: conversationObjectId,
                    deletedAt: null,
                  })
                  .session(session);
                if (!root) throw this.conversationNotFound();
              }
              const uploadById = new Map(
                uploads.map((upload) => [upload.uploadId, upload]),
              );
              const attachments = attachmentIds.map((uploadId) => {
                const upload = uploadById.get(uploadId);
                if (!upload) throw new Error('A validated upload disappeared.');
                return {
                  id: upload.uploadId,
                  name: upload.name,
                  contentType: upload.contentType,
                  size: upload.size,
                  kind: upload.kind,
                  provider: upload.provider,
                  objectKey: upload.objectKey,
                };
              });
              const [created] = await this.messages.create(
                [
                  {
                    organizationId: organizationObjectId,
                    conversationId: conversationObjectId,
                    senderId: actor.id,
                    senderName: actor.name,
                    senderAvatarUrl: actor.avatarUrl,
                    clientMessageId,
                    content,
                    mentionUserIds,
                    links: chatLinks(content),
                    replyToMessageId: replyToMessageId
                      ? new Types.ObjectId(replyToMessageId)
                      : null,
                    attachments,
                    contentVersion: 0,
                    ...(assistantMention
                      ? {
                          authorType: 'USER' as const,
                          assistantMention: {
                            handle: assistantMention.handle,
                            query: assistantMention.query,
                            timezone: assistantMention.timezone,
                          },
                        }
                      : {}),
                  },
                ],
                { session },
              );
              message = created.toObject();
              if (assistantMention) {
                const now = created.createdAt ?? new Date();
                const requesterDisplayName =
                  actor.name.trim().slice(0, 120) || 'Member';
                const maxAttempts = Math.min(
                  5,
                  Math.max(1, Math.round(assistantMention.maxAttempts ?? 3)),
                );
                const [createdJob] = await this.assistantJobs.create(
                  [
                    {
                      organizationId: organizationObjectId,
                      conversationId: conversationObjectId,
                      triggerMessageId: created._id,
                      requesterUserId: actor.id,
                      requesterDisplayName,
                      handle: assistantMention.handle,
                      query: assistantMention.query,
                      timezone: assistantMention.timezone,
                      status: 'PENDING',
                      failureCode: null,
                      failureReason: null,
                      attempts: 0,
                      maxAttempts,
                      nextAttemptAt: now,
                      lockedBy: null,
                      lockedUntil: null,
                      responseMessageId: null,
                      metrics: null,
                      completedAt: null,
                    },
                  ],
                  { session },
                );
                const jobObj = createdJob.toObject();
                assistantStatusEvent = {
                  conversationId,
                  triggerMessageId: String(created._id),
                  jobId: String(jobObj._id),
                  status: 'PENDING',
                  failureCode: null,
                  responseMessageId: null,
                  updatedAt: (
                    jobObj.updatedAt ??
                    jobObj.createdAt ??
                    now
                  ).toISOString(),
                };
              }
              if (attachmentIds.length) {
                const updated = await this.uploads.updateMany(
                  {
                    uploadId: { $in: attachmentIds },
                    organizationId: organizationObjectId,
                    conversationId: conversationObjectId,
                    uploaderId: actor.id,
                    status: 'READY',
                  },
                  { $set: { status: 'ATTACHED' } },
                  { session },
                );
                if (updated.modifiedCount !== attachmentIds.length) {
                  throw new ConflictException({
                    code: 'CHAT_UPLOAD_NOT_READY',
                    message: 'One or more attachments are unavailable.',
                  });
                }
              }
              await this.conversations
                .updateOne(
                  {
                    _id: conversationObjectId,
                    organizationId: organizationObjectId,
                    $or: [
                      { lastMessageAt: null },
                      { lastMessageAt: { $lt: created.createdAt } },
                      {
                        lastMessageAt: created.createdAt,
                        lastMessageId: { $lt: created._id },
                      },
                    ],
                  },
                  {
                    $set: {
                      lastMessageAt: created.createdAt,
                      lastMessageId: created._id,
                      lastMessagePreview:
                        content.slice(0, 180) ||
                        (attachments.length === 1
                          ? attachments[0].name
                          : `${attachments.length} attachments`),
                      lastMessageSenderId: actor.id,
                    },
                  },
                  { session },
                )
                .exec();
            },
            { writeConcern: { w: 'majority', wtimeout: 5_000 } },
          );
        } catch (error) {
          if (!duplicateKey(error)) throw error;
          assistantStatusEvent = undefined;
          message = await this.messages
            .findOne({
              organizationId: organizationObjectId,
              conversationId: conversationObjectId,
              senderId: actor.id,
              clientMessageId,
            })
            .lean()
            .exec();
          if (
            !message ||
            message.content !== content ||
            String(message.replyToMessageId ?? '') !==
              (replyToMessageId ?? '') ||
            (message.attachments ?? []).map(({ id }) => id).join(',') !==
              attachmentIds.join(',') ||
            !assistantMentionsEqual(message.assistantMention, assistantMention)
          ) {
            throw new ConflictException({
              code: 'CHAT_IDEMPOTENCY_CONFLICT',
              message:
                'clientMessageId was already used for different content.',
            });
          }
        } finally {
          await session.endSession();
        }
      }
    }

    if (!message) {
      try {
        const [created] = await this.messages.create(
          [
            {
              organizationId: organizationObjectId,
              conversationId: conversationObjectId,
              senderId: actor.id,
              senderName: actor.name,
              senderAvatarUrl: actor.avatarUrl,
              clientMessageId,
              content,
              mentionUserIds,
              links: chatLinks(content),
              contentVersion: 0,
            },
          ],
          { w: 'majority', wtimeout: 5_000 },
        );
        message = created.toObject();
      } catch (error) {
        if (!duplicateKey(error)) throw error;
        message = await this.messages
          .findOne({
            organizationId: organizationObjectId,
            conversationId: conversationObjectId,
            senderId: actor.id,
            clientMessageId,
          })
          .lean()
          .exec();
        if (
          message &&
          (message.content !== content ||
            Boolean(message.replyToMessageId) ||
            (message.attachments ?? []).length > 0 ||
            attachmentIds.length > 0 ||
            replyToMessageId ||
            !assistantMentionsEqual(message.assistantMention, assistantMention))
        ) {
          throw new ConflictException({
            code: 'CHAT_IDEMPOTENCY_CONFLICT',
            message: 'clientMessageId was already used for different content.',
          });
        }
      }
    }
    if (!message) throw new Error('Message could not be stored');
    if (
      JSON.stringify([...(message.mentionUserIds ?? [])].sort()) !==
        JSON.stringify([...mentionUserIds].sort()) ||
      !assistantMentionsEqual(message.assistantMention, assistantMention)
    )
      throw new ConflictException({
        code: 'CHAT_IDEMPOTENCY_CONFLICT',
        message: 'clientMessageId was already used for different mentions.',
      });
    if (attachmentIds.length === 0 && !replyToMessageId && !assistantMention) {
      await this.conversations
        .updateOne(
          {
            _id: conversationObjectId,
            organizationId: organizationObjectId,
            $or: [
              { lastMessageAt: null },
              { lastMessageAt: { $lt: message.createdAt } },
              {
                lastMessageAt: message.createdAt,
                lastMessageId: { $lt: message._id },
              },
            ],
          },
          {
            $set: {
              lastMessageAt: message.createdAt,
              lastMessageId: message._id,
              lastMessagePreview: message.content.slice(0, 180),
              lastMessageSenderId: message.senderId,
            },
          },
        )
        .exec();
    }
    const recipientRows = await this.members
      .find(
        {
          organizationId: organizationObjectId,
          conversationId: conversationObjectId,
          status: ACTIVE,
        },
        { userId: 1, _id: 0 },
      )
      .lean()
      .exec();
    await this.createNotifications(actor, message);
    return {
      message: await this.mapMessage(actor, message),
      recipientIds: recipientRows.map((member) => member.userId),
      ...(assistantStatusEvent ? { assistantStatusEvent } : {}),
    };
  }

  async editMessage(
    actor: ChatActor,
    conversationId: string,
    messageId: string,
    content: string,
    mentionUserIds: string[] = [],
  ): Promise<ChatMessageWrite> {
    const conversationObjectId = new Types.ObjectId(conversationId);
    const messageObjectId = new Types.ObjectId(messageId);
    const organizationId = new Types.ObjectId(actor.organizationId);
    await this.requireMember(actor, conversationObjectId);
    const editedAt = new Date();
    let previous: MessageDocument | null = null;

    const performEdit = async (session?: ClientSession) => {
      const updateOptions = session
        ? { new: false, runValidators: true, session }
        : { new: false, runValidators: true };
      previous = await this.messages
        .findOneAndUpdate(
          {
            _id: messageObjectId,
            organizationId,
            conversationId: conversationObjectId,
            senderId: actor.id,
            deletedAt: null,
            authorType: { $ne: 'ASSISTANT' },
          },
          {
            $set: {
              content,
              mentionUserIds,
              links: chatLinks(content),
              editedAt,
            },
            $inc: { contentVersion: 1 },
          },
          updateOptions,
        )
        .lean()
        .exec();
      if (!previous) {
        if (typeof this.messages.findOne === 'function') {
          const existingQuery = this.messages.findOne({
            _id: messageObjectId,
            organizationId,
            conversationId: conversationObjectId,
          });
          const existing = await (
            session ? existingQuery.session(session) : existingQuery
          )
            .lean()
            .exec();
          if (
            existing &&
            (existing.authorType === 'ASSISTANT' ||
              existing.senderId === CONTINUUM_AI_SENDER_ID)
          ) {
            throw this.assistantMessageImmutable();
          }
        }
        throw this.conversationNotFound();
      }
      await this.conversations
        .updateOne(
          {
            _id: conversationObjectId,
            organizationId,
          },
          { $inc: { contextRevision: 1 } },
          session ? { session } : undefined,
        )
        .exec();
      await this.conversations
        .updateOne(
          {
            _id: conversationObjectId,
            organizationId,
            lastMessageId: messageObjectId,
          },
          { $set: { lastMessagePreview: content.slice(0, 180) } },
          session ? { session } : undefined,
        )
        .exec();
    };

    if (typeof this.connection.startSession === 'function') {
      const session = await this.connection.startSession();
      try {
        await session.withTransaction(() => performEdit(session), {
          writeConcern: { w: 'majority', wtimeoutMS: 5_000 },
        });
      } finally {
        await session.endSession();
      }
    } else {
      await performEdit();
    }

    if (!previous) throw this.conversationNotFound();
    const prevDoc = previous as MessageDocument;
    const previousMentions = new Set(prevDoc.mentionUserIds ?? []);
    const newlyMentionedUserIds = mentionUserIds.filter(
      (id) => !previousMentions.has(id),
    );
    const message: MessageDocument = {
      ...prevDoc,
      content,
      mentionUserIds,
      editedAt,
      contentVersion: (prevDoc.contentVersion ?? 0) + 1,
    };
    return {
      message: await this.mapMessage(actor, message),
      recipientIds: await this.memberIds(actor, conversationId),
      newlyMentionedUserIds,
    };
  }

  async deleteMessage(
    actor: ChatActor,
    conversationId: string,
    messageId: string,
  ): Promise<ChatMessageWrite> {
    const conversationObjectId = new Types.ObjectId(conversationId);
    const messageObjectId = new Types.ObjectId(messageId);
    const organizationId = new Types.ObjectId(actor.organizationId);
    await this.requireMember(actor, conversationObjectId);
    const current = await this.messages
      .findOne({
        _id: messageObjectId,
        organizationId,
        conversationId: conversationObjectId,
      })
      .lean()
      .exec();
    if (!current) throw this.conversationNotFound();
    if (
      current.authorType === 'ASSISTANT' ||
      current.senderId === CONTINUUM_AI_SENDER_ID
    ) {
      throw this.assistantMessageImmutable();
    }
    if (current.senderId !== actor.id) throw this.conversationNotFound();

    // Idempotent repeat delete MUST NOT bump contentVersion or contextRevision.
    if (current.deletedAt) {
      return {
        message: await this.mapMessage(actor, current),
        recipientIds: await this.memberIds(actor, conversationId),
      };
    }

    let message: MessageDocument | null = null;
    const performDelete = async (session?: ClientSession) => {
      const deleted = await this.messages
        .findOneAndUpdate(
          {
            _id: messageObjectId,
            organizationId,
            conversationId: conversationObjectId,
            senderId: actor.id,
            deletedAt: null,
          },
          {
            $set: {
              content: '',
              deletedAt: new Date(),
              reactions: [],
              attachments: [],
              mentionUserIds: [],
              links: [],
              isPinned: false,
            },
            $inc: { contentVersion: 1 },
          },
          session ? { new: true, session } : { new: true },
        )
        .lean()
        .exec();

      if (!deleted) {
        // Concurrent delete won the race; treat as idempotent NOOP without bumping contextRevision.
        const latestQuery = this.messages.findOne({
          _id: messageObjectId,
          organizationId,
          conversationId: conversationObjectId,
          senderId: actor.id,
        });
        message = await (session ? latestQuery.session(session) : latestQuery)
          .lean()
          .exec();
        return;
      }

      message = deleted;
      await this.conversations
        .updateOne(
          {
            _id: conversationObjectId,
            organizationId,
          },
          { $inc: { contextRevision: 1 } },
          session ? { session } : undefined,
        )
        .exec();
      await this.conversations
        .updateOne(
          {
            _id: conversationObjectId,
            organizationId,
            lastMessageId: messageObjectId,
          },
          {
            $set: {
              lastMessagePreview: 'Message deleted',
              lastMessageSenderId: actor.id,
            },
          },
          session ? { session } : undefined,
        )
        .exec();
    };

    if (typeof this.connection.startSession === 'function') {
      const session = await this.connection.startSession();
      try {
        await session.withTransaction(() => performDelete(session), {
          writeConcern: { w: 'majority', wtimeoutMS: 5_000 },
        });
      } finally {
        await session.endSession();
      }
    } else {
      await performDelete();
    }

    if (!message) throw this.conversationNotFound();
    return {
      message: await this.mapMessage(actor, message),
      recipientIds: await this.memberIds(actor, conversationId),
    };
  }

  async setReaction(
    actor: ChatActor,
    conversationId: string,
    messageId: string,
    emoji: string,
    active: boolean,
  ): Promise<ChatMessageWrite> {
    const conversationObjectId = new Types.ObjectId(conversationId);
    const messageObjectId = new Types.ObjectId(messageId);
    const baseFilter = {
      _id: messageObjectId,
      organizationId: new Types.ObjectId(actor.organizationId),
      conversationId: conversationObjectId,
      deletedAt: null,
    };
    await this.requireMember(actor, conversationObjectId);
    if (active) {
      const existing = await this.messages
        .updateOne(
          { ...baseFilter, 'reactions.emoji': emoji },
          { $addToSet: { 'reactions.$.userIds': actor.id } },
        )
        .exec();
      if (!existing.matchedCount) {
        const inserted = await this.messages
          .updateOne(
            {
              ...baseFilter,
              reactions: { $not: { $elemMatch: { emoji } } },
            },
            { $push: { reactions: { emoji, userIds: [actor.id] } } },
          )
          .exec();
        if (!inserted.matchedCount) {
          await this.messages
            .updateOne(
              { ...baseFilter, 'reactions.emoji': emoji },
              { $addToSet: { 'reactions.$.userIds': actor.id } },
            )
            .exec();
        }
      }
    } else {
      await this.messages
        .updateOne(
          { ...baseFilter, 'reactions.emoji': emoji },
          { $pull: { 'reactions.$.userIds': actor.id } },
        )
        .exec();
      await this.messages
        .updateOne(
          {
            ...baseFilter,
            reactions: { $elemMatch: { emoji, userIds: { $size: 0 } } },
          },
          { $pull: { reactions: { emoji, userIds: { $size: 0 } } } },
        )
        .exec();
    }
    const message = await this.messages.findOne(baseFilter).lean().exec();
    if (!message) throw this.conversationNotFound();
    return {
      message: await this.mapMessage(actor, message),
      recipientIds: await this.memberIds(actor, conversationId),
    };
  }

  async markRead(
    actor: ChatActor,
    conversationId: string,
    messageId: string,
  ): Promise<ChatReadState> {
    const conversationObjectId = new Types.ObjectId(conversationId);
    await this.requireMember(actor, conversationObjectId);
    const message = await this.messages
      .findOne({
        _id: new Types.ObjectId(messageId),
        organizationId: new Types.ObjectId(actor.organizationId),
        conversationId: conversationObjectId,
      })
      .lean()
      .exec();
    if (!message) throw this.conversationNotFound();
    const membership = await this.members
      .findOneAndUpdate(
        {
          organizationId: new Types.ObjectId(actor.organizationId),
          conversationId: conversationObjectId,
          userId: actor.id,
          status: ACTIVE,
          $or: [
            { lastReadAt: null },
            { lastReadMessageId: message._id, readRecordedAt: null },
            { lastReadAt: { $lt: message.createdAt } },
            {
              lastReadAt: message.createdAt,
              lastReadMessageId: { $lt: message._id },
            },
          ],
        },
        {
          $set: {
            lastReadMessageId: message._id,
            lastReadAt: message.createdAt,
            readRecordedAt: new Date(),
          },
        },
        { new: true },
      )
      .lean()
      .exec();
    const current =
      membership ??
      (await this.members
        .findOne({
          organizationId: new Types.ObjectId(actor.organizationId),
          conversationId: conversationObjectId,
          userId: actor.id,
          status: ACTIVE,
        })
        .lean()
        .exec());
    if (!current) throw this.conversationNotFound();
    await this.readNotificationsThrough(actor, conversationId, message);
    return {
      conversationId,
      userId: actor.id,
      lastReadMessageId: String(current.lastReadMessageId ?? message._id),
      lastReadAt: (current.lastReadAt ?? message.createdAt).toISOString(),
    };
  }

  async isMember(actor: ChatActor, conversationId: string): Promise<boolean> {
    return Boolean(
      await this.members.exists({
        organizationId: new Types.ObjectId(actor.organizationId),
        conversationId: new Types.ObjectId(conversationId),
        userId: actor.id,
        status: ACTIVE,
      }),
    );
  }

  async memberIds(actor: ChatActor, conversationId: string): Promise<string[]> {
    const rows = await this.members
      .find(
        {
          organizationId: new Types.ObjectId(actor.organizationId),
          conversationId: new Types.ObjectId(conversationId),
          status: ACTIVE,
        },
        { userId: 1, _id: 0 },
      )
      .lean()
      .exec();
    return rows.map((member) => member.userId);
  }

  async directContactIds(
    actor: ChatActor,
    targetIds: string[],
  ): Promise<Set<string>> {
    if (targetIds.length === 0) return new Set();
    const organizationId = actor.organizationId.toLowerCase();
    const actorId = actor.id.toLowerCase();
    const targets = [
      ...new Set(targetIds.map((id) => id.toLowerCase())),
    ].filter((id) => id !== actorId);
    const targetByDirectKey = new Map<string, string>(
      targets.map((targetId) => {
        const [first, second] = [actorId, targetId].sort();
        return [`${organizationId}:${first}:${second}`, targetId];
      }),
    );
    if (targetByDirectKey.size === 0) return new Set();
    const directRows = await this.conversations
      .find(
        {
          organizationId: new Types.ObjectId(actor.organizationId),
          type: 'DIRECT',
          status: ACTIVE,
          directKey: { $in: [...targetByDirectKey.keys()] },
        },
        { _id: 1, directKey: 1 },
      )
      .lean()
      .exec();
    if (directRows.length === 0) return new Set();
    const rows = await this.members
      .find(
        {
          conversationId: { $in: directRows.map((row) => row._id) },
          organizationId: new Types.ObjectId(actor.organizationId),
          userId: { $in: [actorId, ...targets] },
          status: ACTIVE,
        },
        { conversationId: 1, userId: 1, _id: 0 },
      )
      .lean()
      .exec();
    const membersByConversation = new Map<string, Set<string>>();
    for (const row of rows) {
      const conversationId = String(row.conversationId);
      const members =
        membersByConversation.get(conversationId) ?? new Set<string>();
      members.add(row.userId.toLowerCase());
      membersByConversation.set(conversationId, members);
    }
    const contacts = new Set<string>();
    for (const row of directRows) {
      const targetId = row.directKey
        ? targetByDirectKey.get(row.directKey)
        : undefined;
      const members = membersByConversation.get(String(row._id));
      if (targetId && members?.has(actorId) && members.has(targetId)) {
        contacts.add(targetId);
      }
    }
    if (contacts.size > 0 && this.connection.db) {
      const contactList = [...contacts];
      const blocks = await this.connection.db
        .collection('chat_blocks')
        .find({
          organizationId: new Types.ObjectId(actor.organizationId),
          $or: [
            { userId: actor.id, targetId: { $in: contactList } },
            { targetId: actor.id, userId: { $in: contactList } },
          ],
        })
        .toArray();
      for (const block of blocks) {
        const blockedPeer =
          String(block.userId).toLowerCase() === actorId
            ? String(block.targetId).toLowerCase()
            : String(block.userId).toLowerCase();
        contacts.delete(blockedPeer);
      }
    }
    return contacts;
  }

  async reconcileCachedMessages(
    actor: ChatActor,
    conversationId: string | undefined,
    messages: ChatMessage[],
  ): Promise<ChatMessage[]> {
    if (!pageNeedsAssistantReEnrichment(messages)) {
      return messages;
    }

    const organizationId = new Types.ObjectId(actor.organizationId);
    const conversationObjectId =
      conversationId && Types.ObjectId.isValid(conversationId)
        ? new Types.ObjectId(conversationId)
        : undefined;
    const scopeFilter = {
      organizationId,
      ...(conversationObjectId ? { conversationId: conversationObjectId } : {}),
    };

    const assistantIds = [
      ...new Set(
        messages.flatMap((msg) =>
          (msg.authorType === 'ASSISTANT' ||
            msg.senderId === CONTINUUM_AI_SENDER_ID) &&
          Array.isArray(msg.sourceReferences) &&
          msg.sourceReferences.length > 0 &&
          Types.ObjectId.isValid(msg.id)
            ? [msg.id]
            : [],
        ),
      ),
    ].map((msgId) => new Types.ObjectId(msgId));

    const activeTriggerIds = [
      ...new Set(
        messages.flatMap((msg) =>
          (msg.assistantState?.status === 'PENDING' ||
            msg.assistantState?.status === 'PROCESSING') &&
          Types.ObjectId.isValid(msg.id)
            ? [msg.id]
            : [],
        ),
      ),
    ].map((msgId) => new Types.ObjectId(msgId));

    const [storedAssistants, liveTriggers, liveJobs] = await Promise.all([
      assistantIds.length > 0
        ? this.messages
            .find({
              ...scopeFilter,
              _id: { $in: assistantIds },
            })
            .select({ _id: 1, conversationId: 1, sourceReferences: 1 })
            .lean()
            .exec()
        : Promise.resolve<
            Pick<
              MessageDocument,
              '_id' | 'conversationId' | 'sourceReferences'
            >[]
          >([]),
      activeTriggerIds.length > 0
        ? this.messages
            .find({
              ...scopeFilter,
              _id: { $in: activeTriggerIds },
            })
            .select({ _id: 1, deletedAt: 1 })
            .lean()
            .exec()
        : Promise.resolve<Pick<MessageDocument, '_id' | 'deletedAt'>[]>([]),
      activeTriggerIds.length > 0
        ? this.assistantJobs
            .find({
              ...scopeFilter,
              triggerMessageId: { $in: activeTriggerIds },
            })
            .lean()
            .exec()
        : Promise.resolve<AssistantJobDocument[]>([]),
    ]);

    const storedAssistantById = new Map(
      storedAssistants.map((doc) => [String(doc._id), doc]),
    );
    const liveTriggerById = new Map(
      liveTriggers.map((doc) => [String(doc._id), doc]),
    );
    const liveJobByTriggerId = new Map(
      liveJobs.map((job) => [String(job.triggerMessageId), job]),
    );

    const sourceIds = [
      ...new Set(
        storedAssistants.flatMap((doc) =>
          Array.isArray(doc.sourceReferences)
            ? doc.sourceReferences.map((ref) => String(ref.messageId))
            : [],
        ),
      ),
    ]
      .filter((srcId) => Types.ObjectId.isValid(srcId))
      .map((srcId) => new Types.ObjectId(srcId));

    const liveSources =
      sourceIds.length > 0
        ? await this.messages
            .find({
              ...scopeFilter,
              _id: { $in: sourceIds },
            })
            .select({
              _id: 1,
              conversationId: 1,
              deletedAt: 1,
              editedAt: 1,
              contentVersion: 1,
            })
            .lean()
            .exec()
        : [];

    const liveSourcesByConversation = new Map<
      string,
      Map<string, LiveSourceProjection>
    >();
    for (const source of liveSources) {
      const convKey = String(source.conversationId);
      let convMap = liveSourcesByConversation.get(convKey);
      if (!convMap) {
        convMap = new Map<string, LiveSourceProjection>();
        liveSourcesByConversation.set(convKey, convMap);
      }
      convMap.set(String(source._id), source);
    }

    return messages.map((msg) => {
      const isAssistantWithRefs =
        (msg.authorType === 'ASSISTANT' ||
          msg.senderId === CONTINUUM_AI_SENDER_ID) &&
        Array.isArray(msg.sourceReferences) &&
        msg.sourceReferences.length > 0;

      if (isAssistantWithRefs) {
        const stored = storedAssistantById.get(msg.id);
        const freshRefs: ChatAssistantSourceReference[] = stored
          ? enrichSourceReferences(
              stored.sourceReferences ?? [],
              liveSourcesByConversation.get(String(stored.conversationId)) ??
                new Map<string, LiveSourceProjection>(),
            )
          : msg.sourceReferences!.map((ref) => ({
              ...ref,
              status: 'DELETED' as const,
              quoteSnippet: '',
            }));
        const sourceState = computeSourceAggregateState(freshRefs);
        return {
          ...msg,
          sourceReferences: freshRefs,
          assistantMeta: msg.assistantMeta
            ? {
                ...msg.assistantMeta,
                sourceState,
              }
            : {
                handle: CONTINUUM_AI_HANDLE,
                queryMode: 'KEYWORD',
                partialCoverage: false,
                coverageNote: null,
                sourceState,
              },
        };
      }

      if (
        msg.assistantState?.status === 'PENDING' ||
        msg.assistantState?.status === 'PROCESSING'
      ) {
        const liveTrigger = liveTriggerById.get(msg.id);
        if (!liveTrigger || liveTrigger.deletedAt != null) {
          return {
            ...msg,
            content: liveTrigger?.deletedAt ? '' : msg.content,
            deletedAt: liveTrigger?.deletedAt
              ? liveTrigger.deletedAt.toISOString()
              : msg.deletedAt,
            assistantState: null,
          };
        }
        const liveJob = liveJobByTriggerId.get(msg.id);
        return {
          ...msg,
          assistantState: liveJob ? toAssistantJobState(liveJob) : null,
        };
      }

      return msg;
    });
  }

  private async upsertMember(
    conversationId: Types.ObjectId,
    organizationId: Types.ObjectId,
    person: ChatActor | ChatCandidate,
    role: 'OWNER' | 'MEMBER',
    searchLabel: string,
  ): Promise<void> {
    await this.members
      .updateOne(
        { organizationId, conversationId, userId: person.id },
        {
          $setOnInsert: {
            searchLabel,
            organizationId,
            conversationId,
            userId: person.id,
            displayName: 'name' in person ? person.name : person.fullName,
            avatarUrl: person.avatarUrl,
            role,
            status: ACTIVE,
            joinedAt: new Date(),
          },
        },
        { upsert: true },
      )
      .exec();
  }

  protected async mapMessages(
    actor: ChatActor,
    messages: MessageDocument[],
  ): Promise<ChatMessage[]> {
    const [first] = messages;
    if (!first) return [];
    const organizationId = new Types.ObjectId(actor.organizationId);
    const conversationId = first.conversationId;
    const replyIds = [
      ...new Set(
        messages.flatMap((message) =>
          message.replyToMessageId ? [String(message.replyToMessageId)] : [],
        ),
      ),
    ];
    const sourceRefIds = [
      ...new Set(
        messages.flatMap((message) =>
          (message.authorType === 'ASSISTANT' ||
            message.senderId === CONTINUUM_AI_SENDER_ID) &&
          Array.isArray(message.sourceReferences)
            ? message.sourceReferences.map((ref) => String(ref.messageId))
            : [],
        ),
      ),
    ];
    const triggerIds = [
      ...new Set(
        messages.flatMap((message) =>
          message.authorType !== 'ASSISTANT' &&
          message.senderId !== CONTINUUM_AI_SENDER_ID &&
          !message.deletedAt &&
          message.assistantMention != null
            ? [String(message._id)]
            : [],
        ),
      ),
    ];

    const [targets, liveSources, jobs] = await Promise.all([
      replyIds.length
        ? this.messages
            .find({
              _id: { $in: replyIds.map((id) => new Types.ObjectId(id)) },
              organizationId,
              conversationId,
            })
            .lean()
            .exec()
        : Promise.resolve<MessageDocument[]>([]),
      sourceRefIds.length
        ? this.messages
            .find({
              _id: { $in: sourceRefIds.map((id) => new Types.ObjectId(id)) },
              organizationId,
              conversationId,
            })
            .select({ _id: 1, deletedAt: 1, editedAt: 1, contentVersion: 1 })
            .lean()
            .exec()
        : Promise.resolve<LiveSourceProjection[]>([]),
      triggerIds.length
        ? this.assistantJobs
            .find({
              organizationId,
              conversationId,
              triggerMessageId: {
                $in: triggerIds.map((id) => new Types.ObjectId(id)),
              },
            })
            .lean()
            .exec()
        : Promise.resolve<AssistantJobDocument[]>([]),
    ]);

    const targetById = new Map(
      targets.map((target) => [String(target._id), target]),
    );
    const liveSourceById = new Map<string, LiveSourceProjection>(
      liveSources.map((source) => [String(source._id), source]),
    );
    const jobByTriggerId = new Map<string, AssistantJobDocument>(
      jobs.map((job) => [String(job.triggerMessageId), job]),
    );

    return messages.map((message) =>
      toMessage(
        message,
        actor.id,
        message.replyToMessageId
          ? targetById.get(String(message.replyToMessageId))
          : undefined,
        liveSourceById,
        jobByTriggerId,
      ),
    );
  }

  private async mapMessage(
    actor: ChatActor,
    message: MessageDocument,
  ): Promise<ChatMessage> {
    const [mapped] = await this.mapMessages(actor, [message]);
    if (!mapped) throw new Error('Message could not be mapped');
    return mapped;
  }

  protected async requireMember(
    actor: ChatActor,
    conversationId: Types.ObjectId,
  ): Promise<void> {
    const member = await this.members.exists({
      organizationId: new Types.ObjectId(actor.organizationId),
      conversationId,
      userId: actor.id,
      status: ACTIVE,
    });
    if (!member) throw this.conversationNotFound();
  }

  private async requireRoomOwner(
    actor: ChatActor,
    conversationId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<void> {
    const organizationId = new Types.ObjectId(actor.organizationId);
    const conversationQuery = this.conversations.exists({
      _id: conversationId,
      organizationId,
      type: 'ROOM',
      status: ACTIVE,
    });
    const ownerQuery = this.members.exists({
      organizationId,
      conversationId,
      userId: actor.id,
      role: { $in: ['OWNER', 'MANAGER'] },
      status: ACTIVE,
    });
    const conversation = session
      ? await conversationQuery.session(session)
      : await conversationQuery;
    const owner = session
      ? await ownerQuery.session(session)
      : await ownerQuery;
    if (!conversation || !owner) throw this.conversationNotFound();
  }

  private toConversation(row: ConversationAggregate): ChatConversation {
    return {
      id: String(row.conversation._id),
      type: row.conversation.type,
      title: row.conversation.title ?? null,
      createdBy: row.conversation.createdBy,
      lastMessageAt: row.conversation.lastMessageAt?.toISOString() ?? null,
      lastMessagePreview: row.conversation.lastMessagePreview,
      lastMessageSenderId: row.conversation.lastMessageSenderId,
      lastReadMessageId: row.lastReadMessageId
        ? String(row.lastReadMessageId)
        : null,
      lastReadAt: row.lastReadAt?.toISOString() ?? null,
      unreadCount: row.unread[0]?.count ?? 0,
      members: row.participants.map(toParticipant),
      isPinned: row.isPinned ?? false,
      isArchived: row.isArchived ?? false,
      notificationMode: row.notificationMode ?? 'ALL',
      markedUnread: row.markedUnread ?? false,
    };
  }

  private conversationNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'CHAT_CONVERSATION_NOT_FOUND',
      message: 'Conversation not found.',
    });
  }

  private assistantMessageImmutable(): ForbiddenException {
    return new ForbiddenException({
      code: 'CHAT_ASSISTANT_MESSAGE_IMMUTABLE',
      message: 'Assistant messages cannot be edited or deleted.',
    });
  }
}
