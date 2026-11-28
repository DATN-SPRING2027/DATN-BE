import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CHAT_REPOSITORY,
  type ChatActor,
  type ChatCursor,
  type ChatRepository,
} from './chat.repository';
import { ChatIamClient, type ChatCredentials } from './chat-iam.client';
import { ChatHistoryCacheInvalidator } from './chat-history-cache';
import { ChatRealtimeService } from './chat-realtime.service';
import type { ChatSearchFilters } from './chat-features';
import {
  CHAT_ORG_MEMBERSHIP_CHECKER,
  isDmAssistantAvailable,
  type ChatOrgMembershipChecker,
} from './chat-dm-assistant.types';
import { RedisService } from '../infrastructure/redis/redis.service';

const oid = /^[a-f\d]{24}$/i;
const uuid =
  /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
function invalid(): never {
  throw new UnprocessableEntityException({
    code: 'CHAT_VALIDATION_FAILED',
    message: 'Chat request is invalid.',
  });
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
function validId(value: string) {
  if (!oid.test(value)) invalid();
  return value;
}
function page(query: Record<string, unknown>) {
  const limit =
    query.limit === undefined
      ? 30
      : typeof query.limit === 'string' && /^[1-9]\d*$/.test(query.limit)
        ? Number(query.limit)
        : invalid();
  if (limit > 100) invalid();
  let before: ChatCursor | undefined;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string' || query.cursor.length > 256)
      return invalid();
    try {
      const decoded: unknown = JSON.parse(
        Buffer.from(query.cursor, 'base64url').toString('utf8'),
      );
      const cursor = object(decoded, ['createdAt', 'id']);
      if (
        typeof cursor.id !== 'string' ||
        !oid.test(cursor.id) ||
        typeof cursor.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(cursor.createdAt))
      )
        return invalid();
      before = { createdAt: new Date(cursor.createdAt), id: cursor.id };
    } catch {
      return invalid();
    }
  }
  return { limit, before };
}
const cursor = (value: ChatCursor | null) =>
  value
    ? Buffer.from(
        JSON.stringify({
          id: value.id,
          createdAt: value.createdAt.toISOString(),
        }),
      ).toString('base64url')
    : null;

@Injectable()
export class ChatFeaturesService {
  private readonly redisPrefix: string;
  private readonly config?: ConfigService;

  constructor(
    @Inject(CHAT_REPOSITORY) private readonly repository: ChatRepository,
    private readonly iam: ChatIamClient,
    private readonly realtime: ChatRealtimeService,
    @Optional()
    private readonly historyCache?: ChatHistoryCacheInvalidator,
    @Optional()
    private readonly redis?: RedisService,
    @Optional()
    config?: ConfigService,
    @Optional()
    @Inject(CHAT_ORG_MEMBERSHIP_CHECKER)
    private readonly orgMembershipChecker?: ChatOrgMembershipChecker,
  ) {
    this.config = config;
    this.redisPrefix = `${config?.get<string>('BULLMQ_PREFIX') ?? 'continuum'}:chat`;
  }

