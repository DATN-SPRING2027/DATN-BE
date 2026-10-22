import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { ChatApplicationService } from '../application/chat.service';
import { ChatRealtimeService } from '../application/chat-realtime.service';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getTicket(request: IncomingMessage): string | undefined {
  const header = request.headers['sec-websocket-protocol'];
  if (typeof header !== 'string') return undefined;
  const ticketProtocol = header
    .split(',')
    .map((protocol: string) => protocol.trim())
    .find((protocol: string) => protocol.startsWith('ticket.'));
  return ticketProtocol?.slice('ticket.'.length);
}

@WebSocketGateway({
  path: '/internal/chat/ws',
  maxPayload: 16 * 1024,
  perMessageDeflate: false,
})
export class ChatRealtimeGateway
  implements OnGatewayConnection<WebSocket>, OnGatewayDisconnect<WebSocket>
{
  private readonly allowedOrigins: Set<string>;

  constructor(
    config: ConfigService,
    private readonly chat: ChatApplicationService,
    private readonly realtime: ChatRealtimeService,
  ) {
    this.allowedOrigins = new Set(
      (config.get<string>('CHAT_ALLOWED_ORIGINS') ?? 'http://localhost:3000')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    );
  }

  async handleConnection(client: WebSocket, ...args: unknown[]): Promise<void> {
    const request = args[0] as IncomingMessage | undefined;
    const origin = request?.headers.origin;
    if (!origin || !this.allowedOrigins.has(origin)) {
      client.close(1008, 'Origin not allowed');
      return;
    }
    const ticket = request ? getTicket(request) : undefined;
    if (!ticket) {
      client.close(1008, 'Realtime ticket required');
      return;
    }
    try {
      const session = await this.chat.consumeWsTicket(ticket);
      if (!session) {
        client.close(1008, 'Realtime ticket expired');
        return;
      }
      const credentials = this.chat.getSessionCredential({
        ...(typeof request.headers.authorization === 'string'
          ? { authorization: request.headers.authorization }
          : {}),
        ...(typeof request.headers.cookie === 'string'
          ? { cookie: request.headers.cookie }
          : {}),
      });
      const binding = this.chat.getSessionBinding(credentials);
      if (binding.tokenHash !== session.tokenHash) {
        client.close(1008, 'Realtime session mismatch');
        return;
      }
      const actor = await this.chat.authenticate(credentials);
      if (
        actor.id !== session.actor.id ||
        actor.organizationId !== session.actor.organizationId
      ) {
        client.close(1008, 'Realtime session expired');
        return;
      }
      await this.realtime.register(
        client,
        actor,
        credentials,
        session.tokenHash,
        session.expiresAt,
      );
      this.realtime.send(client, 'connected', { userId: actor.id });
    } catch (error) {
      client.close(
        error instanceof HttpException && error.getStatus() === 401
          ? 1008
          : 1013,
        error instanceof HttpException && error.getStatus() === 401
          ? 'Realtime session expired'
          : 'Realtime service unavailable',
      );
    }
  }

  handleDisconnect(client: WebSocket): void {
    void this.realtime.unregister(client);
  }

  @SubscribeMessage('subscribe')
  async subscribe(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() body: unknown,
  ) {
    const actor = this.realtime.getActor(client);
    if (!actor || !isRecord(body) || typeof body.conversationId !== 'string') {
      return this.error(client, 'CHAT_SUBSCRIBE_INVALID');
    }
    try {
      await this.chat.requireSocketMember(actor, body.conversationId);
      this.realtime.subscribeConversation(client, body.conversationId);
      return {
        event: 'subscribed',
        data: { conversationId: body.conversationId },
      };
    } catch {
      return this.error(client, 'CHAT_CONVERSATION_UNAVAILABLE');
    }
  }

  @SubscribeMessage('unsubscribe')
  unsubscribe(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() body: unknown,
  ) {
    if (!isRecord(body) || typeof body.conversationId !== 'string') {
      return this.error(client, 'CHAT_SUBSCRIBE_INVALID');
    }
    this.realtime.unsubscribeConversation(client, body.conversationId);
    return {
      event: 'unsubscribed',
      data: { conversationId: body.conversationId },
    };
  }

  @SubscribeMessage('presence.watch')
  async watchPresence(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() body: unknown,
  ) {
    const actor = this.realtime.getActor(client);
    if (
      !actor ||
      !isRecord(body) ||
      !Array.isArray(body.userIds) ||
      !body.userIds.every((userId) => typeof userId === 'string')
    )
      return this.error(client, 'CHAT_PRESENCE_WATCH_INVALID');
    try {
      const allowed = await this.chat.watchableContacts(actor, body.userIds);
      await this.realtime.watchPresence(client, allowed);
      return undefined;
    } catch {
      return this.error(client, 'CHAT_PRESENCE_WATCH_INVALID');
    }
  }

  @SubscribeMessage('typing')
  async typing(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() body: unknown,
  ) {
    const actor = this.realtime.getActor(client);
    if (
      !actor ||
      !isRecord(body) ||
      typeof body.conversationId !== 'string' ||
      typeof body.isTyping !== 'boolean'
    )
      return this.error(client, 'CHAT_TYPING_INVALID');
    try {
      await this.chat.requireSocketMember(actor, body.conversationId);
      const members = await this.chat.socketMemberIds(
        actor,
        body.conversationId,
      );
      await this.realtime.relayTyping(
        client,
        body.conversationId,
        body.isTyping,
        members,
      );
      return undefined;
    } catch {
      return this.error(client, 'CHAT_CONVERSATION_UNAVAILABLE');
    }
  }

  @SubscribeMessage('heartbeat')
  heartbeat(@ConnectedSocket() client: WebSocket) {
    return this.realtime.getActor(client)
      ? { event: 'heartbeat.ack', data: { at: Date.now() } }
      : this.error(client, 'CHAT_SESSION_REQUIRED');
  }

  private error(client: WebSocket, code: string) {
    this.realtime.send(client, 'error', { code });
    return undefined;
  }
}
