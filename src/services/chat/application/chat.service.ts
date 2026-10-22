import { normalizeSearchText } from '../../../common/search/literal-search';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HealthResponse } from '../../../health/health.response';
import { RedisService } from '../infrastructure/redis/redis.service';
import { ChatIamClient, type ChatCredentials } from './chat-iam.client';
import {
  CHAT_REPOSITORY,
  type ChatActor,
  type ChatCursor,
  type ChatRepository,
} from './chat.repository';
import { ChatRealtimeService } from './chat-realtime.service';
import { R2Storage } from '../infrastructure/storage/r2.storage';
import { S3Storage } from '../infrastructure/storage/s3.storage';
import type { ChatUpload } from './chat.repository';

const objectId = /^[a-f\d]{24}$/i;
const uuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maximumPageSize = 100;
const ticketLifetimeSeconds = 30;
const allowedReactions = new Set(['👍', '❤️', '😂', '😮', '😢', '🙏']);
const maximumAttachments = 10;
const imageTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const documentTypes = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
const historyCacheSeconds = 10;

function sanitizeFilename(name: string): string {
  return [...name]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === '/' ||
        character === '\\' ||
        code < 32 ||
        code === 127
        ? '_'
        : character;
    })
    .join('')
    .trim()
    .slice(0, 255);
}

export interface ChatWsTicket {
  actor: ChatActor;
  tokenHash: string;
  expiresAt: number;
}

function invalid(message = 'Request validation failed.'): never {
  throw new UnprocessableEntityException({
    code: 'CHAT_VALIDATION_FAILED',
    message,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parsePageSize(value: unknown, fallback = 40): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d*$/.test(value) ||
    Number(value) > maximumPageSize
  )
    return invalid('Page size must be between 1 and 100.');
  return Number(value);
}

function parseCursor(value: unknown): ChatCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 256) {
    return invalid('Cursor is invalid.');
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as unknown;
    if (
      !isRecord(decoded) ||
      !exactKeys(decoded, ['at', 'id', 'pinned']) ||
      (decoded.pinned !== undefined && typeof decoded.pinned !== 'boolean') ||
      typeof decoded.at !== 'string' ||
      Number.isNaN(Date.parse(decoded.at)) ||
      typeof decoded.id !== 'string' ||
      !objectId.test(decoded.id)
    )
      return invalid('Cursor is invalid.');
    return {
      createdAt: new Date(decoded.at),
      id: decoded.id,
      ...(typeof decoded.pinned === 'boolean'
        ? { isPinned: decoded.pinned }
        : {}),
    };
  } catch {
    return invalid('Cursor is invalid.');
  }
}

function encodeCursor(cursor: ChatCursor | null | undefined): string | null {
  if (!cursor) return null;
  return Buffer.from(
    JSON.stringify({
      at: cursor.createdAt.toISOString(),
      id: cursor.id,
      ...(cursor.isPinned !== undefined ? { pinned: cursor.isPinned } : {}),
    }),
  ).toString('base64url');
}

@Injectable()
export class ChatApplicationService {
  private readonly redisPrefix: string;

  constructor(
    @Inject(CHAT_REPOSITORY) private readonly repository: ChatRepository,
    private readonly iam: ChatIamClient,
    private readonly redis: RedisService,
    private readonly realtime: ChatRealtimeService,
    private readonly r2: R2Storage,
    private readonly s3: S3Storage,
    config: ConfigService,
  ) {
    this.redisPrefix = `${config.get<string>('BULLMQ_PREFIX') ?? 'continuum'}:chat`;
  }

  getHealth(): HealthResponse {
    return { status: 'ok' };
  }

  authenticate(credentials: ChatCredentials): Promise<ChatActor> {
    return this.iam.getActor(credentials);
  }

  getSessionCredential(credentials: ChatCredentials): ChatCredentials {
    return this.iam.getSessionCredential(credentials);
  }

  getSessionBinding(credentials: ChatCredentials) {
    return this.iam.getSessionBinding(credentials);
  }