  private async requireActionRateLimit(
    actor: ChatActor,
    action: string,
    limit: number,
  ): Promise<void> {
    if (!this.redis) return;
    const allowed = await this.redis.consumeRateLimit(
      `${this.redisPrefix}:feature:${action}:${actor.organizationId}:${actor.id}`,
      limit,
      60,
    );
    if (!allowed) {
      throw new HttpException(
        {
          code: 'CHAT_RATE_LIMITED',
          message: 'Too many chat requests. Try again shortly.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async conversation(credentials: ChatCredentials, conversationId: string) {
    validId(conversationId);
    const result = await this.repository.getConversation(
      await this.iam.getActor(credentials),
      conversationId,
    );
    if (!result) throw new NotFoundException('Conversation not found');
    return {
      ...result,
      capabilities: {
        dmAssistantEnabled:
          isDmAssistantAvailable(this.config) && result.type === 'DIRECT',
      },
    };
  }
  async preferences(
    credentials: ChatCredentials,
    conversationId: string,
    body?: unknown,
  ) {
    validId(conversationId);
    const actor = await this.iam.getActor(credentials);
    if (body === undefined)
      return this.repository.getPreferences(actor, conversationId);
    const changes = object(body, [
      'isPinned',
      'isArchived',
      'notificationMode',
      'markedUnread',
    ]);
    if (!Object.keys(changes).length) return invalid();
    for (const [key, value] of Object.entries(changes)) {
      if (
        key === 'notificationMode'
          ? !['ALL', 'MENTIONS', 'NONE'].includes(String(value))
          : typeof value !== 'boolean'
      )
        return invalid();
    }
    const result = await this.repository.setPreferences(
      actor,
      conversationId,
      changes,
    );
    await this.realtime.publishConversationEvent(
      'conversation.updated',
      actor.organizationId,
      conversationId,
      [actor.id],
      { id: conversationId },
    );
    return result;
  }
  async draft(
    credentials: ChatCredentials,
    conversationId: string,
    body?: unknown,
  ) {
    validId(conversationId);
    const actor = await this.iam.getActor(credentials);
    if (body === undefined)
      return this.repository.getDraft(actor, conversationId);
    const data = object(body, [
      'content',
      'mentionUserIds',
      'assistantMention',
    ]);
    if (typeof data.content !== 'string' || data.content.length > 8000)
      return invalid();
    if (
      data.assistantMention !== undefined &&
      typeof data.assistantMention !== 'boolean'
    )
      return invalid();
    const mentions: unknown = data.mentionUserIds ?? [];
    if (
      !Array.isArray(mentions) ||
      mentions.length > 50 ||
      !mentions.every(
        (entry): entry is string =>
          typeof entry === 'string' && oid.test(entry),
      ) ||
      new Set(mentions).size !== mentions.length
    )
      return invalid();
    if (mentions.length) {
      if (!(await this.repository.isMember(actor, conversationId)))
        throw new NotFoundException('Conversation not found');
      const members = await this.repository.memberIds(actor, conversationId);
      if (mentions.some((entry) => !members.includes(entry))) return invalid();
    }
    return this.repository.saveDraft(
      actor,
      conversationId,
      data.content,
      mentions,
      data.assistantMention === true,
    );
  }
  async ownership(
    credentials: ChatCredentials,
    conversationId: string,
    body: unknown,
  ) {
    validId(conversationId);
    const data = object(body, ['userId']);
    if (typeof data.userId !== 'string') return invalid();
    validId(data.userId);
    const actor = await this.iam.getActor(credentials);
    await this.repository.transferOwnership(actor, conversationId, data.userId);
    await this.realtime.publishConversationEvent(
      'conversation.updated',
      actor.organizationId,
      conversationId,
      await this.repository.memberIds(actor, conversationId),
      { id: conversationId },
    );
    return { id: conversationId };
  }
  async manager(
    credentials: ChatCredentials,
    conversationId: string,
    userId: string,
    body: unknown,
  ) {
    validId(conversationId);
    validId(userId);
    const data = object(body, ['active']);
    if (typeof data.active !== 'boolean') return invalid();
    const actor = await this.iam.getActor(credentials);
    await this.repository.setManager(
      actor,
      conversationId,
      userId,
      data.active,
    );
    await this.realtime.publishConversationEvent(
      'conversation.updated',
      actor.organizationId,
      conversationId,
      await this.repository.memberIds(actor, conversationId),
      { id: conversationId },
    );
    return { id: conversationId };
  }
  async search(credentials: ChatCredentials, query: Record<string, unknown>) {
    object(query, [
      'q',
      'conversationId',
      'senderId',
      'from',
      'to',
      'kind',
      'cursor',
      'limit',
    ]);
    if (
      typeof query.q !== 'string' ||
      query.q.trim().length < 2 ||
      query.q.length > 80
    )
      return invalid();
    const filters: ChatSearchFilters = { q: query.q.trim() };
    for (const key of ['conversationId', 'senderId'] as const)
      if (query[key] !== undefined) {
        if (typeof query[key] !== 'string') return invalid();
        filters[key] = validId(query[key]);
      }
    for (const key of ['from', 'to'] as const)
      if (query[key] !== undefined) {
        if (
          typeof query[key] !== 'string' ||
          !Number.isFinite(Date.parse(query[key]))
        )
          return invalid();
        filters[key] = new Date(query[key]);
      }
    if (filters.from && filters.to && filters.from > filters.to)
      return invalid();
    if (query.kind !== undefined) {
      if (
        typeof query.kind !== 'string' ||
        !['IMAGE', 'DOCUMENT', 'LINK'].includes(query.kind)
      )
        return invalid();
      filters.kind = query.kind as ChatSearchFilters['kind'];
    }
    const actor = await this.iam.getActor(credentials);
    const { limit, before } = page(query);
    const result = await this.repository.searchAcross(
      actor,
      filters,
      limit,
      before,
    );
    return { data: result.data, nextCursor: cursor(result.nextCursor) };
  }
  async library(
    credentials: ChatCredentials,
    conversationId: string,
    query: Record<string, unknown>,
  ) {
    validId(conversationId);
    object(query, ['kind', 'cursor', 'limit']);
    if (
      typeof query.kind !== 'string' ||
      !['IMAGE', 'DOCUMENT', 'LINK', 'PIN'].includes(query.kind)
    )
      return invalid();
    const actor = await this.iam.getActor(credentials);
    const { limit, before } = page(query);
    const result = await this.repository.library(
      actor,
      conversationId,
      query.kind as 'IMAGE' | 'DOCUMENT' | 'LINK' | 'PIN',
      limit,
      before,
    );
    return { data: result.data, nextCursor: cursor(result.nextCursor) };
  }
  async pin(
    credentials: ChatCredentials,
    conversationId: string,
    messageId: string,
    body: unknown,
  ) {
    validId(conversationId);
    validId(messageId);
    const data = object(body, ['active']);
    if (typeof data.active !== 'boolean') return invalid();
    const actor = await this.iam.getActor(credentials);
    await this.requireActionRateLimit(actor, 'pin', 60);
    await this.repository.pinMessage(
      actor,
      conversationId,
      messageId,
      data.active,
    );
    await this.historyCache?.invalidate(actor.organizationId, conversationId);
    await this.realtime.publishConversationEvent(
      'conversation.updated',
      actor.organizationId,
      conversationId,
      await this.repository.memberIds(actor, conversationId),
      { id: conversationId },
    );
    return { id: messageId };
  }
  async forward(
    credentials: ChatCredentials,
    conversationId: string,
    body: unknown,
  ) {
    validId(conversationId);
    const data = object(body, [
      'sourceConversationId',
      'messageId',
      'clientMessageId',
    ]);
    if (
      typeof data.sourceConversationId !== 'string' ||
      typeof data.messageId !== 'string' ||
      typeof data.clientMessageId !== 'string' ||
      !uuid.test(data.clientMessageId)
    )
      return invalid();
    validId(data.sourceConversationId);
    validId(data.messageId);
    const actor = await this.iam.getActor(credentials);
    await this.requireActionRateLimit(actor, 'forward', 60);
    const result = await this.repository.forwardMessage(
      actor,
      conversationId,
      data.sourceConversationId,
      data.messageId,
      data.clientMessageId,
    );
    await this.historyCache?.invalidate(actor.organizationId, conversationId);
    const candidateRecipients = await this.repository.memberIds(
      actor,
      conversationId,
    );
    const authorizedRecipients = await this.filterAuthorizedRecipients(
      actor.organizationId,
      candidateRecipients,
    );
    if (authorizedRecipients.length > 0) {
      await this.realtime.publishConversationEvent(
        'message.created',
        actor.organizationId,
        conversationId,
        authorizedRecipients,
        result,
      );
    }
    return result;
  }

  private async filterAuthorizedRecipients(
    organizationId: string,
    candidateUserIds: readonly string[],
  ): Promise<string[]> {
    const uniqueIds = [...new Set(candidateUserIds)].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    if (!this.orgMembershipChecker || uniqueIds.length === 0) {
      return uniqueIds;
    }
    const authorized: string[] = [];
    for (const userId of uniqueIds) {
      try {
        const active =
          await this.orgMembershipChecker.isActiveOrganizationMember(
            organizationId,
            userId,
          );
        if (active) {
          authorized.push(userId);
        }
      } catch {
        // Fail-closed: never emit forwarded message to unverified IAM recipients.
      }
    }
    return authorized;
  }
  async receipts(
    credentials: ChatCredentials,
    conversationId: string,
    messageId: string,
  ) {
    validId(conversationId);
    validId(messageId);
    return this.repository.receipts(
      await this.iam.getActor(credentials),
      conversationId,
      messageId,
    );
  }
  async notifications(
    credentials: ChatCredentials,
    query: Record<string, unknown>,
  ) {
    object(query, ['cursor', 'limit']);
    const { limit, before } = page(query);
    const result = await this.repository.notifications(
      await this.iam.getActor(credentials),
      limit,
      before,
    );
    return { data: result.data, nextCursor: cursor(result.nextCursor) };
  }
  async readNotification(credentials: ChatCredentials, notificationId: string) {
    validId(notificationId);
    await this.repository.readNotification(
      await this.iam.getActor(credentials),
      notificationId,
    );
    return { id: notificationId };
  }
  async block(credentials: ChatCredentials, userId: string, body: unknown) {
    validId(userId);
    const data = object(body, ['active']);
    if (typeof data.active !== 'boolean') return invalid();
    const actor = await this.iam.getActor(credentials);
    await this.requireActionRateLimit(actor, 'block', 30);
    if (actor.id === userId) {
      throw new NotFoundException('Contact is unavailable');
    }
    const { data: candidates } = await this.iam.getCandidates(credentials, [
      userId,
    ]);
    if (!candidates.some((candidate) => candidate.id === userId))
      throw new NotFoundException('Contact is unavailable');
    await this.repository.setBlock(actor, userId, data.active);
    if (
      data.active &&
      typeof this.realtime.evictBlockedPresence === 'function'
    ) {
      await this.realtime.evictBlockedPresence(
        actor.organizationId,
        actor.id,
        userId,
      );
    }
    return { userId, active: data.active };
  }
  async report(credentials: ChatCredentials, body: unknown) {
    const data = object(body, ['conversationId', 'messageId', 'reason']);
    if (
      typeof data.conversationId !== 'string' ||
      typeof data.reason !== 'string' ||
      data.reason.trim().length < 1 ||
      data.reason.length > 1000
    )
      return invalid();
    validId(data.conversationId);
    if (data.messageId !== undefined && typeof data.messageId !== 'string')
      return invalid();
    if (typeof data.messageId === 'string') validId(data.messageId);
    const actor = await this.iam.getActor(credentials);
    await this.requireActionRateLimit(actor, 'report', 20);
    return {
      id: await this.repository.report(
        actor,
        data.conversationId,
        data.messageId,
        data.reason.trim(),
      ),
      status: 'OPEN',
    };
  }
}
