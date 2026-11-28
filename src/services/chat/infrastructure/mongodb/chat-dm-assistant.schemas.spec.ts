import { Mongoose, Types } from 'mongoose';
import { CHAT_PERSISTENCE } from '../persistence';
import {
  CHAT_ASSISTANT_JOBS_COLLECTION,
  CONTINUUM_AI_DISPLAY_NAME,
  CONTINUUM_AI_HANDLE,
  CONTINUUM_AI_SENDER_ID,
  createCollectionSchema,
} from './mongodb.schemas';

describe('Chat DM Assistant MongoDB schemas and persistence declarations', () => {
  const mongooseInstance = new Mongoose();
  const findCollection = (name: string) => {
    const definition = CHAT_PERSISTENCE.collections.find(
      (collection) => collection.name === name,
    );
    if (!definition) {
      throw new Error(`Missing collection definition: ${name}`);
    }
    return definition;
  };

  const ConversationModel = mongooseInstance.model(
    'test_chat_conversations',
    createCollectionSchema(findCollection('chat_conversations')),
  );
  const MemberModel = mongooseInstance.model(
    'test_chat_members',
    createCollectionSchema(findCollection('chat_members')),
  );
  const MessageModel = mongooseInstance.model(
    'test_chat_conversation_messages',
    createCollectionSchema(findCollection('chat_conversation_messages')),
  );
  const AssistantJobModel = mongooseInstance.model(
    'test_chat_assistant_jobs',
    createCollectionSchema(findCollection(CHAT_ASSISTANT_JOBS_COLLECTION)),
  );

  const orgId = new Types.ObjectId('507f1f77bcf86cd799439001');
  const conversationId = new Types.ObjectId('507f1f77bcf86cd799439002');
  const triggerMessageId = new Types.ObjectId('507f1f77bcf86cd799439003');
  const sourceMessageId = new Types.ObjectId('507f1f77bcf86cd799439004');
  const userId = '507f1f77bcf86cd799439011';

  it('preserves existing chat_conversation_messages indexes and declares all additive DM assistant indexes', () => {
    const messagesDef = findCollection('chat_conversation_messages');
    const messageIndexes = messagesDef.indexes ?? [];
    expect(messageIndexes).toHaveLength(7);

    // Existing indexes preserved untouched
    expect(
      messageIndexes.some(
        (idx) =>
          JSON.stringify(idx.fields) ===
          JSON.stringify({ conversationId: 1, createdAt: -1, _id: -1 }),
      ),
    ).toBe(true);
    expect(
      messageIndexes.find(
        (idx) => idx.options?.name === 'chat_message_text_search',
      ),
    ).toEqual({
      fields: { conversationId: 1, content: 'text' },
      options: { name: 'chat_message_text_search' },
    });
    expect(
      messageIndexes.some(
        (idx) =>
          JSON.stringify(idx.fields) ===
            JSON.stringify({
              conversationId: 1,
              senderId: 1,
              clientMessageId: 1,
            }) && idx.options?.unique === true,
      ),
    ).toBe(true);
    expect(
      messageIndexes.find(
        (idx) => idx.options?.name === 'chat_messages_pinned_partial',
      ),
    ).toEqual({
      fields: { conversationId: 1, isPinned: 1, createdAt: -1 },
      options: {
        name: 'chat_messages_pinned_partial',
        partialFilterExpression: { isPinned: true },
      },
    });
    expect(
      messageIndexes.find(
        (idx) => idx.options?.name === 'chat_messages_attachments_kind_partial',
      ),
    ).toEqual({
      fields: { conversationId: 1, 'attachments.kind': 1, createdAt: -1 },
      options: {
        name: 'chat_messages_attachments_kind_partial',
        partialFilterExpression: { 'attachments.kind': { $exists: true } },
      },
    });

    // New additive assistant indexes
    const triggerUnique = messageIndexes.find(
      (idx) => idx.options?.name === 'chat_messages_assistant_trigger_unique',
    );
    expect(triggerUnique).toEqual({
      fields: { conversationId: 1, triggerMessageId: 1 },
      options: {
        name: 'chat_messages_assistant_trigger_unique',
        unique: true,
        partialFilterExpression: {
          authorType: 'ASSISTANT',
          triggerMessageId: { $type: 'objectId' },
        },
      },
    });

    const sourceRefsIdx = messageIndexes.find(
      (idx) => idx.options?.name === 'chat_messages_assistant_source_refs_idx',
    );
    expect(sourceRefsIdx).toEqual({
      fields: { conversationId: 1, 'sourceReferences.messageId': 1 },
      options: {
        name: 'chat_messages_assistant_source_refs_idx',
        partialFilterExpression: { authorType: 'ASSISTANT' },
      },
    });

    // New chat_assistant_jobs collection & 4 indexes
    const jobsDef = findCollection(CHAT_ASSISTANT_JOBS_COLLECTION);
    expect(jobsDef.indexes).toEqual([
      {
        fields: { triggerMessageId: 1 },
        options: { name: 'chat_assistant_jobs_trigger_unique', unique: true },
      },
      {
        fields: {
          status: 1,
          nextAttemptAt: 1,
          lockedUntil: 1,
          createdAt: 1,
          _id: 1,
        },
        options: { name: 'chat_assistant_jobs_claim_idx' },
      },
      {
        fields: { organizationId: 1, conversationId: 1, triggerMessageId: 1 },
        options: { name: 'chat_assistant_jobs_conv_trigger_idx' },
      },
      {
        fields: {
          organizationId: 1,
          conversationId: 1,
          status: 1,
          createdAt: -1,
        },
        options: { name: 'chat_assistant_jobs_conv_status_created_idx' },
      },
    ]);

    // Schema cloning does not duplicate indexes
    const jobsSchemaA = createCollectionSchema(jobsDef);
    const jobsSchemaB = createCollectionSchema(jobsDef);
    expect(jobsSchemaA).not.toBe(jobsSchemaB);
    expect(jobsSchemaA.indexes()).toHaveLength(4);
    expect(jobsSchemaB.indexes()).toHaveLength(4);
  });

  it('defaults contextRevision on chat_conversations and draftAssistantMention on chat_members', async () => {
    const conversation = new ConversationModel({
      organizationId: orgId,
      type: 'DIRECT',
      directKey: `${String(orgId)}:a:b`,
      createdBy: userId,
    });
    await expect(conversation.validate()).resolves.toBeUndefined();
    expect(conversation.get('contextRevision')).toBe(0);

    const invalidRevision = new ConversationModel({
      organizationId: orgId,
      type: 'DIRECT',
      createdBy: userId,
      contextRevision: 1.5,
    });
    await expect(invalidRevision.validate()).rejects.toThrow(/integer/i);

    const member = new MemberModel({
      organizationId: orgId,
      conversationId,
      userId,
      displayName: 'Nguyễn An',
      role: 'OWNER',
    });
    await expect(member.validate()).resolves.toBeUndefined();
    expect(member.get('draftAssistantMention')).toBe(false);
  });

  it('keeps human messages strictly backward-compatible and omits sourceReferences by default', async () => {
    const humanDoc = new MessageModel({
      organizationId: orgId,
      conversationId,
      senderId: userId,
      senderName: 'Nguyễn An',
      clientMessageId: 'human-msg-1',
      content: 'Hôm qua hai người chốt những gì?',
    });
    await expect(humanDoc.validate()).resolves.toBeUndefined();
    const raw = humanDoc.toObject() as Record<string, unknown>;
    expect(raw.contentVersion).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(raw, 'sourceReferences')).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(raw, 'authorType')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(raw, 'triggerMessageId')).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(raw, 'assistantStatus')).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(raw, 'assistantMeta')).toBe(
      false,
    );
    expect(
      Object.prototype.hasOwnProperty.call(raw, 'assistantFailureCode'),
    ).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(raw, 'assistantMention')).toBe(
      false,
    );

    const triggerDoc = new MessageModel({
      organizationId: orgId,
      conversationId,
      senderId: userId,
      senderName: 'Nguyễn An',
      clientMessageId: 'human-trigger-1',
      content: '@continuumAI Hôm qua hai người chốt những gì?',
      authorType: 'USER',
      assistantMention: {
        handle: CONTINUUM_AI_HANDLE,
        query: 'Hôm qua hai người chốt những gì?',
        timezone: 'Asia/Ho_Chi_Minh',
      },
    });
    await expect(triggerDoc.validate()).resolves.toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(
        triggerDoc.toObject(),
        'sourceReferences',
      ),
    ).toBe(false);

    // Human message with assistant-only fields must fail validation
    const invalidHuman = new MessageModel({
      organizationId: orgId,
      conversationId,
      senderId: userId,
      senderName: 'Nguyễn An',
      clientMessageId: 'human-invalid-1',
      content: 'invalid',
      authorType: 'USER',
      triggerMessageId,
    });
    await expect(invalidHuman.validate()).rejects.toThrow(/triggerMessageId/);

    const humanWithSourceRefs = new MessageModel({
      organizationId: orgId,
      conversationId,
      senderId: userId,
      senderName: 'Nguyễn An',
      clientMessageId: 'human-invalid-2',
      content: 'invalid',
      sourceReferences: [],
    });
    await expect(humanWithSourceRefs.validate()).rejects.toThrow(
      /sourceReferences/,
    );
  });

  it('validates ASSISTANT messages (COMPLETED & INSUFFICIENT_EVIDENCE) and rejects malformed assistant docs', async () => {
    const validCompleted = new MessageModel({
      organizationId: orgId,
      conversationId,
      senderId: CONTINUUM_AI_SENDER_ID,
      senderName: CONTINUUM_AI_DISPLAY_NAME,
      senderAvatarUrl: null,
      clientMessageId: `assistant:${triggerMessageId.toHexString()}`,
      content: 'Hôm qua hai người chốt dời deadline PAY-123 [M1].',
      replyToMessageId: triggerMessageId,
      authorType: 'ASSISTANT',
      triggerMessageId,
      assistantStatus: 'COMPLETED',
      assistantFailureCode: null,
      assistantMeta: {
        handle: CONTINUUM_AI_HANDLE,
        queryMode: 'TIME_WINDOW',
        partialCoverage: false,
        coverageNote: null,
        model: 'gpt-4o-mini',
        promptTokens: 420,
        completionTokens: 68,
      },
      sourceReferences: [
        {
          refId: 'M1',
          messageId: sourceMessageId,
          senderName: 'Nguyễn An',
          createdAt: new Date('2026-11-27T08:15:00.000Z'),
          sourceEditedAt: null,
          sourceVersion: 0,
          quoteSnippet: 'Chốt dời deadline PAY-123 sang 29/11.',
        },
        {
          refId: 'M2',
          messageId: new Types.ObjectId(),
          senderName: 'Trần Bình',
          createdAt: new Date('2026-11-27T08:16:00.000Z'),
          sourceEditedAt: null,
          sourceVersion: 1,
          quoteSnippet: '',
        },
      ],
    });
    await expect(validCompleted.validate()).resolves.toBeUndefined();

    const validInsufficient = new MessageModel({
      organizationId: orgId,
      conversationId,
      senderId: CONTINUUM_AI_SENDER_ID,
      senderName: CONTINUUM_AI_DISPLAY_NAME,
      clientMessageId: `assistant:${new Types.ObjectId().toHexString()}`,
      content: 'Chưa đủ căn cứ trong hội thoại để trả lời câu hỏi này.',
      authorType: 'ASSISTANT',
      triggerMessageId,
      assistantStatus: 'INSUFFICIENT_EVIDENCE',
      assistantFailureCode: null,
      sourceReferences: [],
    });
    await expect(validInsufficient.validate()).resolves.toBeUndefined();

    const missingTrigger = new MessageModel({
      organizationId: orgId,
      conversationId,
      senderId: CONTINUUM_AI_SENDER_ID,
      senderName: CONTINUUM_AI_DISPLAY_NAME,
      clientMessageId: 'assistant:missing-trigger',
      content: 'Answer',
      authorType: 'ASSISTANT',
      assistantStatus: 'COMPLETED',
      sourceReferences: [],
    });
    await expect(missingTrigger.validate()).rejects.toThrow(/triggerMessageId/);

    const badRefId = new MessageModel({
      organizationId: orgId,
      conversationId,
      senderId: CONTINUUM_AI_SENDER_ID,
      senderName: CONTINUUM_AI_DISPLAY_NAME,
      clientMessageId: 'assistant:bad-ref',
      content: 'Answer',
      authorType: 'ASSISTANT',
      triggerMessageId,
      assistantStatus: 'COMPLETED',
      sourceReferences: [
        {
          refId: 'M0',
          messageId: sourceMessageId,
          senderName: 'An',
          createdAt: new Date(),
          sourceEditedAt: null,
          sourceVersion: 0,
          quoteSnippet: 'bad ref',
        },
      ],
    });
    await expect(badRefId.validate()).rejects.toThrow(/refId/);

    const tooManyRefs = new MessageModel({
      organizationId: orgId,
      conversationId,
      senderId: CONTINUUM_AI_SENDER_ID,
      senderName: CONTINUUM_AI_DISPLAY_NAME,
      clientMessageId: 'assistant:too-many-refs',
      content: 'Answer',
      authorType: 'ASSISTANT',
      triggerMessageId,
      assistantStatus: 'COMPLETED',
      sourceReferences: Array.from({ length: 21 }, (_, idx) => ({
        refId: `M${idx + 1}`,
        messageId: new Types.ObjectId(),
        senderName: 'An',
        createdAt: new Date(),
        sourceEditedAt: null,
        sourceVersion: 0,
        quoteSnippet: 'snippet',
      })),
    });
    await expect(tooManyRefs.validate()).rejects.toThrow(/20/);
  });

  it('validates chat_assistant_jobs outbox records and enforces bounds', async () => {
    const pendingJob = new AssistantJobModel({
      organizationId: orgId,
      conversationId,
      triggerMessageId,
      requesterUserId: userId,
      requesterDisplayName: 'Nguyễn An',
      query: 'Hôm qua hai người chốt những gì?',
    });
    await expect(pendingJob.validate()).resolves.toBeUndefined();
    expect(pendingJob.get('handle')).toBe(CONTINUUM_AI_HANDLE);
    expect(pendingJob.get('timezone')).toBe('Asia/Ho_Chi_Minh');
    expect(pendingJob.get('status')).toBe('PENDING');
    expect(pendingJob.get('failureCode')).toBeNull();
    expect(pendingJob.get('attempts')).toBe(0);
    expect(pendingJob.get('maxAttempts')).toBe(3);
    expect(pendingJob.get('lockedBy')).toBeNull();
    expect(pendingJob.get('lockedUntil')).toBeNull();
    expect(pendingJob.get('responseMessageId')).toBeNull();
    expect(pendingJob.get('completedAt')).toBeNull();

    const completedJob = new AssistantJobModel({
      organizationId: orgId,
      conversationId,
      triggerMessageId: new Types.ObjectId(),
      requesterUserId: userId,
      requesterDisplayName: 'Nguyễn An',
      query: 'Deadline của PAY-123 là khi nào?',
      status: 'COMPLETED',
      attempts: 1,
      responseMessageId: new Types.ObjectId(),
      completedAt: new Date(),
      metrics: {
        queryMode: 'KEYWORD',
        retrievalPath: 'ATLAS_SEARCH',
        candidateCount: 12,
        sentSnippetCount: 8,
        citedCount: 2,
        partialCoverage: false,
        retrievalLatencyMs: 45,
        sagLatencyMs: 910,
        totalLatencyMs: 980,
      },
    });
    await expect(completedJob.validate()).resolves.toBeUndefined();

    const invalidRequester = new AssistantJobModel({
      organizationId: orgId,
      conversationId,
      triggerMessageId: new Types.ObjectId(),
      requesterUserId: 'not-a-24-hex-id',
      requesterDisplayName: 'Nguyễn An',
      query: 'Test',
    });
    await expect(invalidRequester.validate()).rejects.toThrow(
      /requesterUserId/,
    );

    const invalidMaxAttempts = new AssistantJobModel({
      organizationId: orgId,
      conversationId,
      triggerMessageId: new Types.ObjectId(),
      requesterUserId: userId,
      requesterDisplayName: 'Nguyễn An',
      query: 'Test',
      maxAttempts: 6,
    });
    await expect(invalidMaxAttempts.validate()).rejects.toThrow(/maxAttempts/);
  });
});