  async searchCandidates(credentials: ChatCredentials, searchValue: unknown) {
    if (
      typeof searchValue !== 'string' ||
      searchValue.trim().length < 2 ||
      searchValue.length > 80
    )
      return invalid('Search must contain between 2 and 80 characters.');
    const actor = await this.iam.getActor(credentials);
    const cacheKey = this.redisKey(
      `candidate-search-v2:${actor.organizationId}:${actor.id}:${createHash(
        'sha256',
      )
        .update(
          searchValue.includes('@')
            ? searchValue.trim().toLowerCase()
            : normalizeSearchText(searchValue),
        )
        .digest('hex')}`,
    );
    const cached = await this.redis.get(cacheKey);
    let result: Awaited<ReturnType<ChatIamClient['searchCandidates']>>;
    if (cached) {
      const ids = JSON.parse(cached) as string[];
      const resolved = await this.iam.getCandidates(credentials, ids);
      const byId = new Map(
        resolved.data.map((candidate) => [candidate.id, candidate]),
      );
      result = {
        actorId: actor.id,
        organizationId: actor.organizationId,
        data: ids.flatMap((id) => {
          const candidate = byId.get(id);
          return candidate ? [candidate] : [];
        }),
      };
    } else {
      result = await this.iam.searchCandidates(credentials, searchValue.trim());
      await this.redis.set(
        cacheKey,
        JSON.stringify(result.data.map((candidate) => candidate.id)),
        15,
      );
    }
    if (
      !(await this.redis.consumeRateLimit(
        this.redisKey(`search:${result.organizationId}:${result.actorId}`),
        60,
        60,
      ))
    ) {
      throw new HttpException(
        {
          code: 'CHAT_RATE_LIMITED',
          message: 'Search is temporarily rate limited.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return {
      data: await Promise.all(
        result.data.map(async (candidate) => ({
          ...candidate,
          isOnline: await this.realtime.isOnline(
            result.organizationId,
            candidate.id,
          ),
        })),
      ),
    };
  }

  async listConversations(
    credentials: ChatCredentials,
    query: Record<string, unknown>,
  ) {
    if (
      query.search !== undefined &&
      (typeof query.search !== 'string' || query.search.length > 80)
    ) {
      return invalid('Conversation search must contain at most 80 characters.');
    }
    const actor = await this.iam.getActor(credentials);
    if (
      query.archived !== undefined &&
      query.archived !== 'true' &&
      query.archived !== 'false'
    )
      return invalid('Archive filter is invalid.');
    const page = await this.repository.listConversations(
      actor,
      parsePageSize(query.limit),
      parseCursor(query.cursor),
      typeof query.search === 'string' ? query.search.trim() : undefined,
      query.archived === 'true',
    );
    const data = await Promise.all(
      page.data.map(async (conversation) => ({
        ...conversation,
        members: await Promise.all(
          conversation.members.map(async (member) => ({
            ...member,
            ...(conversation.type === 'DIRECT' && member.userId !== actor.id
              ? {
                  isOnline: await this.realtime.isOnline(
                    actor.organizationId,
                    member.userId,
                  ),
                }
              : {}),
          })),
        ),
      })),
    );
    return { data, nextCursor: encodeCursor(page.nextCursor) };
  }

  async createDirect(credentials: ChatCredentials, body: unknown) {
    if (
      !isRecord(body) ||
      !exactKeys(body, ['participantId']) ||
      typeof body.participantId !== 'string' ||
      !objectId.test(body.participantId)
    )
      return invalid('Participant is invalid.');
    const resolution = await this.iam.getCandidates(credentials, [
      body.participantId,
    ]);
    const actor = resolution.actor;
    if (
      !(await this.redis.consumeRateLimit(
        this.redisKey(`direct:${actor.organizationId}:${actor.id}`),
        30,
        60,
      ))
    ) {
      throw new HttpException(
        {
          code: 'CHAT_RATE_LIMITED',
          message: 'Too many conversations were created. Try again shortly.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const recipient = resolution.data[0];
    if (!recipient)
      return invalid('Participant is unavailable in your organization.');
    const id = await this.repository.createDirect(actor, recipient);
    await this.realtime.publishConversationEvent(
      'conversation.updated',
      actor.organizationId,
      id,
      [actor.id, recipient.id],
      { id, type: 'DIRECT' },
    );
    return { id, type: 'DIRECT' as const };
  }

  async createRoom(credentials: ChatCredentials, body: unknown) {
    if (
      !isRecord(body) ||
      !exactKeys(body, ['title', 'participantIds', 'clientRoomId']) ||
      typeof body.title !== 'string' ||
      body.title.trim().length < 1 ||
      body.title.trim().length > 80 ||
      !Array.isArray(body.participantIds) ||
      body.participantIds.length < 1 ||
      body.participantIds.length > 49 ||
      !body.participantIds.every(
        (id) => typeof id === 'string' && objectId.test(id),
      ) ||
      typeof body.clientRoomId !== 'string' ||
      !uuidV4.test(body.clientRoomId)
    )
      return invalid('Room details are invalid.');
    const participantIds = body.participantIds as string[];
    if (
      new Set(participantIds.map((id) => id.toLowerCase())).size !==
      participantIds.length
    )
      return invalid('Room participants must be unique.');
    const resolution = await this.iam.getCandidates(
      credentials,
      participantIds,
    );
    const actor = resolution.actor;
    if (
      participantIds.some((id) => id.toLowerCase() === actor.id.toLowerCase())
    ) {
      return invalid('Room participants cannot include you.');
    }
    const candidates = resolution.data;
    if (candidates.length !== participantIds.length) {
      return invalid(
        'Every participant must be an active member of your organization.',
      );
    }
    if (
      !(await this.redis.consumeRateLimit(
        this.redisKey(`room:${actor.organizationId}:${actor.id}`),
        10,
        60,
      ))
    ) {
      throw new HttpException(
        {
          code: 'CHAT_RATE_LIMITED',
          message: 'Too many rooms were created. Try again shortly.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const id = await this.repository.createRoom(
      actor,
      body.title.trim(),
      candidates,
      body.clientRoomId,
    );
    await this.realtime.publishConversationEvent(
      'conversation.updated',
      actor.organizationId,
      id,
      [actor.id, ...candidates.map((candidate) => candidate.id)],
      { id, type: 'ROOM' },
    );
    return { id, type: 'ROOM' as const };
  }

  async renameRoom(
    credentials: ChatCredentials,
    conversationId: string,
    body: unknown,
  ) {
    if (
      !objectId.test(conversationId) ||
      !isRecord(body) ||
      !exactKeys(body, ['title']) ||
      typeof body.title !== 'string' ||
      body.title.trim().length < 1 ||
      body.title.trim().length > 80
    )
      return invalid('Room title is invalid.');
    const actor = await this.iam.getActor(credentials);
    await this.requireMessageActionRateLimit(actor);
    const members = await this.repository.renameRoom(
      actor,
      conversationId,
      body.title.trim(),
    );
    await this.realtime.publishConversationEvent(
      'conversation.updated',
      actor.organizationId,
      conversationId,
      members,
      { id: conversationId, type: 'ROOM' },
    );
    return { id: conversationId, type: 'ROOM' as const };
  }

  async addRoomMembers(
    credentials: ChatCredentials,
    conversationId: string,
    body: unknown,
  ) {
    if (
      !objectId.test(conversationId) ||
      !isRecord(body) ||
      !exactKeys(body, ['participantIds']) ||
      !Array.isArray(body.participantIds) ||
      body.participantIds.length < 1 ||
      body.participantIds.length > 49 ||
      !body.participantIds.every(
        (id) => typeof id === 'string' && objectId.test(id),
      )
    )
      return invalid('Room members are invalid.');
    const participantIds = body.participantIds as string[];
    if (
      new Set(participantIds.map((id) => id.toLowerCase())).size !==
      participantIds.length
    )
      return invalid('Room members must be unique.');
    const resolution = await this.iam.getCandidates(
      credentials,
      participantIds,
    );
    const actor = resolution.actor;
    if (
      participantIds.some((id) => id.toLowerCase() === actor.id.toLowerCase())
    )
      return invalid('You are already a room member.');
    if (resolution.data.length !== participantIds.length)
      return invalid('Every participant must be active in your organization.');
    await this.requireMessageActionRateLimit(actor);
    const members = await this.repository.addRoomMembers(
      actor,
      conversationId,
      resolution.data,
    );
    await this.realtime.publishConversationEvent(
      'conversation.updated',
      actor.organizationId,
      conversationId,
      members,
      { id: conversationId, type: 'ROOM' },
    );
    return { id: conversationId, type: 'ROOM' as const };
  }

  async removeRoomMember(
    credentials: ChatCredentials,
    conversationId: string,
    userId: string,
  ) {
    if (!objectId.test(conversationId) || !objectId.test(userId))
      return invalid('Room member is invalid.');
    const actor = await this.iam.getActor(credentials);
    await this.requireMessageActionRateLimit(actor);
    const recipients = await this.repository.removeRoomMember(
      actor,
      conversationId,
      userId,
    );
    await this.realtime.publishConversationEvent(
      'conversation.updated',
      actor.organizationId,
      conversationId,
      recipients.filter((id) => id !== userId),
      { id: conversationId, type: 'ROOM' },
    );
    await this.realtime.publishConversationEvent(
      'conversation.removed',
      actor.organizationId,
      conversationId,
      [userId],
      { id: conversationId, type: 'ROOM' },
    );
    return { id: conversationId, type: 'ROOM' as const };
  }

  async leaveRoom(credentials: ChatCredentials, conversationId: string) {
    if (!objectId.test(conversationId))
      return invalid('Conversation is invalid.');
    const actor = await this.iam.getActor(credentials);
    await this.requireMessageActionRateLimit(actor);
    const recipients = await this.repository.leaveRoom(actor, conversationId);
    await this.realtime.publishConversationEvent(
      'conversation.updated',
      actor.organizationId,
      conversationId,
      recipients.filter((id) => id !== actor.id),
      { id: conversationId, type: 'ROOM' },
    );
    await this.realtime.publishConversationEvent(
      'conversation.removed',
      actor.organizationId,
      conversationId,
      [actor.id],
      { id: conversationId, type: 'ROOM' },
    );
    return { id: conversationId, type: 'ROOM' as const };
  }

  async listMessages(
    credentials: ChatCredentials,
    conversationId: string,
    query: Record<string, unknown>,
  ) {
    if (!objectId.test(conversationId))
      return invalid('Conversation is invalid.');
    const actor = await this.iam.getActor(credentials);
    const limit = parsePageSize(query.limit, 50);
    const cursor = parseCursor(query.cursor);
    if (
      query.aroundMessageId !== undefined &&
      (typeof query.aroundMessageId !== 'string' ||
        !objectId.test(query.aroundMessageId) ||
        query.cursor !== undefined)
    )
      return invalid(
        'Message context requires a valid message ID without a cursor.',
      );
    if (!(await this.repository.isMember(actor, conversationId))) {
      throw new NotFoundException({
        code: 'CHAT_CONVERSATION_NOT_FOUND',
        message: 'Conversation not found.',
      });
    }
    if (typeof query.aroundMessageId === 'string') {
      const page = await this.repository.messagesAround(
        actor,
        conversationId,
        query.aroundMessageId,
        limit,
      );
      return { data: page.data, nextCursor: encodeCursor(page.nextCursor) };
    }
    const versionKey = this.redisKey(
      `history-version:${actor.organizationId}:${conversationId}`,
    );
    let version = '0';
    try {
      version = (await this.redis.get(versionKey)) ?? '0';
    } catch {
      // Mongo remains authoritative when Redis is unavailable.
    }
    const cacheKey = this.redisKey(
      `history-inline-replies-v1:${actor.organizationId}:${conversationId}:${actor.id}:${version}:${limit}:${encodeCursor(cursor) ?? 'latest'}`,
    );
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached)
        return JSON.parse(cached) as {
          data: unknown[];
          nextCursor: string | null;
        };
    } catch {
      // A cache miss or Redis outage falls through to Mongo.
    }
    const page = await this.repository.listMessages(
      actor,
      conversationId,
      limit,
      cursor,
    );
    const result = {
      data: page.data,
      nextCursor: encodeCursor(page.nextCursor),
    };
    try {
      await this.redis.set(
        cacheKey,
        JSON.stringify(result),
        historyCacheSeconds,
      );
    } catch {
      // Cache writes never make a persisted message history unavailable.
    }
    return result;
  }

  async searchMessages(
    credentials: ChatCredentials,
    conversationId: string,
    query: Record<string, unknown>,
  ) {
    if (!objectId.test(conversationId))
      return invalid('Conversation is invalid.');
    if (
      typeof query.q !== 'string' ||
      query.q.trim().length < 2 ||
      query.q.length > 80
    ) {
      return invalid('Search must contain between 2 and 80 characters.');
    }
    const actor = await this.iam.getActor(credentials);
    const page = await this.repository.searchMessages(
      actor,
      conversationId,
      query.q.trim(),
      parsePageSize(query.limit, 30),
      parseCursor(query.cursor),
    );
    return { data: page.data, nextCursor: encodeCursor(page.nextCursor) };
  }

  async createUpload(
    credentials: ChatCredentials,
    conversationId: string,
    body: unknown,
  ) {
    if (
      !objectId.test(conversationId) ||
      !isRecord(body) ||
      !exactKeys(body, ['name', 'contentType', 'size']) ||
      typeof body.name !== 'string' ||
      typeof body.contentType !== 'string' ||
      typeof body.size !== 'number' ||
      !Number.isSafeInteger(body.size) ||
      body.size < 1
    )
      return invalid('File details are invalid.');
    const contentType = body.contentType.toLowerCase().trim();
    const kind = imageTypes.has(contentType)
      ? 'IMAGE'
      : documentTypes.has(contentType)
        ? 'DOCUMENT'
        : null;
    const maximumSize = kind === 'IMAGE' ? 10 * 1024 * 1024 : 25 * 1024 * 1024;
    const name = sanitizeFilename(body.name);
    if (!kind || !name || body.size > maximumSize) {
      return invalid('This file type or size is not supported.');
    }
    const actor = await this.iam.getActor(credentials);
    if (
      !(await this.redis.consumeRateLimit(
        this.redisKey(`upload:${actor.organizationId}:${actor.id}`),
        20,
        60,
      ))
    ) {
      throw new HttpException(
        {
          code: 'CHAT_RATE_LIMITED',
          message: 'Too many uploads. Try again shortly.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!(await this.repository.isMember(actor, conversationId))) {
      throw new NotFoundException({
        code: 'CHAT_CONVERSATION_NOT_FOUND',
        message: 'Conversation not found.',
      });
    }
    const provider = kind === 'IMAGE' ? 'S3' : 'R2';
    const uploadId = randomUUID();
    const objectKey = `chat/${actor.organizationId}/${conversationId}/${actor.id}/${uploadId}`;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const upload: ChatUpload = {
      id: uploadId,
      conversationId,
      uploaderId: actor.id,
      name,
      contentType,
      size: body.size,
      kind,
      provider,
      objectKey,
      status: 'PENDING',
      expiresAt,
    };
    await this.repository.createUpload(actor, upload);
    return {
      uploadId,
      expiresAt: expiresAt.toISOString(),
      provider,
    };
  }

  async uploadContent(
    credentials: ChatCredentials,
    conversationId: string,
    uploadId: string,
    source: Readable,
  ) {
    if (!objectId.test(conversationId) || !uuidV4.test(uploadId)) {
      return invalid('Upload is invalid.');
    }
    const actor = await this.iam.getActor(credentials);
    if (
      !(await this.redis.consumeRateLimit(
        this.redisKey(`upload-content:${actor.organizationId}:${actor.id}`),
        20,
        60,
      ))
    ) {
      throw new HttpException(
        {
          code: 'CHAT_RATE_LIMITED',
          message: 'Too many uploads. Try again shortly.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const upload = await this.repository.getUpload(
      actor,
      conversationId,
      uploadId,
    );
    if (!upload || upload.status !== 'PENDING') {
      throw new NotFoundException({
        code: 'CHAT_UPLOAD_NOT_FOUND',
        message: 'Upload not found.',
      });
    }

    let received = 0;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > upload.size) {
          callback(
            new BadRequestException({
              code: 'CHAT_UPLOAD_SIZE_MISMATCH',
              message: 'Uploaded file size does not match the request.',
            }),
          );
          return;
        }
        callback(null, chunk);
      },
      flush(callback) {
        callback(
          received === upload.size
            ? undefined
            : new BadRequestException({
                code: 'CHAT_UPLOAD_SIZE_MISMATCH',
                message: 'Uploaded file size does not match the request.',
              }),
        );
      },
    });
    const transfer = pipeline(source, bounded);
    try {
      await this.storage(upload.provider).putObject(
        upload.objectKey,
        bounded,
        upload.contentType,
        upload.size,
      );
      await transfer;
    } catch (error) {
      source.destroy();
      bounded.destroy();
      await transfer.catch(() => undefined);
      await this.storage(upload.provider)
        .deleteObject(upload.objectKey)
        .catch(() => undefined);
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException({
        code: 'CHAT_STORAGE_UNAVAILABLE',
        message: `${upload.provider} storage is not configured or unavailable.`,
      });
    }
    return { uploadId, status: 'UPLOADED' as const };
  }

  async completeUpload(
    credentials: ChatCredentials,
    conversationId: string,
    uploadId: string,
  ) {
    if (!objectId.test(conversationId) || !uuidV4.test(uploadId)) {
      return invalid('Upload is invalid.');
    }
    const actor = await this.iam.getActor(credentials);
    const upload = await this.repository.getUpload(
      actor,
      conversationId,
      uploadId,
    );
    if (!upload || upload.status === 'ATTACHED') {
      throw new NotFoundException({
        code: 'CHAT_UPLOAD_NOT_FOUND',
        message: 'Upload not found.',
      });
    }
    if (upload.status === 'READY')
      return { uploadId, status: 'READY' as const };
    try {
      const actual = await this.storage(upload.provider).headObject(
        upload.objectKey,
      );
      if (
        actual.size !== upload.size ||
        actual.contentType?.toLowerCase() !== upload.contentType
      ) {
        await this.storage(upload.provider)
          .deleteObject(upload.objectKey)
          .catch(() => undefined);
        throw new BadRequestException({
          code: 'CHAT_UPLOAD_MISMATCH',
          message: 'Uploaded file metadata does not match the request.',
        });
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException({
        code: 'CHAT_UPLOAD_INCOMPLETE',
        message: 'The file has not been uploaded or could not be verified.',
      });
    }
    const ready = await this.repository.completeUpload(
      actor,
      conversationId,
      uploadId,
    );
    if (!ready)
      throw new ConflictException({
        code: 'CHAT_UPLOAD_EXPIRED',
        message: 'Upload expired before completion.',
      });
    return { uploadId, status: 'READY' as const };
  }

  async getAttachmentDownloadUrl(
    credentials: ChatCredentials,
    conversationId: string,
    attachmentId: string,
  ) {
    if (!objectId.test(conversationId) || !uuidV4.test(attachmentId)) {
      return invalid('Attachment is invalid.');
    }
    const actor = await this.iam.getActor(credentials);
    const object = await this.repository.getAttachmentObject(
      actor,
      conversationId,
      attachmentId,
    );
    if (!object)
      throw new NotFoundException({
        code: 'CHAT_ATTACHMENT_NOT_FOUND',
        message: 'Attachment not found.',
      });
    try {
      const cacheKey = this.redisKey(
        `attachment-url:${actor.organizationId}:${conversationId}:${attachmentId}`,
      );
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const value = JSON.parse(cached) as { url: string; expiresAt: number };
        const remaining = Math.floor((value.expiresAt - Date.now()) / 1000);
        if (remaining > 30)
          return { url: value.url, expiresInSeconds: remaining };
      }
      const result = {
        url: await this.storage(object.provider).createDownloadUrl(
          object.objectKey,
          300,
          {
            contentType:
              object.kind === 'IMAGE'
                ? object.contentType
                : 'application/octet-stream',
            contentDisposition:
              object.kind === 'IMAGE' ? 'inline' : 'attachment',
            filename: object.name,
          },
        ),
        expiresInSeconds: 300,
      };
      await this.redis.set(
        cacheKey,
        JSON.stringify({ url: result.url, expiresAt: Date.now() + 300000 }),
        60,
      );
      return result;
    } catch {
      throw new ServiceUnavailableException({
        code: 'CHAT_STORAGE_UNAVAILABLE',
        message: 'File storage is unavailable.',
      });
    }
  }

  async sendMessage(
    credentials: ChatCredentials,
    conversationId: string,
    body: unknown,
  ) {
    if (!objectId.test(conversationId))
      return invalid('Conversation is invalid.');
    if (
      !isRecord(body) ||
      !exactKeys(body, [
        'clientMessageId',
        'content',
        'attachments',
        'replyToMessageId',
        'mentionUserIds',
      ]) ||
      typeof body.clientMessageId !== 'string' ||
      !uuidV4.test(body.clientMessageId) ||
      typeof body.content !== 'string' ||
      body.content.length > 8000 ||
      (body.attachments !== undefined &&
        (!Array.isArray(body.attachments) ||
          body.attachments.length > maximumAttachments ||
          !body.attachments.every(
            (id) => typeof id === 'string' && uuidV4.test(id),
          ) ||
          new Set(body.attachments).size !== body.attachments.length)) ||
      (body.replyToMessageId !== undefined &&
        (typeof body.replyToMessageId !== 'string' ||
          !objectId.test(body.replyToMessageId))) ||
      (!body.content.trim() &&
        (!Array.isArray(body.attachments) || body.attachments.length === 0))
    )
      return invalid('Message is invalid.');
    const actor = await this.iam.getActor(credentials);
    if (
      !(await this.redis.consumeRateLimit(
        this.redisKey(`send:${actor.organizationId}:${actor.id}`),
        120,
        60,
      ))
    ) {
      throw new HttpException(
        {
          code: 'CHAT_RATE_LIMITED',
          message: 'You are sending messages too quickly.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const mentionUserIds = await this.validateMentions(
      actor,
      conversationId,
      body.mentionUserIds,
    );
    const result = await this.repository.sendMessage(
      actor,
      conversationId,
      body.clientMessageId,
      body.content.trim(),
      (body.attachments as string[] | undefined) ?? [],
      body.replyToMessageId,
      mentionUserIds,
    );
    await this.bumpHistoryVersion(actor, conversationId);
    await this.realtime.publishConversationEvent(
      'message.created',
      actor.organizationId,
      conversationId,
      result.recipientIds,
      result.message,
    );
    return result.message;
  }

  async editMessage(
    credentials: ChatCredentials,
    conversationId: string,
    messageId: string,
    body: unknown,
  ) {
    if (
      !objectId.test(conversationId) ||
      !objectId.test(messageId) ||
      !isRecord(body) ||
      !exactKeys(body, ['content', 'mentionUserIds']) ||
      typeof body.content !== 'string' ||
      body.content.trim().length < 1 ||
      body.content.length > 8000
    )
      return invalid('Message update is invalid.');
    const actor = await this.iam.getActor(credentials);
    await this.requireMessageActionRateLimit(actor);
    const mentionUserIds = await this.validateMentions(
      actor,
      conversationId,
      body.mentionUserIds,
    );
    const result = await this.repository.editMessage(
      actor,
      conversationId,
      messageId,
      body.content.trim(),
      mentionUserIds,
    );
    await this.bumpHistoryVersion(actor, conversationId);
    await this.realtime.publishConversationEvent(
      'message.updated',
      actor.organizationId,
      conversationId,
      result.recipientIds,
      result.message,
    );
    return result.message;
  }

  async deleteMessage(
    credentials: ChatCredentials,
    conversationId: string,
    messageId: string,
  ) {
    if (!objectId.test(conversationId) || !objectId.test(messageId))
      return invalid('Message is invalid.');
    const actor = await this.iam.getActor(credentials);
    await this.requireMessageActionRateLimit(actor);
    const result = await this.repository.deleteMessage(
      actor,
      conversationId,
      messageId,
    );
    await this.bumpHistoryVersion(actor, conversationId);
    await this.realtime.publishConversationEvent(
      'message.deleted',
      actor.organizationId,
      conversationId,
      result.recipientIds,
      result.message,
    );
    return result.message;
  }

  async setMessageReaction(
    credentials: ChatCredentials,
    conversationId: string,
    messageId: string,
    emoji: string,
    active: boolean,
  ) {
    if (
      !objectId.test(conversationId) ||
      !objectId.test(messageId) ||
      !allowedReactions.has(emoji)
    )
      return invalid('Reaction is invalid.');
    const actor = await this.iam.getActor(credentials);
    await this.requireMessageActionRateLimit(actor);
    const result = await this.repository.setReaction(
      actor,
      conversationId,
      messageId,
      emoji,
      active,
    );
    await this.bumpHistoryVersion(actor, conversationId);
    await this.realtime.publishConversationEvent(
      'message.updated',
      actor.organizationId,
      conversationId,
      result.recipientIds,
      result.message,
    );
    return result.message;
  }

  async markRead(
    credentials: ChatCredentials,
    conversationId: string,
    body: unknown,
  ) {
    if (
      !objectId.test(conversationId) ||
      !isRecord(body) ||
      !exactKeys(body, ['messageId']) ||
      typeof body.messageId !== 'string' ||
      !objectId.test(body.messageId)
    )
      return invalid('Read state is invalid.');
    const actor = await this.iam.getActor(credentials);
    const state = await this.repository.markRead(
      actor,
      conversationId,
      body.messageId,
    );
    const recipients = (
      await this.repository.memberIds(actor, conversationId)
    ).filter((userId) => userId !== actor.id);
    await this.realtime.publishConversationEvent(
      'read.changed',
      actor.organizationId,
      conversationId,
      recipients,
      state,
    );
    return state;
  }

  async markDelivered(
    credentials: ChatCredentials,
    conversationId: string,
    body: unknown,
  ) {
    if (
      !objectId.test(conversationId) ||
      !isRecord(body) ||
      !exactKeys(body, ['messageId']) ||
      typeof body.messageId !== 'string' ||
      !objectId.test(body.messageId)
    )
      return invalid('Delivery state is invalid.');
    const actor = await this.iam.getActor(credentials);
    const state = await this.repository.markDelivered(
      actor,
      conversationId,
      body.messageId,
    );
    const recipients = (
      await this.repository.memberIds(actor, conversationId)
    ).filter((id) => id !== actor.id);
    await this.realtime.publishConversationEvent(
      'delivery.changed',
      actor.organizationId,
      conversationId,
      recipients,
      state,
    );
    return state;
  }

  async createWsTicket(credentials: ChatCredentials) {
    const actor = await this.iam.getActor(credentials);
    const binding = this.iam.getSessionBinding(credentials);
    if (
      !(await this.redis.consumeRateLimit(
        this.redisKey(`ws-ticket-rate:${actor.id}`),
        10,
        60,
      ))
    ) {
      throw new HttpException(
        {
          code: 'CHAT_RATE_LIMITED',
          message: 'Too many realtime connections were requested.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = Math.min(
      binding.expiresAt,
      Date.now() + ticketLifetimeSeconds * 1000,
    );
    const stored: ChatWsTicket = {
      actor,
      tokenHash: binding.tokenHash,
      expiresAt: binding.expiresAt,
    };
    const saved = await this.redis.setIfAbsent(
      this.redisKey(
        `ws-ticket:${createHash('sha256').update(ticket).digest('hex')}`,
      ),
      JSON.stringify(stored),
      Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)),
    );
    if (!saved) {
      throw new ServiceUnavailableException({
        code: 'CHAT_REALTIME_UNAVAILABLE',
        message: 'Realtime chat is unavailable.',
      });
    }
    return {
      ticket,
      expiresInSeconds: Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)),
    };
  }

  async consumeWsTicket(ticket: string): Promise<ChatWsTicket | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
    const hash = createHash('sha256').update(ticket).digest('hex');
    const value = await this.redis.consume(this.redisKey(`ws-ticket:${hash}`));
    if (!value) return null;
    try {
      const stored = JSON.parse(value) as unknown;
      if (
        !isRecord(stored) ||
        !isRecord(stored.actor) ||
        typeof stored.actor.id !== 'string' ||
        typeof stored.actor.organizationId !== 'string' ||
        typeof stored.actor.name !== 'string' ||
        typeof stored.tokenHash !== 'string' ||
        typeof stored.expiresAt !== 'number' ||
        stored.expiresAt <= Date.now()
      )
        return null;
      return stored as unknown as ChatWsTicket;
    } catch {
      return null;
    }
  }

  async requireSocketMember(
    actor: ChatActor,
    conversationId: string,
  ): Promise<void> {
    if (
      !objectId.test(conversationId) ||
      !(await this.repository.isMember(actor, conversationId))
    ) {
      throw new UnprocessableEntityException({
        code: 'CHAT_CONVERSATION_UNAVAILABLE',
        message: 'Conversation is unavailable.',
      });
    }
  }

  async socketMemberIds(
    actor: ChatActor,
    conversationId: string,
  ): Promise<string[]> {
    return this.repository.memberIds(actor, conversationId);
  }

  async watchableContacts(
    actor: ChatActor,
    userIds: string[],
  ): Promise<string[]> {
    if (userIds.length > 100 || !userIds.every((id) => objectId.test(id))) {
      return invalid('Presence watch list is invalid.');
    }
    const contacts = await this.repository.directContactIds(actor, userIds);
    return [...contacts];
  }

  async emitTyping(
    actor: ChatActor,
    conversationId: string,
    isTyping: boolean,
  ) {
    await this.requireSocketMember(actor, conversationId);
    const recipients = (
      await this.repository.memberIds(actor, conversationId)
    ).filter((userId) => userId !== actor.id);
    await this.realtime.publishConversationEvent(
      'typing',
      actor.organizationId,
      conversationId,
      recipients,
      { conversationId, userId: actor.id, displayName: actor.name, isTyping },
    );
  }

  handleAiAccountMessage(): never {
    // TODO: Route AI-account messages to the approved AI services when enabled.
    throw new ServiceUnavailableException({
      code: 'CHAT_AI_NOT_ENABLED',
      message: 'AI chat is not enabled.',
    });
  }

  private async requireMessageActionRateLimit(actor: ChatActor): Promise<void> {
    if (
      !(await this.redis.consumeRateLimit(
        this.redisKey(`message-action:${actor.organizationId}:${actor.id}`),
        120,
        60,
      ))
    ) {
      throw new HttpException(
        {
          code: 'CHAT_RATE_LIMITED',
          message: 'Too many message changes. Try again shortly.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async validateMentions(
    actor: ChatActor,
    conversationId: string,
    value: unknown,
  ): Promise<string[]> {
    if (value === undefined) return [];
    if (
      !Array.isArray(value) ||
      value.length > 50 ||
      !value.every(
        (entry): entry is string =>
          typeof entry === 'string' && objectId.test(entry),
      ) ||
      new Set(value).size !== value.length
    )
      return invalid('Mentions are invalid.');
    if (!value.length) return [];
    if (!(await this.repository.isMember(actor, conversationId)))
      throw new NotFoundException({
        code: 'CHAT_CONVERSATION_NOT_FOUND',
        message: 'Conversation not found.',
      });
    const members = await this.repository.memberIds(actor, conversationId);
    if (value.some((entry) => !members.includes(entry)))
      return invalid('Mentioned people must be active conversation members.');
    return value;
  }

  private redisKey(key: string): string {
    return `${this.redisPrefix}:${key}`;
  }

  private async bumpHistoryVersion(actor: ChatActor, conversationId: string) {
    try {
      await this.redis.increment(
        this.redisKey(
          `history-version:${actor.organizationId}:${conversationId}`,
        ),
        24 * 60 * 60,
      );
    } catch {
      // Cached pages expire quickly; persistent writes must not depend on Redis.
    }
  }

  private storage(provider: 'S3' | 'R2') {
    return provider === 'S3' ? this.s3 : this.r2;
  }
}
