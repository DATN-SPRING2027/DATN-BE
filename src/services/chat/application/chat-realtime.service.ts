import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { ChatIamClient, type ChatCredentials } from './chat-iam.client';
import { RedisService } from '../infrastructure/redis/redis.service';
import type { ChatActor } from './chat.repository';
import { NotificationRealtimeBus } from '../../notification/notification-realtime.bus';

const presenceLeaseMs = 75_000;
const heartbeatMs = 20_000;
const sessionValidationMs = 60_000;

interface SocketSession {
  id: string;
  actor: ChatActor;
  credentials: ChatCredentials;
  tokenHash: string;
  expiresAt: number;
  alive: boolean;
  lastTypingAt: number;
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

interface NotificationSocketEvent {
  type: 'notification';
  event: 'notification.created' | 'notification.read' | 'notification.read_all';
  organizationId: string | null;
  recipientIds: string[];
  data: unknown;
}

interface SessionValidation {
  checkedAt: number;
  valid: boolean;
  pending?: Promise<boolean>;
}

@Injectable()
export class ChatRealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly redisPrefix: string;
  private readonly eventChannel: string;
  private readonly sessions = new Map<WebSocket, SocketSession>();
  private readonly userSockets = new Map<string, Set<WebSocket>>();
  private readonly conversationSockets = new Map<string, Set<WebSocket>>();
  private readonly presenceWatchers = new Map<string, Set<WebSocket>>();
  private readonly presenceStates = new Map<string, boolean>();
  private readonly sessionValidations = new Map<string, SessionValidation>();
  private stopSubscriber?: () => void;
  private stopNotificationBus?: () => void;
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly redis: RedisService,
    private readonly iam: ChatIamClient,
    private readonly config: ConfigService,
    @Optional()
    private readonly notificationBus?: NotificationRealtimeBus,
  ) {
    this.redisPrefix = `${config.get<string>('BULLMQ_PREFIX') ?? 'continuum'}:chat`;
    this.eventChannel = `${this.redisPrefix}:events:v1`;
  }

  async onModuleInit(): Promise<void> {
    const bus = this.notificationBus ?? new NotificationRealtimeBus();
    this.stopNotificationBus = bus.onRealtimeEvent((payload) => {
      const event: NotificationSocketEvent = {
        type: 'notification',
        event: payload.event,
        organizationId: payload.organizationId,
        recipientIds: [...payload.recipientIds],
        data: payload.data,
      };
      this.deliverNotificationEvent(event);
      void this.publish(event);
    });
    if (this.config.get<string>('INFRA_ENABLED') !== 'false') {
      try {
        this.stopSubscriber = await this.redis.subscribe(
          this.eventChannel,
          (value) => {
            this.receive(value);
          },
        );
      } catch {
        // Realtime pub/sub degrades gracefully when Redis is unavailable at startup.
      }
    }
    this.heartbeat = setInterval(() => {
      void this.pingAndExpireSessions();
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  onModuleDestroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.stopSubscriber?.();
    this.stopNotificationBus?.();
  }

  async register(
    socket: WebSocket,
    actor: ChatActor,
    credentials: ChatCredentials,
    tokenHash: string,
    expiresAt: number,
  ): Promise<void> {
    const session: SocketSession = {
      id: randomUUID(),
      actor,
      credentials,
      tokenHash,
      expiresAt,
      alive: true,
      lastTypingAt: 0,
      conversations: new Set(),
      watchedUsers: new Set(),
    };
    this.sessions.set(socket, session);
    const userSockets =
      this.userSockets.get(this.userKey(actor.organizationId, actor.id)) ??
      new Set();
    userSockets.add(socket);
    this.userSockets.set(
      this.userKey(actor.organizationId, actor.id),
      userSockets,
    );
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
  }

  getActor(socket: WebSocket): ChatActor | undefined {
    return this.sessions.get(socket)?.actor;
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
    const data = await Promise.all(
      userIds.map(async (userId) => ({
        userId,
        isOnline: await this.isOnline(session.actor.organizationId, userId),
      })),
    );
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
    if (isTyping) {
      if (now - session.lastTypingAt < 400) return;
      session.lastTypingAt = now;
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

  private async pingAndExpireSessions(): Promise<void> {
    const now = Date.now();
    await Promise.all(
      [...this.sessions.entries()].map(async ([socket, session]) => {
        let revoked = false;
        try {
          revoked = await this.redis.isTokenRevoked(session.tokenHash);
        } catch {
          // Redis outages make revocation temporarily unavailable; token expiry still applies.
        }
        if (
          now >= session.expiresAt ||
          revoked ||
          !(await this.isCurrentSession(session, now))
        ) {
          socket.close(1008, 'Session expired');
          return;
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
  ): Promise<boolean> {
    const cached = this.sessionValidations.get(session.tokenHash);
    if (cached?.pending) return cached.pending;
    if (cached && now - cached.checkedAt < sessionValidationMs) {
      return cached.valid;
    }
    const pending = this.iam
      .getActor(session.credentials)
      .then(
        (actor) =>
          actor.id === session.actor.id &&
          actor.organizationId === session.actor.organizationId,
      )
      .catch(() => false);
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
    await Promise.all(
      [...this.presenceWatchers.entries()].map(
        async ([watcherKey, sockets]) => {
          const [organizationId, userId] = watcherKey.split(':');
          if (!organizationId || !userId) return;
          try {
            const isOnline = await this.isOnline(organizationId, userId);
            if (this.presenceStates.get(watcherKey) === isOnline) return;
            this.presenceStates.set(watcherKey, isOnline);
            for (const socket of sockets) {
              this.send(socket, 'presence.changed', { userId, isOnline });
            }
          } catch {
            // A later heartbeat retries this check without changing the last known state.
          }
        },
      ),
    );
  }

  private receive(value: string): void {
    let event: ConversationEvent | PresenceEvent | NotificationSocketEvent;
    try {
      event = JSON.parse(value) as
        ConversationEvent | PresenceEvent | NotificationSocketEvent;
    } catch {
      return;
    }
    if (event.type === 'notification') {
      this.deliverNotificationEvent(event);
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
      for (const socket of this.conversationSockets.get(event.conversationId) ??
        []) {
        const session = this.sessions.get(socket);
        if (
          session?.actor.organizationId === event.organizationId &&
          event.recipientIds.includes(session.actor.id)
        ) {
          this.send(socket, event.event, event.data);
        }
      }
      return;
    }
    for (const recipientId of event.recipientIds) {
      for (const socket of this.userSockets.get(
        this.userKey(event.organizationId, recipientId),
      ) ?? []) {
        this.send(socket, event.event, event.data);
      }
    }
  }

  private deliverNotificationEvent(event: NotificationSocketEvent): void {
    if (!Array.isArray(event.recipientIds)) return;
    const recipientSet = new Set(event.recipientIds);
    for (const [socket, session] of this.sessions.entries()) {
      if (!recipientSet.has(session.actor.id)) continue;
      this.send(socket, event.event, event.data);
    }
  }

  private async publish(
    event: ConversationEvent | PresenceEvent | NotificationSocketEvent,
  ): Promise<void> {
    try {
      await this.redis.publish(this.eventChannel, JSON.stringify(event));
    } catch {
      // Persisted messages remain readable by cursor after a missed realtime event.
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
