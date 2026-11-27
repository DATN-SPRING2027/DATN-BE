import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiChatService } from './ai-chat.service';
import { HttpAiEngineClient } from './http-ai-engine.client';
import type { AiEngineClient } from './ai-engine.port';
import type { AuthenticationApplicationService } from '../../services/iam/application/authentication/authentication.application.service';
import type { IamActorContextService } from '../../services/iam/application/projects/iam-actor-context.service';
import type { ProjectService } from '../../services/iam/application/projects/project.service';

describe('SAG Knowledge Search & Grounded Ask Bridge (Packet B)', () => {
  const actor = {
    id: '507f1f77bcf86cd799439011',
    email: 'dev@continuum.ai',
    name: 'Continuum Dev',
    organizationId: '507f1f77bcf86cd799439022',
    roles: ['MEMBER'],
  };
  const project = {
    id: '507f1f77bcf86cd799439033',
    organizationId: '507f1f77bcf86cd799439022',
    name: 'Continuum Platform',
    code: 'CPT',
    visibility: 'PRIVATE' as const,
    status: 'ACTIVE' as const,
    createdBy: actor.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('allowlists POST /api/v1/search in HttpAiEngineClient without leaking X-SAG-BFF-Service-Token', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new globalThis.Response(
        JSON.stringify({
          query: 'handover policy',
          sections: [],
          citations: [],
          summary: 'Grounded summary',
          answer_status: 'answered',
          stats: {},
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const config = {
      get: (key: string) => {
        if (key === 'SAG_API_BASE_URL') return 'http://127.0.0.1:8000';
        if (key === 'SAG_BFF_SERVICE_TOKEN')
          return 'bff-secret-token-with-32-characters-min';
        if (key === 'SAG_CHAT_STREAM_TIMEOUT_MS') return 60000;
        return undefined;
      },
      getOrThrow: (key: string) => {
        if (key === 'BACKEND_TIMEOUT_MS') return 5000;
        throw new Error(`Unexpected key: ${key}`);
      },
    } as unknown as ConfigService;

    const client = new HttpAiEngineClient(config);
    const res = await client.request<{ summary: string }>({
      path: '/api/v1/search',
      method: 'POST',
      headers: { Authorization: 'Bearer sag.jwt.token' },
      body: { query: 'handover policy', save_exploration: false },
    });

    expect(res.status).toBe(200);
    expect(res.body.summary).toBe('Grounded summary');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    const sentHeaders = new Headers(init?.headers);
    expect(sentHeaders.get('authorization')).toBe('Bearer sag.jwt.token');
    expect(sentHeaders.get('x-sag-bff-service-token')).toBeNull();
  });

  it('executes searchKnowledge with project-scoped SAG session and maps sections, citations, and summary', async () => {
    const requestMock = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        body: { access_token: 'sag.jwt.token' },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { id: 'agent_default_1' },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          query: 'architecture overview',
          summary: 'Continuum uses modular microservices [1].',
          answer_status: 'answered',
          no_answer_reason: null,
          degraded: false,
          degraded_reason: null,
          sections: [
            {
              chunk_id: 'chk_1',
              search_unit_id: 'su_1',
              document_id: 'doc_1',
              document_version_id: 'ver_1',
              document_name: 'Architecture.md',
              version_no: 2,
              section_path: '1. Overview',
              page_from: 1,
              page_to: 2,
              heading: 'System Overview',
              content:
                'Continuum separates IAM, Task, Capture, Handover, and SAG.',
              score: 0.91,
              rank: 1,
              source_id: 'src_1',
              source_name: 'Architecture.md',
            },
          ],
          citations: [
            {
              kind: 'internal',
              n: 1,
              document_id: 'doc_1',
              document_version_id: 'ver_1',
              document_name: 'Architecture.md',
              version_no: 2,
              chunk_id: 'chk_1',
              section_path: '1. Overview',
              page_from: 1,
              page_to: 2,
              anchor: '#overview',
              heading: 'System Overview',
              snippet: 'Continuum separates IAM, Task...',
              score: 0.91,
              source_id: 'src_1',
              source_name: 'Architecture.md',
            },
          ],
          stats: { fusion_method: 'rrf' },
        },
      });

    const actorContext = {
      resolveProjectActorContext: jest.fn().mockResolvedValue({
        actor,
        project,
        isProjectMember: true,
        isLeader: false,
        isManager: false,
        joinedAt: null,
        canReview: false,
      }),
    } as unknown as IamActorContextService;

    const service = new AiChatService(
      {
        getCurrentIdentity: jest.fn().mockResolvedValue(actor),
      } as unknown as AuthenticationApplicationService,
      {
        get: jest.fn().mockResolvedValue(project),
      } as unknown as ProjectService,
      {
        request: requestMock,
        requestStream: jest.fn(),
      } as AiEngineClient,
      undefined,
      undefined,
      undefined,
      actorContext,
    );

    const result = await service.searchKnowledge(
      { authorization: 'Bearer ctm_mcp_token' },
      {
        projectId: project.id,
        query: '  architecture overview  ',
        topK: 8,
        retrievalMode: 'GLOBAL_TOPIC',
        sourceIds: ['src_1'],
      },
    );

    expect(requestMock).toHaveBeenNthCalledWith(3, {
      path: '/api/v1/search',
      method: 'POST',
      headers: { Authorization: 'Bearer sag.jwt.token' },
      body: {
        query: 'architecture overview',
        top_k: 8,
        retrieval_mode: 'GLOBAL_TOPIC',
        source_ids: ['src_1'],
        save_exploration: false,
      },
    });
    expect(result.summary).toBe('Continuum uses modular microservices [1].');
    expect(result.answerStatus).toBe('answered');
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]).toMatchObject({
      chunkId: 'chk_1',
      documentId: 'doc_1',
      documentName: 'Architecture.md',
      heading: 'System Overview',
      score: 0.91,
    });
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({
      n: 1,
      documentId: 'doc_1',
      sourceId: 'src_1',
    });

    await expect(
      service.searchKnowledge(
        { authorization: 'Bearer ctm_mcp_token' },
        { projectId: project.id, query: '   ' },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('executes askKnowledgeQuestion by creating a thread when omitted and collecting grounded SSE output', async () => {
    const encoder = new TextEncoder();
    const ssePayload = [
      'event: message.delta\ndata: {"type":"message.delta","payload":{"role":"assistant","delta":"Hello "}}\n\n',
      'event: message.delta\ndata: {"type":"message.delta","payload":{"role":"assistant","delta":"world [1]"}}\n\n',
      'event: run.completed\ndata: {"type":"run.completed","payload":{"message_id":"msg_99","output":"Hello world [1]","answer_status":"answered","citations":[{"n":1,"document_id":"doc_1","document_version_id":"ver_1","document_name":"Spec.md","chunk_id":"c1","page_from":1,"page_to":1,"anchor":"#a","source_id":"s1"}],"steps":[]}}\n\n',
    ].join('');

    const requestMock = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        body: { access_token: 'sag.jwt.token' },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { id: 'agent_default_1' },
      })
      .mockResolvedValueOnce({
        status: 201,
        body: {
          id: 'thread_abc',
          agent_id: 'agent_default_1',
          title: 'What is Spec?',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { items: [] },
      });

    const requestStreamMock = jest.fn().mockResolvedValue({
      status: 200,
      contentType: 'text/event-stream',
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(ssePayload));
          controller.close();
        },
      }),
    });

    const actorContext = {
      resolveProjectActorContext: jest.fn().mockResolvedValue({
        actor,
        project,
        isProjectMember: true,
        isLeader: false,
        isManager: false,
        joinedAt: null,
        canReview: false,
      }),
    } as unknown as IamActorContextService;

    const service = new AiChatService(
      {
        getCurrentIdentity: jest.fn().mockResolvedValue(actor),
      } as unknown as AuthenticationApplicationService,
      {
        get: jest.fn().mockResolvedValue(project),
      } as unknown as ProjectService,
      {
        request: requestMock,
        requestStream: requestStreamMock,
      } as AiEngineClient,
      undefined,
      undefined,
      undefined,
      actorContext,
    );

    const answer = await service.askKnowledgeQuestion(
      { authorization: 'Bearer ctm_mcp_token' },
      { projectId: project.id, query: 'What is Spec?' },
    );

    expect(answer.threadId).toBe('thread_abc');
    expect(answer.threadPersisted).toBe(false);
    expect(answer.messageId).toBe('msg_99');
    expect(answer.answer).toBe('Hello world [1]');
    expect(answer.citations).toHaveLength(1);

    // Ephemeral thread (no input.threadId) MUST be deleted in finally block after stream completes
    expect(requestMock).toHaveBeenCalledWith({
      path: '/api/v1/agents/agent_default_1/threads/thread_abc',
      method: 'DELETE',
      headers: { Authorization: 'Bearer sag.jwt.token' },
    });

    const deleteCallsBeforeExplicit = requestMock.mock.calls.filter(
      (call: unknown[]) => (call[0] as { method?: string }).method === 'DELETE',
    ).length;

    // Failed SSE frame with caller-supplied threadId throws BadGatewayException AND never deletes caller's thread
    requestStreamMock.mockResolvedValueOnce({
      status: 200,
      contentType: 'text/event-stream',
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: run.failed\ndata: {"type":"run.failed","payload":{"error":{"code":"LLM_TIMEOUT","retryable":true}}}\n\n',
            ),
          );
          controller.close();
        },
      }),
    });

    await expect(
      service.askKnowledgeQuestion(
        { authorization: 'Bearer ctm_mcp_token' },
        { projectId: project.id, query: 'Retry?', threadId: 'thread_abc' },
      ),
    ).rejects.toThrow(BadGatewayException);

    const deleteCallsAfterExplicit = requestMock.mock.calls.filter(
      (call: unknown[]) => (call[0] as { method?: string }).method === 'DELETE',
    ).length;
    expect(deleteCallsAfterExplicit).toBe(deleteCallsBeforeExplicit);

    // Ephemeral thread MUST also be deleted when stream throws an error
    requestMock.mockResolvedValueOnce({
      status: 201,
      body: {
        id: 'thread_ephemeral_err',
        agent_id: 'agent_default_1',
        title: 'Broken ask',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    });
    requestMock.mockResolvedValueOnce({ status: 204, body: null });
    requestStreamMock.mockResolvedValueOnce({
      status: 200,
      contentType: 'text/event-stream',
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: run.failed\ndata: {"type":"run.failed","payload":{"error":{"code":"LLM_TIMEOUT","retryable":true}}}\n\n',
            ),
          );
          controller.close();
        },
      }),
    });

    await expect(
      service.askKnowledgeQuestion(
        { authorization: 'Bearer ctm_mcp_token' },
        { projectId: project.id, query: 'Broken ask' },
      ),
    ).rejects.toThrow(BadGatewayException);

    expect(requestMock).toHaveBeenCalledWith({
      path: '/api/v1/agents/agent_default_1/threads/thread_ephemeral_err',
      method: 'DELETE',
      headers: { Authorization: 'Bearer sag.jwt.token' },
    });

    // persistThread=true on successful ask keeps newly created thread alive (NO DELETE) and returns threadPersisted: true
    const deletesBeforePersisted = requestMock.mock.calls.filter(
      (call: unknown[]) => (call[0] as { method?: string }).method === 'DELETE',
    ).length;
    requestMock.mockResolvedValueOnce({
      status: 201,
      body: {
        id: 'thread_persisted_1',
        agent_id: 'agent_default_1',
        title: 'Multi-turn follow up',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    });
    requestStreamMock.mockResolvedValueOnce({
      status: 200,
      contentType: 'text/event-stream',
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(ssePayload));
          controller.close();
        },
      }),
    });

    const persistedAnswer = await service.askKnowledgeQuestion(
      { authorization: 'Bearer ctm_mcp_token' },
      {
        projectId: project.id,
        query: 'Multi-turn follow up',
        persistThread: true,
      },
    );
    expect(persistedAnswer.threadId).toBe('thread_persisted_1');
    expect(persistedAnswer.threadPersisted).toBe(true);
    expect(persistedAnswer.answer).toBe('Hello world [1]');
    const deletesAfterPersisted = requestMock.mock.calls.filter(
      (call: unknown[]) => (call[0] as { method?: string }).method === 'DELETE',
    ).length;
    expect(deletesAfterPersisted).toBe(deletesBeforePersisted);

    // persistThread=true when SSE returns run.failed MUST still delete the newly created empty thread
    requestMock.mockResolvedValueOnce({
      status: 201,
      body: {
        id: 'thread_persisted_err',
        agent_id: 'agent_default_1',
        title: 'Failed persisted ask',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    });
    requestMock.mockResolvedValueOnce({ status: 204, body: null });
    requestStreamMock.mockResolvedValueOnce({
      status: 200,
      contentType: 'text/event-stream',
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: run.failed\ndata: {"type":"run.failed","payload":{"error":{"code":"LLM_TIMEOUT","retryable":true}}}\n\n',
            ),
          );
          controller.close();
        },
      }),
    });

    await expect(
      service.askKnowledgeQuestion(
        { authorization: 'Bearer ctm_mcp_token' },
        {
          projectId: project.id,
          query: 'Failed persisted ask',
          persistThread: true,
        },
      ),
    ).rejects.toThrow(BadGatewayException);

    expect(requestMock).toHaveBeenCalledWith({
      path: '/api/v1/agents/agent_default_1/threads/thread_persisted_err',
      method: 'DELETE',
      headers: { Authorization: 'Bearer sag.jwt.token' },
    });
  });
});
