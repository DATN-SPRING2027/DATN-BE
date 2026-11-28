import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { ChatIamClient, type ChatCredentials } from './chat-iam.client';
import { RedisService } from '../infrastructure/redis/redis.service';
import type { ChatActor } from './chat.repository';
import {
  notificationRealtimeChannel,
  NotificationRealtimeBus,
} from '../../notification/notification-realtime.bus';

const presenceLeaseMs = 75_000;
const heartbeatMs = 20_000;
const defaultSessionValidationMs = 20_000;
const defaultMaxSocketsPerUser = 10;
const defaultMaxSocketsGlobal = 10_000;
const typingThrottleMs = 400;

export type ChatWsRateLimitAction =
  'subscribe' | 'unsubscribe' | 'presence.watch' | 'typing' | 'heartbeat';

interface TokenBucketConfig {
  capacity: number;
  refillPerSecond: number;
}

const WS_BUCKET_CONFIG: Record<ChatWsRateLimitAction, TokenBucketConfig> = {
  subscribe: { capacity: 20, refillPerSecond: 5 },
  unsubscribe: { capacity: 20, refillPerSecond: 5 },
  'presence.watch': { capacity: 5, refillPerSecond: 0.5 },
  typing: { capacity: 10, refillPerSecond: 2.5 },
  heartbeat: { capacity: 10, refillPerSecond: 1 },
};

interface TokenBucketState {
  tokens: number;
  lastRefillAt: number;
}

interface SocketSession {
  id: string;
  actor: ChatActor;
  credentials: ChatCredentials;
  tokenHash: string;
  expiresAt: number;
  nextValidationAt: number;
  alive: boolean;
  lastTypingStartAt: number;
  lastTypingStopAt: number;
  buckets: Map<ChatWsRateLimitAction, TokenBucketState>;
  conversations: Set<string>;
  watchedUsers: Set<string>;
}

interface ConversationEvent {
  type: 'conversation';
  event: string;
  organizationId: string;
  conversationId: string;
  recipientIds: string[];
  data: unknown;
}

interface PresenceEvent {
  type: 'presence';
  userId: string;
  organizationId: string;
  isOnline: boolean;
}

interface PresenceEvictEvent {
  type: 'presence.evict';
  organizationId: string;
  blockerId: string;
  blockedUserId: string;
}

interface ConversationEvictEvent {
  type: 'conversation.evict';
  organizationId: string;
  conversationId: string;
  userIds: string[];
}

interface SessionRevokeEvent {
  type: 'session.revoke';
  organizationId?: string;
  userId?: string;
  tokenHash?: string;
}

interface NotificationSocketEvent {
  type: 'notification';
  event: 'notification.created' | 'notification.read' | 'notification.read_all';
  organizationId: string | null;
  recipientIds: string[];
  data: unknown;
}

type ChatRealtimeEvent =
  | ConversationEvent
  | PresenceEvent
  | PresenceEvictEvent
  | ConversationEvictEvent
  | SessionRevokeEvent
  | NotificationSocketEvent;

interface SessionValidation {
  checkedAt: number;
  valid: boolean;
  pending?: Promise<boolean>;
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num >= 1 ? Math.floor(num) : fallback;
}

