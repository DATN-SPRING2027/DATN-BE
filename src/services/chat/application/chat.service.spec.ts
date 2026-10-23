import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { Readable } from 'node:stream';
import type { ChatActor, ChatRepository } from './chat.repository';
import type { ChatIamClient } from './chat-iam.client';
import type { ChatRealtimeService } from './chat-realtime.service';
import { ChatApplicationService } from './chat.service';
import type { RedisService } from '../infrastructure/redis/redis.service';
import type { R2Storage } from '../infrastructure/storage/r2.storage';
import type { S3Storage } from '../infrastructure/storage/s3.storage';

describe('ChatApplicationService', () => {
  const actor: ChatActor = {
    id: '507f1f77bcf86cd799439012',
    organizationId: '507f1f77bcf86cd799439011',
    name: 'Member',
    avatarUrl: null,
  };

  function createService() {
    const isMember = jest.fn().mockResolvedValue(true);
    const listMessages = jest
      .fn()
      .mockResolvedValue({ data: [], nextCursor: null });
    const createUpload = jest.fn().mockResolvedValue(undefined);
    const getUpload = jest.fn();
    const messagesAround = jest
      .fn()
      .mockResolvedValue({ data: [], nextCursor: null });
    const listConversations = jest
      .fn()
      .mockResolvedValue({ data: [], nextCursor: null });
    const searchMessages = jest
      .fn()
      .mockResolvedValue({ data: [], nextCursor: null });
    const repository = {
      messagesAround,
      listConversations,
      searchMessages,
      isMember,
      listMessages,
      createUpload,
      getUpload,
    } as unknown as jest.Mocked<ChatRepository>;
    const iam = {
      getActor: jest.fn().mockResolvedValue(actor),
      searchCandidates: jest.fn(),
      getCandidates: jest.fn(),
    } as unknown as jest.Mocked<ChatIamClient>;
    const redis = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined),
      increment: jest.fn().mockResolvedValue(1),
      consumeRateLimit: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<RedisService>;
    const realtime = {
      publishConversationEvent: jest.fn().mockResolvedValue(undefined),
      isOnline: jest.fn().mockResolvedValue(false),
    } as unknown as ChatRealtimeService;
    const r2PutObject = jest.fn().mockResolvedValue(undefined);
    const s3PutObject = jest.fn().mockResolvedValue(undefined);
    const r2DeleteObject = jest.fn().mockResolvedValue(undefined);
    const s3DeleteObject = jest.fn().mockResolvedValue(undefined);
    const r2 = {
      putObject: r2PutObject,
      deleteObject: r2DeleteObject,
    } as unknown as jest.Mocked<R2Storage>;
    const s3 = {
      putObject: s3PutObject,
      deleteObject: s3DeleteObject,
    } as unknown as jest.Mocked<S3Storage>;
    const config = {
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;
    return {
      service: new ChatApplicationService(
        repository,
        iam,
        redis,
        realtime,
        r2,
        s3,
        config,
      ),
      repository,
      iam,
      messagesAround,
      listConversations,
      searchMessages,
      redis,
      isMember,
      listMessages,
      createUpload,
      getUpload,
      r2PutObject,
      s3PutObject,
      r2DeleteObject,
      s3DeleteObject,
    };
  }

  it('passes a trimmed conversation search to the organization-scoped repository', async () => {
    const { service, listConversations } = createService();
    await service.listConversations(
      { authorization: 'Bearer test' },
      { search: '  Planning  ' },
    );
    expect(listConversations).toHaveBeenCalledWith(
      actor,
      40,
      undefined,
      'Planning',
      false,
    );
    await expect(
      service.listConversations({}, { search: 'x'.repeat(81) }),
    ).rejects.toMatchObject({ status: 422 });
  });
  it('does not resolve mention targets for a non-member', async () => {
    const { service, isMember } = createService();
    isMember.mockResolvedValue(false);
    await expect(
      service.sendMessage({}, '507f1f77bcf86cd799439003', {
        clientMessageId: 'bb077bf1-0897-499d-9b82-d57510ff3b5d',
        content: 'hello',
        mentionUserIds: ['507f1f77bcf86cd799439004'],
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('preserves indexed candidate ranking while revalidating cached candidate membership', async () => {
    const { service, redis, iam } = createService();
    const first = {
      id: '507f1f77bcf86cd799439003',
      fullName: 'First',
      avatarUrl: null,
    };
    const second = {
      id: '507f1f77bcf86cd799439004',
      fullName: 'Second',
      avatarUrl: null,
    };
    redis.get.mockResolvedValue(JSON.stringify([first.id, second.id]));
    iam.getCandidates.mockResolvedValue({ actor, data: [second, first] });
    const result = await service.searchCandidates({}, 'member');
    expect(result.data.map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(iam.getCandidates.mock.calls[0]).toEqual([
      {},
      [first.id, second.id],
    ]);
    expect(iam.searchCandidates.mock.calls).toHaveLength(0);
  });

  it('lists organization member candidates when search is omitted or empty', async () => {
    const { service, redis, iam } = createService();
    const candidate = {
      id: '507f1f77bcf86cd799439003',
      fullName: 'First Member',
      email: 'first@datn.edu.vn',
      avatarUrl: null,
    };
    redis.get.mockResolvedValue(null);
    iam.searchCandidates.mockResolvedValue({
      actorId: actor.id,
      organizationId: actor.organizationId,
      data: [candidate],
    });
    const result = await service.searchCandidates({}, undefined);
    expect(iam.searchCandidates.mock.calls).toEqual([[{}, '']]);
    expect(result.data).toEqual([{ ...candidate, isOnline: false }]);
  });

  it('passes message search and its cursor to the member-scoped repository', async () => {
    const { service, searchMessages } = createService();
    const conversationId = '507f1f77bcf86cd799439013';
    await service.searchMessages({}, conversationId, {
      q: '  kế hoạch  ',
      limit: '30',
    });
    expect(searchMessages).toHaveBeenCalledWith(
      actor,
      conversationId,
      'kế hoạch',
      30,
      undefined,
    );
  });

  it('loads a member-checked context without serving the unrelated latest-history cache', async () => {
    const { service, redis, messagesAround, isMember } = createService();
    const conversationId = '507f1f77bcf86cd799439013';
    const aroundMessageId = '507f1f77bcf86cd799439014';
    await service.listMessages({}, conversationId, { aroundMessageId });
    expect(messagesAround).toHaveBeenCalledWith(
      actor,
      conversationId,
      aroundMessageId,
      50,
    );
    expect(redis.get.mock.calls).toHaveLength(0);
    isMember.mockResolvedValue(false);
    await expect(
      service.listMessages({}, conversationId, { aroundMessageId }),
    ).rejects.toMatchObject({ status: 404 });
    expect(messagesAround).toHaveBeenCalledTimes(1);
    await expect(
      service.listMessages({}, conversationId, { aroundMessageId: 'bad' }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('serves a membership-checked history page from the actor-scoped Redis cache', async () => {
    const { service, isMember, listMessages, redis } = createService();
    const cached = { data: [{ id: 'message' }], nextCursor: null };
    redis.get.mockImplementation((key: string) =>
      Promise.resolve(
        key.includes('history-version') ? '7' : JSON.stringify(cached),
      ),
    );

    const result = await service.listMessages(
      { authorization: 'Bearer test' },
      '507f1f77bcf86cd799439013',
      {},
    );

    expect(isMember).toHaveBeenCalledWith(actor, '507f1f77bcf86cd799439013');
    expect(result).toEqual(cached);
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('routes image uploads to S3 and documents to R2', async () => {
    const { service, createUpload } = createService();
    const credentials = { authorization: 'Bearer test' };
    const conversationId = '507f1f77bcf86cd799439013';

    const image = await service.createUpload(credentials, conversationId, {
      name: 'photo.png',
      contentType: 'image/png',
      size: 128,
    });
    const document = await service.createUpload(credentials, conversationId, {
      name: 'notes.pdf',
      contentType: 'application/pdf',
      size: 256,
    });

    expect(image).toMatchObject({ provider: 'S3' });
    expect(document).toMatchObject({ provider: 'R2' });
    expect(createUpload).toHaveBeenCalledTimes(2);
  });

  it('streams S3 images and R2 documents to their selected providers', async () => {
    const { service, getUpload, s3PutObject, r2PutObject } = createService();
    const conversationId = '507f1f77bcf86cd799439013';
    const image = {
      id: '11234567-89ab-4cde-8fab-0123456789ab',
      conversationId,
      uploaderId: actor.id,
      name: 'photo.png',
      contentType: 'image/png',
      size: 4,
      kind: 'IMAGE' as const,
      provider: 'S3' as const,
      objectKey: 'chat/image',
      status: 'PENDING' as const,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const document = {
      ...image,
      id: '21234567-89ab-4cde-8fab-0123456789ab',
      name: 'notes.pdf',
      contentType: 'application/pdf',
      kind: 'DOCUMENT' as const,
      provider: 'R2' as const,
      objectKey: 'chat/document',
    };
    getUpload.mockResolvedValueOnce(image).mockResolvedValueOnce(document);

    await expect(
      service.uploadContent(
        { authorization: 'Bearer test' },
        conversationId,
        image.id,
        Readable.from([Buffer.from('img!')]),
      ),
    ).resolves.toMatchObject({ uploadId: image.id, status: 'UPLOADED' });
    await expect(
      service.uploadContent(
        { authorization: 'Bearer test' },
        conversationId,
        document.id,
        Readable.from([Buffer.from('pdf!')]),
      ),
    ).resolves.toMatchObject({ uploadId: document.id, status: 'UPLOADED' });

    expect(s3PutObject).toHaveBeenCalledWith(
      image.objectKey,
      expect.any(Readable),
      image.contentType,
      image.size,
    );
    expect(r2PutObject).toHaveBeenCalledWith(
      document.objectKey,
      expect.any(Readable),
      document.contentType,
      document.size,
    );
  });

  it('rejects and removes a streamed object when byte count differs', async () => {
    const { service, getUpload, s3PutObject, s3DeleteObject } = createService();
    const upload = {
      id: '11234567-89ab-4cde-8fab-0123456789ab',
      conversationId: '507f1f77bcf86cd799439013',
      uploaderId: actor.id,
      name: 'photo.png',
      contentType: 'image/png',
      size: 4,
      kind: 'IMAGE' as const,
      provider: 'S3' as const,
      objectKey: 'chat/image',
      status: 'PENDING' as const,
      expiresAt: new Date(Date.now() + 60_000),
    };
    getUpload.mockResolvedValue(upload);

    await expect(
      service.uploadContent(
        { authorization: 'Bearer test' },
        upload.conversationId,
        upload.id,
        Readable.from([Buffer.from('short')]),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(s3PutObject).toHaveBeenCalledTimes(1);
    expect(s3DeleteObject).toHaveBeenCalledWith(upload.objectKey);
  });
});
