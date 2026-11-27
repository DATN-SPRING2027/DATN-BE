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
import type { NotificationService } from '../../notification/notification.service';

function buildMinimalZip(
  entries: {
    name: string;
    content: Buffer;
    claimedUncompressedSize?: number;
  }[],
): Buffer {
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(entry.content.length, 18);
    local.writeUInt32LE(
      entry.claimedUncompressedSize ?? entry.content.length,
      22,
    );
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(entry.content.length, 20);
    cd.writeUInt32LE(entry.claimedUncompressedSize ?? entry.content.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);

    localParts.push(local, entry.content);
    cdParts.push(cd);
    offset += local.length + entry.content.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

describe('ChatApplicationService', () => {
  const actor: ChatActor = {
    id: '507f1f77bcf86cd799439012',
    organizationId: '507f1f77bcf86cd799439011',
    name: 'Member',
    avatarUrl: null,
  };

  function createService() {
    const isMember = jest.fn().mockResolvedValue(true);
    const memberIds = jest
      .fn()
      .mockResolvedValue([
        actor.id,
        '507f1f77bcf86cd799439003',
        '507f1f77bcf86cd799439004',
      ]);
    const listMessages = jest
      .fn()
      .mockResolvedValue({ data: [], nextCursor: null });
    const createUpload = jest.fn().mockResolvedValue(undefined);
    const getUpload = jest.fn();
    const getAttachmentObject = jest.fn();
    const editMessage = jest.fn();
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
      memberIds,
      listMessages,
      createUpload,
      getUpload,
      getAttachmentObject,
      editMessage,
    } as unknown as jest.Mocked<ChatRepository>;
    const redis = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined),
      increment: jest.fn().mockResolvedValue(1),
      consumeRateLimit: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<RedisService>;
    const realtimeIsOnline = jest.fn().mockResolvedValue(false);
    const realtimeAreOnlineBatch = jest
      .fn()
      .mockResolvedValue(new Map<string, boolean>());
    const realtime = {
      publishConversationEvent: jest.fn().mockResolvedValue(undefined),
      isOnline: realtimeIsOnline,
      areOnlineBatch: realtimeAreOnlineBatch,
      evictConversationMembers: jest.fn().mockResolvedValue(undefined),
    } as unknown as ChatRealtimeService;
    const r2PutObject = jest.fn(async (_k: string, body: Readable) => {
      for await (const chunk of body) {
        void chunk;
      }
    });
    const s3PutObject = jest.fn(async (_k: string, body: Readable) => {
      for await (const chunk of body) {
        void chunk;
      }
    });
    const r2DeleteObject = jest.fn().mockResolvedValue(undefined);
    const s3DeleteObject = jest.fn().mockResolvedValue(undefined);
    const r2CreateDownloadUrl = jest.fn();
    const s3CreateDownloadUrl = jest.fn();
    const r2OpenReadStream = jest.fn();
    const s3OpenReadStream = jest.fn();
    const r2 = {
      putObject: r2PutObject,
      deleteObject: r2DeleteObject,
      createDownloadUrl: r2CreateDownloadUrl,
      openReadStream: r2OpenReadStream,
    } as unknown as jest.Mocked<R2Storage>;
    const s3 = {
      putObject: s3PutObject,
      deleteObject: s3DeleteObject,
      createDownloadUrl: s3CreateDownloadUrl,
      openReadStream: s3OpenReadStream,
    } as unknown as jest.Mocked<S3Storage>;
    const config = {
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;
    const notifyChatMention = jest.fn().mockResolvedValue(undefined);
    const notificationService = {
      notifyChatMention,
    } as unknown as NotificationService;
    const iamGetActor = jest.fn().mockResolvedValue(actor);
    const iamSearchCandidates = jest.fn();
    const iamGetCandidates = jest.fn();
    return {
      service: new ChatApplicationService(
        repository,
        {
          getActor: iamGetActor,
          searchCandidates: iamSearchCandidates,
          getCandidates: iamGetCandidates,
        } as unknown as ChatIamClient,
        redis,
        realtime,
        r2,
        s3,
        config,
        notificationService,
      ),
      repository,
      iam: {
        getActor: iamGetActor,
        searchCandidates: iamSearchCandidates,
        getCandidates: iamGetCandidates,
      },
      realtimeIsOnline,
      realtimeAreOnlineBatch,
      notifyChatMention,
      messagesAround,
      listConversations,
      searchMessages,
      redis,
      isMember,
      listMessages,
      createUpload,
      getUpload,
      getAttachmentObject,
      editMessage,
      r2PutObject,
      s3PutObject,
      r2DeleteObject,
      s3DeleteObject,
      r2CreateDownloadUrl,
      s3CreateDownloadUrl,
      r2OpenReadStream,
      s3OpenReadStream,
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

  it('uses batched presence lookup for listConversations and searchCandidates (BE-PERF-007)', async () => {
    const {
      service,
      listConversations,
      realtimeIsOnline,
      realtimeAreOnlineBatch,
    } = createService();
    listConversations.mockResolvedValue({
      data: [
        {
          id: 'c1',
          type: 'DIRECT',
          title: null,
          createdBy: actor.id,
          lastMessageAt: null,
          lastMessagePreview: '',
          lastMessageSenderId: null,
          lastReadMessageId: null,
          lastReadAt: null,
          unreadCount: 0,
          members: [
            {
              userId: actor.id,
              displayName: 'Me',
              avatarUrl: null,
              role: 'OWNER',
              lastReadMessageId: null,
              lastReadAt: null,
              lastDeliveredMessageId: null,
              lastDeliveredAt: null,
            },
            {
              userId: '507f1f77bcf86cd799439003',
              displayName: 'Peer 1',
              avatarUrl: null,
              role: 'MEMBER',
              lastReadMessageId: null,
              lastReadAt: null,
              lastDeliveredMessageId: null,
              lastDeliveredAt: null,
            },
          ],
        },
        {
          id: 'c2',
          type: 'DIRECT',
          title: null,
          createdBy: actor.id,
          lastMessageAt: null,
          lastMessagePreview: '',
          lastMessageSenderId: null,
          lastReadMessageId: null,
          lastReadAt: null,
          unreadCount: 0,
          members: [
            {
              userId: '507f1f77bcf86cd799439004',
              displayName: 'Peer 2',
              avatarUrl: null,
              role: 'MEMBER',
              lastReadMessageId: null,
              lastReadAt: null,
              lastDeliveredMessageId: null,
              lastDeliveredAt: null,
            },
          ],
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    realtimeAreOnlineBatch.mockResolvedValue(
      new Map([
        ['507f1f77bcf86cd799439003', true],
        ['507f1f77bcf86cd799439004', false],
      ]),
    );

    const res = await service.listConversations({}, {});
    expect(realtimeAreOnlineBatch).toHaveBeenCalledTimes(1);
    expect(realtimeAreOnlineBatch).toHaveBeenCalledWith(actor.organizationId, [
      '507f1f77bcf86cd799439003',
      '507f1f77bcf86cd799439004',
    ]);
    expect(realtimeIsOnline).not.toHaveBeenCalled();
    expect(res.data[0].members[1].isOnline).toBe(true);
    expect(res.data[1].members[0].isOnline).toBe(false);
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

  it('checks rate limits BEFORE calling IAM searchCandidates / getCandidates (SEC-BE-012)', async () => {
    const { service, redis, iam } = createService();
    redis.consumeRateLimit.mockResolvedValue(false);

    await expect(service.searchCandidates({}, 'alice')).rejects.toMatchObject({
      status: 429,
    });
    expect(iam.searchCandidates).not.toHaveBeenCalled();

    await expect(
      service.createDirect({}, { participantId: '507f1f77bcf86cd799439003' }),
    ).rejects.toMatchObject({ status: 429 });
    expect(iam.getCandidates).not.toHaveBeenCalled();
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

  it('streams valid magic-byte S3 images, R2 PDFs, and OOXML DOCX archives to their selected providers', async () => {
    const { service, getUpload, s3PutObject, r2PutObject } = createService();
    const conversationId = '507f1f77bcf86cd799439013';
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    const pdfBytes = Buffer.from('%PDF-1.7\nhello');
    const docxBytes = buildMinimalZip([
      { name: '[Content_Types].xml', content: Buffer.from('<Types/>') },
      { name: 'word/document.xml', content: Buffer.from('<w:document/>') },
    ]);

    const image = {
      id: '11234567-89ab-4cde-8fab-0123456789ab',
      conversationId,
      uploaderId: actor.id,
      name: 'photo.png',
      contentType: 'image/png',
      size: pngBytes.length,
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
      size: pdfBytes.length,
      kind: 'DOCUMENT' as const,
      provider: 'R2' as const,
      objectKey: 'chat/document',
    };
    const docx = {
      ...document,
      id: '31234567-89ab-4cde-8fab-0123456789ab',
      name: 'spec.docx',
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: docxBytes.length,
      objectKey: 'chat/docx',
    };
    getUpload
      .mockResolvedValueOnce(image)
      .mockResolvedValueOnce(document)
      .mockResolvedValueOnce(docx);

    await expect(
      service.uploadContent(
        { authorization: 'Bearer test' },
        conversationId,
        image.id,
        Readable.from([pngBytes]),
      ),
    ).resolves.toMatchObject({ uploadId: image.id, status: 'UPLOADED' });
    await expect(
      service.uploadContent(
        { authorization: 'Bearer test' },
        conversationId,
        document.id,
        Readable.from([pdfBytes]),
      ),
    ).resolves.toMatchObject({ uploadId: document.id, status: 'UPLOADED' });
    await expect(
      service.uploadContent(
        { authorization: 'Bearer test' },
        conversationId,
        docx.id,
        Readable.from([docxBytes]),
      ),
    ).resolves.toMatchObject({ uploadId: docx.id, status: 'UPLOADED' });

    expect(s3PutObject).toHaveBeenCalledWith(
      image.objectKey,
      expect.any(Readable),
      image.contentType,
      image.size,
    );
    expect(r2PutObject).toHaveBeenCalledTimes(2);
  });

  it('rejects spoofed magic bytes, SVG/HTML polyglots, raw non-OOXML ZIPs, and ZIP bombs (SEC-BE-002)', async () => {
    const { service, getUpload, s3DeleteObject, r2DeleteObject } =
      createService();
    const conversationId = '507f1f77bcf86cd799439013';

    // 1. SVG masquerading as image/png
    const svgPayload = Buffer.from('<svg onload=alert(1)></svg>');
    const badPng = {
      id: '11234567-89ab-4cde-8fab-0123456789ab',
      conversationId,
      uploaderId: actor.id,
      name: 'evil.png',
      contentType: 'image/png',
      size: svgPayload.length,
      kind: 'IMAGE' as const,
      provider: 'S3' as const,
      objectKey: 'chat/evil-png',
      status: 'PENDING' as const,
      expiresAt: new Date(Date.now() + 60_000),
    };
    getUpload.mockResolvedValueOnce(badPng);
    await expect(
      service.uploadContent(
        {},
        conversationId,
        badPng.id,
        Readable.from([svgPayload]),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(s3DeleteObject).toHaveBeenCalledWith(badPng.objectKey);

    // 2. HTML/script masquerading as text/plain
    const htmlPayload = Buffer.from('<html><script>alert(1)</script></html>');
    const badTxt = {
      ...badPng,
      id: '21234567-89ab-4cde-8fab-0123456789ab',
      name: 'evil.txt',
      contentType: 'text/plain',
      size: htmlPayload.length,
      kind: 'DOCUMENT' as const,
      provider: 'R2' as const,
      objectKey: 'chat/evil-txt',
    };
    getUpload.mockResolvedValueOnce(badTxt);
    await expect(
      service.uploadContent(
        {},
        conversationId,
        badTxt.id,
        Readable.from([htmlPayload]),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(r2DeleteObject).toHaveBeenCalledWith(badTxt.objectKey);

    // 3. Raw ZIP without OOXML markers masquerading as .docx
    const rawZip = buildMinimalZip([
      { name: 'payload.js', content: Buffer.from('console.log(1)') },
    ]);
    const badDocx = {
      ...badTxt,
      id: '31234567-89ab-4cde-8fab-0123456789ab',
      name: 'fake.docx',
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: rawZip.length,
      objectKey: 'chat/fake-docx',
    };
    getUpload.mockResolvedValueOnce(badDocx);
    await expect(
      service.uploadContent(
        {},
        conversationId,
        badDocx.id,
        Readable.from([rawZip]),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    // 4. ZIP bomb claiming 200MB uncompressed from tiny compressed payload
    const zipBomb = buildMinimalZip([
      { name: '[Content_Types].xml', content: Buffer.from('<Types/>') },
      {
        name: 'word/document.xml',
        content: Buffer.from('aaaa'),
        claimedUncompressedSize: 200 * 1024 * 1024,
      },
    ]);
    const bombDocx = {
      ...badDocx,
      id: '41234567-89ab-4cde-8fab-0123456789ab',
      size: zipBomb.length,
      objectKey: 'chat/bomb-docx',
    };
    getUpload.mockResolvedValueOnce(bombDocx);
    await expect(
      service.uploadContent(
        {},
        conversationId,
        bombDocx.id,
        Readable.from([zipBomb]),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects and removes a streamed object when byte count differs', async () => {
    const { service, getUpload, s3PutObject, s3DeleteObject } = createService();
    const upload = {
      id: '11234567-89ab-4cde-8fab-0123456789ab',
      conversationId: '507f1f77bcf86cd799439013',
      uploaderId: actor.id,
      name: 'photo.png',
      contentType: 'image/png',
      size: 8,
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
        Readable.from([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]),
        ]),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(s3PutObject).toHaveBeenCalledTimes(1);
    expect(s3DeleteObject).toHaveBeenCalledWith(upload.objectKey);
  });

  it('passes attachment disposition and localStreamUrl when generating download URLs and opens streams cleanly (BE-DATA-002 / SEC-BE-002)', async () => {
    const {
      service,
      getAttachmentObject,
      r2CreateDownloadUrl,
      r2OpenReadStream,
    } = createService();
    const conversationId = '507f1f77bcf86cd799439013';
    const attachmentId = '11234567-89ab-4cde-8fab-0123456789ab';
    const expectedLocalUrl = `/api/v1/chat/conversations/${conversationId}/attachments/${attachmentId}/content`;

    getAttachmentObject.mockResolvedValue({
      provider: 'R2',
      objectKey: 'chat/org/conv/user/doc',
      name: 'report.pdf',
      contentType: 'application/pdf',
      kind: 'DOCUMENT',
    });
    r2CreateDownloadUrl.mockResolvedValue(expectedLocalUrl);

    const res = await service.getAttachmentDownloadUrl(
      {},
      conversationId,
      attachmentId,
    );
    expect(res).toEqual({ url: expectedLocalUrl, expiresInSeconds: 300 });
    expect(r2CreateDownloadUrl).toHaveBeenCalledWith(
      'chat/org/conv/user/doc',
      300,
      {
        contentType: 'application/octet-stream',
        contentDisposition: 'attachment',
        filename: 'report.pdf',
        localStreamUrl: expectedLocalUrl,
      },
    );

    const mockStream = Readable.from([Buffer.from('%PDF-1.7')]);
    r2OpenReadStream.mockResolvedValue({
      stream: mockStream,
      size: 8,
      contentType: 'application/pdf',
    });
    const opened = await service.getAttachmentStream(
      {},
      conversationId,
      attachmentId,
    );
    expect(opened.stream).toBe(mockStream);
    expect(opened.contentType).toBe('application/octet-stream');
    expect(opened.filename).toBe('report.pdf');
    expect(opened.size).toBe(8);
  });

  it('diffs mentionUserIds on editMessage so already-mentioned users are not re-notified (SEC-BE-017)', async () => {
    const { service, editMessage, notifyChatMention } = createService();
    const conversationId = '507f1f77bcf86cd799439013';
    const messageId = '507f1f77bcf86cd799439014';

    // Edit keeping the same mention -> newlyMentionedUserIds is empty -> zero notifications
    editMessage.mockResolvedValueOnce({
      message: { id: messageId, content: 'updated' },
      recipientIds: [actor.id, '507f1f77bcf86cd799439003'],
      newlyMentionedUserIds: [],
    });
    await service.editMessage({}, conversationId, messageId, {
      content: 'updated',
      mentionUserIds: ['507f1f77bcf86cd799439003'],
    });
    expect(notifyChatMention).not.toHaveBeenCalled();

    // Edit adding a second mention -> notifies ONLY the newly added user
    editMessage.mockResolvedValueOnce({
      message: { id: messageId, content: 'updated 2' },
      recipientIds: [
        actor.id,
        '507f1f77bcf86cd799439003',
        '507f1f77bcf86cd799439004',
      ],
      newlyMentionedUserIds: ['507f1f77bcf86cd799439004'],
    });
    await service.editMessage({}, conversationId, messageId, {
      content: 'updated 2',
      mentionUserIds: ['507f1f77bcf86cd799439003', '507f1f77bcf86cd799439004'],
    });
    expect(notifyChatMention).toHaveBeenCalledTimes(1);
    expect(notifyChatMention).toHaveBeenCalledWith({
      actorId: actor.id,
      mentionedUserIds: ['507f1f77bcf86cd799439004'],
      organizationId: actor.organizationId,
      conversationId,
      messageId,
    });
  });
});