@Injectable()
export class ChatRealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatRealtimeService.name);
  private readonly redisPrefix: string;
  private readonly eventChannel: string;
  private readonly notificationChannel: string;
  private readonly iamRevocationChannel: string;
  private readonly maxSocketsPerUser: number;
  private readonly maxSocketsGlobal: number;
  private readonly sessionValidationMs: number;
  private readonly sessions = new Map<WebSocket, SocketSession>();
  private readonly userSockets = new Map<string, Set<WebSocket>>();
  private readonly conversationSockets = new Map<string, Set<WebSocket>>();
  private readonly presenceWatchers = new Map<string, Set<WebSocket>>();
  private readonly presenceStates = new Map<string, boolean>();
  private readonly sessionValidations = new Map<string, SessionValidation>();
  private stopSubscriber?: () => void;
  private stopNotificationSubscriber?: () => void;
  private stopIamRevocationSubscriber?: () => void;
  private stopNotificationBus?: () => void;
  private heartbeatTimer?: NodeJS.Timeout;
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private destroyed = false;

  constructor(
    private readonly redis: RedisService,
    private readonly iam: ChatIamClient,
    private readonly config: ConfigService,
    @Optional()
    private readonly notificationBus?: NotificationRealtimeBus,
  ) {
    const bullmqPrefix = config.get<string>('BULLMQ_PREFIX') ?? 'continuum';
    this.redisPrefix = `${bullmqPrefix}:chat`;
    this.eventChannel = `${this.redisPrefix}:events:v1`;
    this.notificationChannel = notificationRealtimeChannel(bullmqPrefix);
    this.iamRevocationChannel = `${bullmqPrefix}:iam:session-revoked:v1`;
    this.maxSocketsPerUser = parsePositiveInt(
      config.get<string | number>('CHAT_WS_MAX_SOCKETS_PER_USER'),
      defaultMaxSocketsPerUser,
    );
    this.maxSocketsGlobal = parsePositiveInt(
      config.get<string | number>('CHAT_WS_MAX_SOCKETS_GLOBAL'),
      defaultMaxSocketsGlobal,
    );
    this.sessionValidationMs = parsePositiveInt(
      config.get<string | number>('CHAT_WS_SESSION_VALIDATION_MS'),
      defaultSessionValidationMs,
    );
  }

  async onModuleInit(): Promise<void> {
    this.destroyed = false;
    const useRedis = this.config.get<string>('INFRA_ENABLED') === 'true';
    if (!useRedis) {
      const bus = this.notificationBus ?? new NotificationRealtimeBus();
      this.stopNotificationBus = bus.onRealtimeEvent((payload) => {
        const event: NotificationSocketEvent = {
          type: 'notification',
          event: payload.event,
          organizationId: payload.organizationId,
          recipientIds: [...payload.recipientIds],
          data: payload.data,
        };
        if (!this.stopSubscriber) this.deliverNotificationEvent(event);
        void this.publish(event);
      });
    } else {
      await Promise.all([
        this.subscribeWithRetry('event', this.eventChannel, (value) => {
          this.receive(value);
        }),
        this.subscribeWithRetry(
          'notification',
          this.notificationChannel,
          (value) => {
            this.receiveNotification(value);
          },
        ),
        this.subscribeWithRetry(
          'iam-revocation',
          this.iamRevocationChannel,
          (value) => {
            this.receiveIamRevocation(value);
          },
        ),
      ]);
    }
    this.scheduleHeartbeat();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.stopSubscriber?.();
    this.stopSubscriber = undefined;
    this.stopNotificationSubscriber?.();
    this.stopNotificationSubscriber = undefined;
    this.stopIamRevocationSubscriber?.();
    this.stopIamRevocationSubscriber = undefined;
    this.stopNotificationBus?.();
    this.stopNotificationBus = undefined;
  }

  async register(
    socket: WebSocket,
    actor: ChatActor,
    credentials: ChatCredentials,
    tokenHash: string,
    expiresAt: number,
  ): Promise<boolean> {
    if (Date.now() >= expiresAt) {
      socket.close(1008, 'Session expired');
      return false;
    }
    if (this.sessions.size >= this.maxSocketsGlobal) {
      this.logger.warn(
        `Rejecting Chat WS connection: global cap (${this.maxSocketsGlobal}) reached`,
      );
      socket.close(1013, 'Realtime connection limit reached');
      return false;
    }
    const key = this.userKey(actor.organizationId, actor.id);
    const existingSockets = this.userSockets.get(key);
    if (existingSockets && existingSockets.size >= this.maxSocketsPerUser) {
      this.logger.warn(
        `Rejecting Chat WS connection: user ${actor.id} exceeded max sockets (${this.maxSocketsPerUser})`,
      );
      socket.close(1008, 'Too many concurrent realtime connections');
      return false;
    }

    const now = Date.now();
    const initialJitter = Math.floor(Math.random() * this.sessionValidationMs);
    const session: SocketSession = {
      id: randomUUID(),
      actor,
      credentials,
      tokenHash,
      expiresAt,
      nextValidationAt: now + initialJitter,
      alive: true,
      lastTypingStartAt: 0,
      lastTypingStopAt: 0,
      buckets: new Map(),
      conversations: new Set(),
      watchedUsers: new Set(),
    };
    this.sessions.set(socket, session);
    const userSockets = existingSockets ?? new Set<WebSocket>();
    userSockets.add(socket);
    this.userSockets.set(key, userSockets);
    socket.on('pong', () => {
      session.alive = true;
      void this.renew(session);
    });
    socket.on('close', () => void this.unregister(socket));
    socket.on('error', () => void this.unregister(socket));
    const isFirstSession = await this.redis.touchPresenceSession(
      this.presenceKey(actor.organizationId, actor.id),
      session.id,
      presenceLeaseMs,
    );
    if (isFirstSession) {
      await this.publish({
        type: 'presence',
        userId: actor.id,
        organizationId: actor.organizationId,
        isOnline: true,
      });
    }
    return true;
  }

  getActor(socket: WebSocket): ChatActor | undefined {
    const session = this.sessions.get(socket);
    if (!session) return undefined;
    if (Date.now() >= session.expiresAt) {
      socket.close(1008, 'Session expired');
      void this.unregister(socket);
      return undefined;
    }
    return session.actor;
  }

  consumeSocketRateLimit(
    socket: WebSocket,
    action: ChatWsRateLimitAction,
  ): boolean {
    const session = this.sessions.get(socket);
    if (!session) return false;
    const config = WS_BUCKET_CONFIG[action];
    const now = Date.now();
    let bucket = session.buckets.get(action);
    if (!bucket) {
      bucket = { tokens: config.capacity, lastRefillAt: now };
      session.buckets.set(action, bucket);
    } else {
      const elapsedSeconds = Math.max(0, (now - bucket.lastRefillAt) / 1000);
      bucket.tokens = Math.min(
        config.capacity,
        bucket.tokens + elapsedSeconds * config.refillPerSecond,
      );
      bucket.lastRefillAt = now;
    }
    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  async unregister(socket: WebSocket): Promise<void> {
    const session = this.sessions.get(socket);
    if (!session || !this.sessions.delete(socket)) return;
    for (const conversationId of session.conversations) {
      this.removeFromSet(this.conversationSockets, conversationId, socket);
    }
    this.removeFromSet(
      this.userSockets,
      this.userKey(session.actor.organizationId, session.actor.id),
      socket,
    );
    for (const userId of session.watchedUsers) {
      this.removeFromSet(this.presenceWatchers, userId, socket);
      if (!this.presenceWatchers.has(userId))
        this.presenceStates.delete(userId);
    }
    if (
      ![...this.sessions.values()].some(
        (active) => active.tokenHash === session.tokenHash,
      )
    ) {
      this.sessionValidations.delete(session.tokenHash);
    }
    let isLastSession = false;
    try {
      isLastSession = await this.redis.removePresenceSession(
        this.presenceKey(session.actor.organizationId, session.actor.id),
        session.id,
      );
    } catch {
      return;
    }
    if (isLastSession) {
      await this.publish({
        type: 'presence',
        userId: session.actor.id,
        organizationId: session.actor.organizationId,
        isOnline: false,
      });
    }
  }

  subscribeConversation(socket: WebSocket, conversationId: string): void {
    const session = this.sessions.get(socket);
    if (!session) return;
    session.conversations.add(conversationId);
    const sockets = this.conversationSockets.get(conversationId) ?? new Set();
    sockets.add(socket);
    this.conversationSockets.set(conversationId, sockets);
  }

  unsubscribeConversation(socket: WebSocket, conversationId: string): void {
    const session = this.sessions.get(socket);
    session?.conversations.delete(conversationId);
    this.removeFromSet(this.conversationSockets, conversationId, socket);
  }

  async evictBlockedPresence(
    organizationId: string,
    blockerId: string,
    blockedUserId: string,
  ): Promise<void> {
    const event: PresenceEvictEvent = {
      type: 'presence.evict',
      organizationId,
      blockerId,
      blockedUserId,
    };
    this.applyPresenceEviction(event);
    await this.publish(event);
  }

  async evictConversationMembers(
    organizationId: string,
    conversationId: string,
    userIds: string[],
  ): Promise<void> {
    if (userIds.length === 0) return;
    const event: ConversationEvictEvent = {
      type: 'conversation.evict',
      organizationId,
      conversationId,
      userIds,
    };
    this.applyConversationEviction(event);
    await this.publish(event);
  }

  async revokeSessions(input: {
    organizationId?: string;
    userId?: string;
    tokenHash?: string;
  }): Promise<void> {
    const event: SessionRevokeEvent = {
      type: 'session.revoke',
      ...input,
    };
    this.applySessionRevocation(event);
    await this.publish(event);
  }

  async watchPresence(socket: WebSocket, userIds: string[]) {
    const session = this.sessions.get(socket);
    if (!session) return [];
    for (const oldId of session.watchedUsers) {
      this.removeFromSet(this.presenceWatchers, oldId, socket);
      if (!this.presenceWatchers.has(oldId)) this.presenceStates.delete(oldId);
    }
    session.watchedUsers.clear();
    for (const userId of userIds) {
      const watcherKey = this.presenceWatcherKey(
        session.actor.organizationId,
        userId,
      );
      session.watchedUsers.add(watcherKey);
      const sockets = this.presenceWatchers.get(watcherKey) ?? new Set();
      sockets.add(socket);
      this.presenceWatchers.set(watcherKey, sockets);
    }
    const onlineByUser = await this.areOnlineBatch(
      session.actor.organizationId,
      userIds,
    );
    const data = userIds.map((userId) => ({
      userId,
      isOnline: onlineByUser.get(userId) ?? false,
    }));
    for (const presence of data) {
      this.presenceStates.set(
        this.presenceWatcherKey(session.actor.organizationId, presence.userId),
        presence.isOnline,
      );
    }
    this.send(socket, 'presence.snapshot', { data });
    return data;
  }

  async isOnline(organizationId: string, userId: string): Promise<boolean> {
    return this.redis.isPresenceOnline(
      this.presenceKey(organizationId, userId),
    );
  }

  async areOnlineBatch(
    organizationId: string,
    userIds: string[],
  ): Promise<Map<string, boolean>> {
    const unique = [...new Set(userIds)];
    const map = new Map<string, boolean>();
    if (unique.length === 0) return map;
    if (typeof this.redis.arePresenceOnlineBatch === 'function') {
      const keys = unique.map((userId) =>
        this.presenceKey(organizationId, userId),
      );
      const statuses = await this.redis.arePresenceOnlineBatch(keys);
      unique.forEach((userId, index) => {
        map.set(userId, statuses[index] ?? false);
      });
      return map;
    }
    const entries = await Promise.all(
      unique.map(
        async (userId) =>
          [userId, await this.isOnline(organizationId, userId)] as const,
      ),
    );
    for (const [userId, isOnline] of entries) {
      map.set(userId, isOnline);
    }
    return map;
  }

  async publishConversationEvent(
    event: string,
    organizationId: string,
    conversationId: string,
    recipientIds: string[],
    data: unknown,
  ): Promise<void> {
    await this.publish({
      type: 'conversation',
      event,
      organizationId,
      conversationId,
      recipientIds,
      data,
    });
  }

  async relayTyping(
    socket: WebSocket,
    conversationId: string,
    isTyping: boolean,
    memberIds: string[],
  ): Promise<void> {
    const session = this.sessions.get(socket);
    if (!session) return;
    const now = Date.now();
    if (now >= session.expiresAt) {
      socket.close(1008, 'Session expired');
      void this.unregister(socket);
      return;
    }
    if (isTyping) {
      if (now - session.lastTypingStartAt < typingThrottleMs) return;
      session.lastTypingStartAt = now;
    } else {
      if (now - session.lastTypingStopAt < typingThrottleMs) return;
      session.lastTypingStopAt = now;
    }
    await this.publishConversationEvent(
      'typing',
      session.actor.organizationId,
      conversationId,
      memberIds.filter((id) => id !== session.actor.id),
      {
        conversationId,
        userId: session.actor.id,
        displayName: session.actor.name,
        isTyping,
      },
    );
  }

  send(socket: WebSocket, event: string, data: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 262_144) {
      socket.close(1013, 'Slow client');
      return;
    }
    socket.send(JSON.stringify({ event, data }));
  }

  private scheduleHeartbeat(): void {
    if (this.destroyed) return;
    const jitter = Math.floor((Math.random() - 0.5) * heartbeatMs * 0.2);
    const delay = Math.max(5_000, heartbeatMs + jitter);
    this.heartbeatTimer = setTimeout(() => {
      void this.pingAndExpireSessions().finally(() => {
        this.scheduleHeartbeat();
      });
    }, delay);
    this.heartbeatTimer.unref();
  }

  private async subscribeWithRetry(
    slot: 'event' | 'notification' | 'iam-revocation',
    channel: string,
    handler: (value: string) => void,
    attempt = 0,
  ): Promise<void> {
    if (this.destroyed) return;
    try {
      const stop = await this.redis.subscribe(channel, handler, () => {
        if (this.destroyed) return;
        this.clearSubscriberSlot(slot);
        this.scheduleSubscribeRetry(slot, channel, handler, 0);
      });
      if (this.destroyed) {
        stop();
        return;
      }
      this.setSubscriberSlot(slot, stop);
      const existingTimer = this.retryTimers.get(slot);
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.retryTimers.delete(slot);
      }
    } catch (error) {
      this.logger.warn(
        `Chat Redis pub/sub subscribe failed for ${channel} (attempt ${attempt + 1}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.scheduleSubscribeRetry(slot, channel, handler, attempt + 1);
    }
  }

  private scheduleSubscribeRetry(
    slot: 'event' | 'notification' | 'iam-revocation',
    channel: string,
    handler: (value: string) => void,
    attempt: number,
  ): void {
    if (this.destroyed || this.retryTimers.has(slot)) return;
    const baseDelay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
    const jitter = Math.floor(Math.random() * 500);
    const timer = setTimeout(() => {
      this.retryTimers.delete(slot);
      void this.subscribeWithRetry(slot, channel, handler, attempt);
    }, baseDelay + jitter);
    timer.unref();
    this.retryTimers.set(slot, timer);
  }

  private setSubscriberSlot(
    slot: 'event' | 'notification' | 'iam-revocation',
    stop: () => void,
  ): void {
    if (slot === 'event') {
      this.stopSubscriber?.();
      this.stopSubscriber = stop;
    } else if (slot === 'notification') {
      this.stopNotificationSubscriber?.();
      this.stopNotificationSubscriber = stop;
    } else {
      this.stopIamRevocationSubscriber?.();
      this.stopIamRevocationSubscriber = stop;
    }
  }

  private clearSubscriberSlot(
    slot: 'event' | 'notification' | 'iam-revocation',
  ): void {
    if (slot === 'event') {
      this.stopSubscriber = undefined;
    } else if (slot === 'notification') {
      this.stopNotificationSubscriber = undefined;
    } else {
      this.stopIamRevocationSubscriber = undefined;
    }
  }

  private async pingAndExpireSessions(): Promise<void> {
    const now = Date.now();
    const entries = [...this.sessions.entries()];
    let revokedByHash = new Map<string, boolean>();
    let redisRevocationUnavailable = false;
    if (entries.length > 0) {
      const tokenHashes = entries.map(([, session]) => session.tokenHash);
      try {
        if (typeof this.redis.areTokensRevokedBatch === 'function') {
          revokedByHash = await this.redis.areTokensRevokedBatch(tokenHashes);
        } else {
          const unique = [...new Set(tokenHashes)];
          const checks = await Promise.all(
            unique.map(
              async (hash) =>
                [hash, await this.redis.isTokenRevoked(hash)] as const,
            ),
          );
          revokedByHash = new Map(checks);
        }
      } catch (error) {
        redisRevocationUnavailable = true;
        this.logger.warn(
          `Chat WS Redis revocation check failed; forcing IAM session revalidation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    await Promise.all(
      entries.map(async ([socket, session]) => {
        const revoked = revokedByHash.get(session.tokenHash) === true;
        const needsRevalidation =
          redisRevocationUnavailable || now >= session.nextValidationAt;
        if (
          now >= session.expiresAt ||
          revoked ||
          (needsRevalidation &&
            !(await this.isCurrentSession(
              session,
              now,
              redisRevocationUnavailable,
            )))
        ) {
          socket.close(1008, 'Session expired');
          void this.unregister(socket);
          return;
        }
        if (needsRevalidation) {
          const jitter = Math.floor(Math.random() * 5_000);
          session.nextValidationAt = now + this.sessionValidationMs + jitter;
        }
        if (!session.alive) {
          socket.terminate();
          return;
        }
        session.alive = false;
        socket.ping();
      }),
    );

    const activeTokens = new Set(
      [...this.sessions.values()].map((session) => session.tokenHash),
    );
    for (const tokenHash of this.sessionValidations.keys()) {
      if (!activeTokens.has(tokenHash))
        this.sessionValidations.delete(tokenHash);
    }
    await this.refreshWatchedPresence();
  }

  private async isCurrentSession(
    session: SocketSession,
    now: number,
    force = false,
  ): Promise<boolean> {
    const cached = this.sessionValidations.get(session.tokenHash);
    if (cached?.pending) return cached.pending;
    if (!force && cached && now - cached.checkedAt < this.sessionValidationMs) {
      return cached.valid;
    }
    const pending = this.iam
      .getActor(session.credentials)
      .then(
        (actor) =>
          actor.id === session.actor.id &&
          actor.organizationId === session.actor.organizationId,
      )
      .catch((error: unknown) => {
        this.logger.warn(
          `Chat WS IAM session revalidation rejected/failed for user ${session.actor.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      });
    this.sessionValidations.set(session.tokenHash, {
      checkedAt: now,
      valid: false,
      pending,
    });
    const valid = await pending;
    this.sessionValidations.set(session.tokenHash, { checkedAt: now, valid });
    return valid;
  }

  private async renew(session: SocketSession): Promise<void> {
    try {
      await this.redis.touchPresenceSession(
        this.presenceKey(session.actor.organizationId, session.actor.id),
        session.id,
        presenceLeaseMs,
      );
    } catch {
      // Presence resumes on the next successful pong after Redis recovers.
    }
  }

  private async refreshWatchedPresence(): Promise<void> {
    const watchedEntries = [...this.presenceWatchers.entries()];
    if (watchedEntries.length === 0) return;

    const byOrg = new Map<
      string,
      { watcherKey: string; userId: string; sockets: Set<WebSocket> }[]
    >();
    for (const [watcherKey, sockets] of watchedEntries) {
      const [organizationId, userId] = watcherKey.split(':');
      if (!organizationId || !userId) continue;
      const list = byOrg.get(organizationId) ?? [];
      list.push({ watcherKey, userId, sockets });
      byOrg.set(organizationId, list);
    }

    await Promise.all(
      [...byOrg.entries()].map(async ([organizationId, items]) => {
        try {
          const onlineByUser = await this.areOnlineBatch(
            organizationId,
            items.map((item) => item.userId),
          );
          for (const item of items) {
            const isOnline = onlineByUser.get(item.userId) ?? false;
            if (this.presenceStates.get(item.watcherKey) === isOnline) continue;
            this.presenceStates.set(item.watcherKey, isOnline);
            for (const socket of item.sockets) {
              this.send(socket, 'presence.changed', {
                userId: item.userId,
                isOnline,
              });
            }
          }
        } catch (error) {
          this.logger.warn(
            `Chat WS watched-presence refresh failed for org ${organizationId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );
  }

  private applyPresenceEviction(event: PresenceEvictEvent): void {
    const pairs: [string, string][] = [
      [event.blockerId, event.blockedUserId],
      [event.blockedUserId, event.blockerId],
    ];
    for (const [targetUserId, watcherUserId] of pairs) {
      const watcherKey = this.presenceWatcherKey(
        event.organizationId,
        targetUserId,
      );
      const watcherSockets = this.userSockets.get(
        this.userKey(event.organizationId, watcherUserId),
      );
      if (!watcherSockets) continue;
      for (const socket of watcherSockets) {
        const session = this.sessions.get(socket);
        session?.watchedUsers.delete(watcherKey);
        this.removeFromSet(this.presenceWatchers, watcherKey, socket);
      }
      if (!this.presenceWatchers.has(watcherKey)) {
        this.presenceStates.delete(watcherKey);
      }
    }
  }

  private applyConversationEviction(event: ConversationEvictEvent): void {
    for (const userId of event.userIds) {
      const sockets = this.userSockets.get(
        this.userKey(event.organizationId, userId),
      );
      if (!sockets) continue;
      for (const socket of sockets) {
        this.unsubscribeConversation(socket, event.conversationId);
      }
    }
  }

  private applySessionRevocation(event: SessionRevokeEvent): void {
    if (event.tokenHash) {
      this.sessionValidations.delete(event.tokenHash);
    }
    for (const [socket, session] of [...this.sessions.entries()]) {
      const tokenMatches =
        event.tokenHash !== undefined && session.tokenHash === event.tokenHash;
      const userMatches =
        event.userId !== undefined &&
        session.actor.id === event.userId &&
        (event.organizationId === undefined ||
          session.actor.organizationId === event.organizationId);
      if (tokenMatches || userMatches) {
        this.sessionValidations.delete(session.tokenHash);
        socket.close(1008, 'Session revoked');
        void this.unregister(socket);
      }
    }
  }

  private receiveIamRevocation(value: string): void {
    try {
      const decoded = JSON.parse(value) as {
        userId?: unknown;
        organizationId?: unknown;
        tokenHash?: unknown;
      };
      if (typeof decoded !== 'object' || decoded === null) return;
      const userId =
        typeof decoded.userId === 'string' ? decoded.userId : undefined;
      const organizationId =
        typeof decoded.organizationId === 'string'
          ? decoded.organizationId
          : undefined;
      const tokenHash =
        typeof decoded.tokenHash === 'string' ? decoded.tokenHash : undefined;
      if (!userId && !tokenHash) return;
      this.applySessionRevocation({
        type: 'session.revoke',
        ...(userId ? { userId } : {}),
        ...(organizationId ? { organizationId } : {}),
        ...(tokenHash ? { tokenHash } : {}),
      });
    } catch {
      // Ignore malformed revocation payloads
    }
  }

  private receive(value: string): void {
    let event: ChatRealtimeEvent;
    try {
      event = JSON.parse(value) as ChatRealtimeEvent;
    } catch {
      return;
    }
    if (event.type === 'notification') {
      this.deliverNotificationEvent(event);
      return;
    }
    if (event.type === 'presence.evict') {
      this.applyPresenceEviction(event);
      return;
    }
    if (event.type === 'conversation.evict') {
      this.applyConversationEviction(event);
      return;
    }
    if (event.type === 'session.revoke') {
      this.applySessionRevocation(event);
      return;
    }
    if (event.type === 'presence') {
      const watcherKey = this.presenceWatcherKey(
        event.organizationId,
        event.userId,
      );
      if (!this.presenceWatchers.has(watcherKey)) return;
      if (this.presenceStates.get(watcherKey) === event.isOnline) return;
      this.presenceStates.set(watcherKey, event.isOnline);
      for (const socket of this.presenceWatchers.get(watcherKey) ?? []) {
        this.send(socket, 'presence.changed', {
          userId: event.userId,
          isOnline: event.isOnline,
        });
      }
      return;
    }
    if (
      event.type !== 'conversation' ||
      typeof event.conversationId !== 'string' ||
      !Array.isArray(event.recipientIds)
    )
      return;
    if (event.event === 'typing') {
      const allowedRecipients = new Set(
        event.recipientIds.filter(
          (recipientId): recipientId is string =>
            typeof recipientId === 'string' && recipientId.length > 0,
        ),
      );
      for (const socket of this.conversationSockets.get(event.conversationId) ??
        []) {
        const session = this.sessions.get(socket);
        if (
          session &&
          allowedRecipients.has(session.actor.id) &&
          this.canDeliverToSocket(
            socket,
            event.organizationId,
            session.actor.id,
          )
        ) {
          this.send(socket, event.event, event.data);
        }
      }
      return;
    }
    for (const recipientId of new Set(event.recipientIds)) {
      if (typeof recipientId !== 'string' || recipientId.length === 0) continue;
      for (const socket of [
        ...(this.userSockets.get(
          this.userKey(event.organizationId, recipientId),
        ) ?? []),
      ]) {
        if (
          this.canDeliverToSocket(socket, event.organizationId, recipientId)
        ) {
          this.send(socket, event.event, event.data);
        }
      }
    }
  }

  private canDeliverToSocket(
    socket: WebSocket,
    organizationId: string,
    recipientId: string,
  ): boolean {
    const session = this.sessions.get(socket);
    if (
      !session ||
      session.actor.organizationId !== organizationId ||
      session.actor.id !== recipientId
    ) {
      return false;
    }
    if (Date.now() >= session.expiresAt) {
      socket.close(1008, 'Session expired');
      void this.unregister(socket);
      return false;
    }
    const validation = this.sessionValidations.get(session.tokenHash);
    if (validation && !validation.pending && !validation.valid) {
      socket.close(1008, 'Session expired');
      void this.unregister(socket);
      return false;
    }
    return true;
  }

  private deliverNotificationEvent(event: NotificationSocketEvent): void {
    // Strictly require matching non-null organizationId (never broadcast null-org across orgs)
    // and use the O(1) userSockets index instead of scanning all connected sockets.
    if (
      typeof event.organizationId !== 'string' ||
      event.organizationId.trim().length === 0 ||
      !Array.isArray(event.recipientIds)
    ) {
      return;
    }
    for (const recipientId of new Set(event.recipientIds)) {
      const sockets = this.userSockets.get(
        this.userKey(event.organizationId, recipientId),
      );
      if (!sockets) continue;
      for (const socket of [...sockets]) {
        if (
          this.canDeliverToSocket(socket, event.organizationId, recipientId)
        ) {
          this.send(socket, event.event, event.data);
        }
      }
    }
  }

  private receiveNotification(value: string): void {
    try {
      const decoded = JSON.parse(value) as
        | Partial<NotificationSocketEvent>
        | {
            version?: number;
            payload?: Partial<NotificationSocketEvent>;
            traceContext?: Record<string, unknown>;
          };
      const isEnvelope =
        typeof decoded === 'object' && decoded !== null && 'payload' in decoded;
      const payload = isEnvelope
        ? decoded.payload
        : (decoded as Partial<NotificationSocketEvent>);
      const carrier = isEnvelope ? decoded.traceContext : undefined;
      const traceCarrier: Record<string, string> = {};
      if (carrier && typeof carrier === 'object') {
        for (const key of ['traceparent', 'tracestate'] as const) {
          const val = carrier[key];
          if (typeof val === 'string' && val.length <= 512) {
            traceCarrier[key] = val;
          }
        }
      }
      const parentContext = propagation.extract(ROOT_CONTEXT, traceCarrier);
      const supportedEvents: readonly string[] = [
        'notification.created',
        'notification.read',
        'notification.read_all',
      ];
      if (
        payload &&
        typeof payload.event === 'string' &&
        supportedEvents.includes(payload.event) &&
        Array.isArray(payload.recipientIds)
      ) {
        const event: NotificationSocketEvent = {
          type: 'notification',
          event: payload.event,
          organizationId:
            typeof payload.organizationId === 'string'
              ? payload.organizationId
              : null,
          recipientIds: Array.isArray(payload.recipientIds)
            ? payload.recipientIds.filter(
                (recipientId): recipientId is string =>
                  typeof recipientId === 'string',
              )
            : [],
          data: payload.data,
        };
        if (
          event.recipientIds.length > 0 &&
          typeof event.organizationId === 'string' &&
          event.organizationId.trim().length > 0
        ) {
          trace.getTracer('continuum-notifications').startActiveSpan(
            'notification.realtime.consume',
            {
              kind: SpanKind.CONSUMER,
              attributes: {
                'messaging.system': 'redis',
                'messaging.destination.name': this.notificationChannel,
                'messaging.operation.name': 'process',
                'app.notification.event': event.event,
              },
            },
            parentContext,
            (span) => {
              try {
                this.deliverNotificationEvent(event);
                span.setAttribute(
                  'app.notification.recipient_count',
                  event.recipientIds.length,
                );
              } catch (error) {
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message:
                    error instanceof Error ? error.message : String(error),
                });
                throw error;
              } finally {
                span.end();
              }
            },
          );
        }
      }
    } catch {
      // Ignore malformed cross-process messages; polling rehydrates persisted state.
    }
  }

  private async publish(event: ChatRealtimeEvent): Promise<void> {
    const serialized = JSON.stringify(event);
    if (!this.stopSubscriber) {
      // Deliver locally while Redis subscriber is offline/reconnecting.
      if (event.type !== 'notification') {
        this.receive(serialized);
      }
      try {
        await this.redis.publish(this.eventChannel, serialized);
      } catch {
        // Local delivery already ran; cross-replica fanout resumes once Redis recovers.
      }
      return;
    }
    try {
      await this.redis.publish(this.eventChannel, serialized);
    } catch {
      this.receive(serialized);
    }
  }

  private presenceKey(organizationId: string, userId: string): string {
    return `${this.redisPrefix}:presence:${organizationId}:${userId}`;
  }

  private userKey(organizationId: string, userId: string): string {
    return `${organizationId}:${userId}`;
  }

  private presenceWatcherKey(organizationId: string, userId: string): string {
    return `${organizationId}:${userId}`;
  }

  private removeFromSet(
    index: Map<string, Set<WebSocket>>,
    key: string,
    socket: WebSocket,
  ): void {
    const sockets = index.get(key);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) index.delete(key);
  }
}
