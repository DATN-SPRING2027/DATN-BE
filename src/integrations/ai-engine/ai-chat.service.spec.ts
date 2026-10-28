import {
  BadGatewayException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AiChatService } from './ai-chat.service';
import { sanitizeContinuumActorHeaderName } from './ai-chat.types';
import type { AiEngineClient } from './ai-engine.port';
import type { AuthenticationApplicationService } from '../../services/iam/application/authentication/authentication.application.service';
import type { ProjectService } from '../../services/iam/application/projects/project.service';

describe('AiChatService', () => {
  const actor = {
    id: '507f1f77bcf86cd799439011',
    email: 'member@continuum.ai',
    name: 'Nguyễn Văn Thắng\r\nĐức',
    organizationId: '507f1f77bcf86cd799439022',
    roles: ['MEMBER'],
  };
  const project = {
    id: '507f1f77bcf86cd799439033',
    organizationId: '507f1f77bcf86cd799439022',
    name: 'Continuum Core',
    code: 'CORE',
  };

  function setup() {
    const getCurrentIdentity = jest.fn().mockResolvedValue(actor);
    const getProject = jest.fn().mockResolvedValue(project);
    const requestMock = jest.fn();
    const requestStreamMock = jest.fn();

    const auth = {
      getCurrentIdentity,
    } as unknown as AuthenticationApplicationService;
    const projects = {
      get: getProject,
    } as unknown as ProjectService;
    const aiEngine: AiEngineClient = {
      request: requestMock,
      requestStream: requestStreamMock,
    };
    const service = new AiChatService(auth, projects, aiEngine);
    return {
      service,
      getCurrentIdentity,
      getProject,
      requestMock,
      requestStreamMock,
    };
  }

  it('never touches SAG when authentication or Project access fails', async () => {
    const { service, getCurrentIdentity, getProject, requestMock } = setup();
    getCurrentIdentity.mockRejectedValueOnce(new UnauthorizedException());
    await expect(
      service.listThreads({ cookie: 'continuum_access=bad' }, project.id, {
        limit: 20,
        offset: 0,
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(requestMock).not.toHaveBeenCalled();

    getProject.mockRejectedValueOnce(new NotFoundException());
    await expect(
      service.listThreads(
        { cookie: 'continuum_access=ok' },
        '507f1f77bcf86cd799439099',
        { limit: 20, offset: 0 },
      ),
    ).rejects.toThrow(NotFoundException);
    expect(requestMock).not.toHaveBeenCalled();

    getProject.mockRejectedValueOnce(new ForbiddenException());
    await expect(
      service.createThread({ cookie: 'continuum_access=ok' }, project.id, {
        title: 'Test',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('mints Project-scoped SAG JWT server-side, sanitizes actor name, and maps threads & ECCE messages safely', async () => {
    const { service, requestMock } = setup();
    requestMock
      .mockResolvedValueOnce({
        status: 200,
        body: { access_token: 'header.payload.signature' },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { id: 'agent_default_1' },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          items: [
            {
              id: 'm1',
              thread_id: 't1',
              role: 'user',
              content: 'Chốt dùng PostgreSQL cho SAG nhé?',
              citations: [],
              steps: [],
              prompt_preview: '',
              status: 'ok',
              created_at: '2026-10-28T10:00:00Z',
            },
            {
              id: 'm2',
              thread_id: 't1',
              role: 'assistant',
              content: 'Đã xác nhận dùng PostgreSQL [1] và ghi nhớ phiên [S1].',
              prompt_preview: 'DO_NOT_LEAK_SYSTEM_PROMPT',
              status: 'ok',
              created_at: '2026-10-28T10:00:05Z',
              citations: [
                {
                  n: 1,
                  source_id: 'src-db',
                  source_name: 'DB Spec',
                  document_id: 'doc-db',
                  document_name: 'Database Architecture',
                  page_from: 2,
                  page_to: 2,
                  snippet: 'SAG uses PostgreSQL + Qdrant.',
                  mapped: true,
                  claim_level: 'claim',
                },
              ],
              steps: [
                {
                  kind: 'session_context',
                  step: 0,
                  name: 'session_context',
                  mode: 'on',
                  ms: 18,
                  session_citations: [
                    {
                      ref: 'S1',
                      source: 'selected_group',
                      group_id: 'g1',
                      turn_ids: ['m1'],
                      turn_range: [1, 1],
                      summary_excerpt: 'User confirmed PostgreSQL for SAG.',
                      mapped: true,
                      claim_level: 'claim',
                    },
                  ],
                },
                {
                  kind: 'tool',
                  step: 1,
                  name: 'search_context',
                  label: 'Search Project Knowledge',
                  ms: 95,
                  count: 4,
                  arguments: { raw_internal_filter: 'secret' },
                },
              ],
            },
          ],
          next_cursor: 'cursor_abc',
          has_more: true,
        },
      });

    const page = await service.listMessages(
      { authorization: 'Bearer continuum-jwt' },
      project.id,
      't1',
      { limit: 40, cursor: undefined },
    );

    expect(requestMock).toHaveBeenNthCalledWith(1, {
      path: '/api/v1/auth/continuum-login',
      method: 'POST',
      headers: {
        'X-Continuum-User-Id': actor.id,
        'X-Continuum-Name': 'Nguyen Van Thang Duc',
        'X-Continuum-Organization-Id': project.organizationId,
        'X-Continuum-Project-Id': project.id,
      },
      body: {},
    });

    expect(page).toEqual({
      items: [
        {
          id: 'm1',
          role: 'user',
          content: 'Chốt dùng PostgreSQL cho SAG nhé?',
          status: 'ok',
          citations: [],
          sessionCitations: [],
          retrievalSteps: [],
          createdAt: '2026-10-28T10:00:00Z',
        },
        {
          id: 'm2',
          role: 'assistant',
          content: 'Đã xác nhận dùng PostgreSQL [1] và ghi nhớ phiên [S1].',
          status: 'ok',
          createdAt: '2026-10-28T10:00:05Z',
          citations: [
            {
              number: 1,
              sourceId: 'src-db',
              sourceName: 'DB Spec',
              documentId: 'doc-db',
              documentName: 'Database Architecture',
              label: 'Database Architecture',
              snippet: 'SAG uses PostgreSQL + Qdrant.',
              pageFrom: 2,
              pageTo: 2,
              mapped: true,
              claimLevel: 'claim',
            },
          ],
          sessionCitations: [
            {
              ref: 'S1',
              source: 'selected_group',
              groupId: 'g1',
              turnIds: ['m1'],
              turnRange: [1, 1],
              summaryExcerpt: 'User confirmed PostgreSQL for SAG.',
              mapped: true,
              claimLevel: 'claim',
            },
          ],
          retrievalSteps: [
            {
              kind: 'session_context',
              label: 'Session Memory (ECCE)',
              durationMs: 18,
              mode: 'on',
            },
            {
              kind: 'tool',
              label: 'Search Project Knowledge',
              durationMs: 95,
              count: 4,
            },
          ],
        },
      ],
      nextCursor: 'cursor_abc',
      hasMore: true,
    });
    expect(JSON.stringify(page)).not.toContain('DO_NOT_LEAK_SYSTEM_PROMPT');
    expect(JSON.stringify(page)).not.toContain('raw_internal_filter');
    expect(JSON.stringify(page)).not.toContain('header.payload.signature');
  });

  it('enriches completed stream event with persisted sessionCitations when SAG completes a turn', async () => {
    const { service, requestMock, requestStreamMock } = setup();
    const encoder = new TextEncoder();
    const sagStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: run.started\ndata: {"run_id":"r1","payload":{"user_message_id":"u1"}}\n\n' +
              'event: message.delta\ndata: {"payload":{"role":"assistant","delta":"Theo [S1], dùng Postgres."}}\n\n' +
              'event: run.completed\ndata: {"payload":{"message_id":"m-new","output":"Theo [S1], dùng Postgres.","answer_status":"answered","citations":[]}}\n\n',
          ),
        );
        controller.close();
      },
    });

    requestMock
      .mockResolvedValueOnce({
        status: 200,
        body: { access_token: 'h.p.s' },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { id: 'agent_1' },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          items: [
            {
              id: 'm-new',
              thread_id: 't1',
              role: 'assistant',
              content: 'Theo [S1], dùng Postgres.',
              status: 'ok',
              created_at: '2026-10-28T10:01:00Z',
              citations: [],
              steps: [
                {
                  kind: 'session_context',
                  step: 0,
                  name: 'session_context',
                  mode: 'on',
                  ms: 12,
                  session_citations: [
                    {
                      ref: 'S1',
                      source: 'recent_continuity',
                      group_id: null,
                      turn_ids: ['u0'],
                      turn_range: [1, 1],
                      summary_excerpt: 'Turn u0 chose Postgres.',
                      mapped: true,
                      claim_level: 'claim',
                    },
                  ],
                },
              ],
            },
          ],
          next_cursor: null,
          has_more: false,
        },
      });
    requestStreamMock.mockResolvedValueOnce({
      status: 200,
      contentType: 'text/event-stream',
      stream: sagStream,
    });

    const opened = await service.openAskStream(
      { authorization: 'Bearer continuum-jwt' },
      project.id,
      't1',
      { query: 'Nhắc lại lựa chọn DB?' },
      new AbortController().signal,
    );

    const events = [];
    for await (const ev of opened) {
      events.push(ev);
    }

    const completed = events.find((e) => e.event === 'completed');
    expect(completed).toEqual({
      event: 'completed',
      data: {
        messageId: 'm-new',
        content: 'Theo [S1], dùng Postgres.',
        answerStatus: 'answered',
        citations: [],
        sessionCitations: [
          {
            ref: 'S1',
            source: 'recent_continuity',
            groupId: null,
            turnIds: ['u0'],
            turnRange: [1, 1],
            summaryExcerpt: 'Turn u0 chose Postgres.',
            mapped: true,
            claimLevel: 'claim',
          },
        ],
        retrievalSteps: [
          {
            kind: 'session_context',
            label: 'Session Memory (ECCE)',
            durationMs: 12,
            mode: 'on',
          },
        ],
      },
    });
  });

  it('rejects malformed SAG login tokens with BadGatewayException', async () => {
    const { service, requestMock } = setup();
    requestMock.mockResolvedValueOnce({
      status: 200,
      body: { access_token: 'not-a-jwt' },
    });
    await expect(
      service.listThreads({ authorization: 'Bearer ok' }, project.id, {
        limit: 20,
        offset: 0,
      }),
    ).rejects.toThrow(BadGatewayException);
  });

  it('normalizes real SAG session_memory citations (message_ids, primary_message_id, turn_ordinals) and filters mapped=false pool items', async () => {
    expect(sanitizeContinuumActorHeaderName('🚀✨')).toBe('Continuum user');

    const { service, requestMock } = setup();
    requestMock
      .mockResolvedValueOnce({
        status: 200,
        body: { access_token: 'h.p.s' },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { id: 'agent_real' },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          items: [
            {
              id: 'm-ans',
              thread_id: 't1',
              role: 'assistant',
              content: 'Đã chốt kiến trúc theo [S1].',
              status: 'ok',
              created_at: '2026-10-28T12:00:00Z',
              citations: [],
              steps: [
                {
                  kind: 'session_context',
                  step: 0,
                  name: 'session_context',
                  mode: 'on',
                  ms: 21,
                  audit: {
                    selected_groups: [
                      {
                        citation_tag: 'S1',
                        primary_turn_id: 'msg-u2',
                        included_turn_ids: ['msg-u1', 'msg-u2'],
                      },
                    ],
                    recent_turn_ids: ['msg-u7', 'msg-u8'],
                  },
                  session_citations: [
                    {
                      kind: 'session_memory',
                      ref: 'S1',
                      primary_message_id: 'msg-u2',
                      message_ids: ['msg-u1', 'msg-u2'],
                      turn_ordinals: [1, 2],
                      epistemic_status: 'CONFIRMED',
                      sha256: 'abc123',
                      cited_source_ids: [],
                      mapped: true,
                      claim_level: 'claim',
                    },
                    {
                      kind: 'session_memory',
                      ref: 'S2',
                      primary_message_id: 'msg-u8',
                      message_ids: ['msg-u7', 'msg-u8'],
                      turn_ordinals: [7, 8],
                      epistemic_status: 'INFO',
                      sha256: 'def456',
                      cited_source_ids: [],
                      mapped: false,
                      claim_level: 'run',
                    },
                  ],
                },
              ],
            },
          ],
          next_cursor: null,
          has_more: false,
        },
      });

    const page = await service.listMessages(
      { authorization: 'Bearer ok' },
      project.id,
      't1',
      { limit: 40 },
    );

    expect(page.items[0]?.sessionCitations).toEqual([
      {
        ref: 'S1',
        source: 'selected_group',
        groupId: 'S1',
        turnIds: ['msg-u2', 'msg-u1'],
        turnRange: [1, 2],
        summaryExcerpt: 'Turns #1–#2 · CONFIRMED',
        mapped: true,
        claimLevel: 'claim',
      },
    ]);
  });

  it('caches resolved SAG session across consecutive calls while still enforcing Continuum RBAC on every request', async () => {
    const { service, getCurrentIdentity, getProject, requestMock } = setup();
    requestMock
      .mockResolvedValueOnce({
        status: 200,
        body: { access_token: 'cached.jwt.token' },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { id: 'agent_cached' },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: [],
      })
      .mockResolvedValueOnce({
        status: 201,
        body: {
          id: 't-new',
          title: 'Cached thread',
          created_at: '2026-10-28T12:00:00Z',
          updated_at: '2026-10-28T12:00:00Z',
        },
      });

    await service.listThreads({ authorization: 'Bearer ok' }, project.id, {
      limit: 20,
      offset: 0,
    });
    await service.createThread({ authorization: 'Bearer ok' }, project.id, {
      title: 'Cached thread',
    });

    // Only 4 SAG HTTP calls total (login + agents/default + GET threads + POST threads), NOT 6!
    expect(requestMock).toHaveBeenCalledTimes(4);
    expect(getCurrentIdentity).toHaveBeenCalledTimes(2);
    expect(getProject).toHaveBeenCalledTimes(2);

    // Revoking project access immediately blocks the next call even with a warm SAG cache
    getProject.mockRejectedValueOnce(new ForbiddenException());
    await expect(
      service.listThreads({ authorization: 'Bearer ok' }, project.id, {
        limit: 20,
        offset: 0,
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(requestMock).toHaveBeenCalledTimes(4);
  });
});
