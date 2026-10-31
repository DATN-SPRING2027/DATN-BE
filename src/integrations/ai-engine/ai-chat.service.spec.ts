import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AiChatService } from './ai-chat.service';
import {
  mapSagCitation,
  sanitizeContinuumActorDisplayName,
  sanitizeContinuumActorHeaderName,
} from './ai-chat.types';
import type { AiEngineClient } from './ai-engine.port';
import type { AuthenticationApplicationService } from '../../services/iam/application/authentication/authentication.application.service';
import type { HandoverIamScopeService } from '../../services/iam/application/projects/handover-iam-scope.service';
import type { ProjectService } from '../../services/iam/application/projects/project.service';
import type { PlatformAdministrationRepository } from '../../services/iam/application/platform/platform-administration.repository';

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
    status: 'ACTIVE' as const,
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
      body: { displayName: 'Nguyễn Văn Thắng Đức' },
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
    expect(sanitizeContinuumActorDisplayName('🚀✨')).toBe('Continuum user');
    expect(sanitizeContinuumActorDisplayName('  KeyT  ')).toBe('KeyT');
    expect(sanitizeContinuumActorDisplayName('Trần Kim Thắng\r\n')).toBe(
      'Trần Kim Thắng',
    );

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

  it('manages single-vote feedback, creates shares with 201/200 preservation, and streams regenerations with lineage metadata', async () => {
    const { service, requestMock, requestStreamMock } = setup();
    requestMock
      .mockResolvedValueOnce({
        status: 200,
        body: { access_token: 'act.jwt.token' },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { id: 'agent_1' },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          message_id: 'm2',
          rating: 'DISLIKE',
          reason_category: 'INACCURATE',
          reason_text: 'Sai công thức tính KPI.',
          updated_at: '2026-10-30T10:00:00Z',
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          feedback: {
            message_id: 'm2',
            rating: 'LIKE',
            reason_category: null,
            reason_text: null,
            updated_at: '2026-10-30T10:02:00Z',
          },
        },
      })
      .mockResolvedValueOnce({ status: 204, body: undefined })
      .mockResolvedValueOnce({
        status: 201,
        body: {
          id: 'sh_1',
          project_id: project.id,
          message_id: 'm2',
          created_at: '2026-10-30T10:03:00Z',
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          items: [
            {
              id: 'm3',
              thread_id: 't1',
              reply_to_message_id: 'm1',
              regenerated_from_message_id: 'm2',
              role: 'assistant',
              content: 'Bản trả lời mới [1].',
              status: 'ok',
              created_at: '2026-10-30T10:05:00Z',
              citations: [],
              steps: [],
            },
          ],
          next_cursor: null,
          has_more: false,
        },
      });

    const savedDislike = await service.putOwnFeedback(
      { authorization: 'Bearer ok' },
      project.id,
      't1',
      'm2',
      {
        rating: 'DISLIKE',
        reasonCategory: 'INACCURATE',
        reasonText: 'Sai công thức tính KPI.',
      },
    );
    expect(savedDislike).toEqual({
      messageId: 'm2',
      rating: 'DISLIKE',
      reasonCategory: 'INACCURATE',
      reasonText: 'Sai công thức tính KPI.',
      updatedAt: '2026-10-30T10:00:00Z',
    });

    const ownLike = await service.getOwnFeedback(
      { authorization: 'Bearer ok' },
      project.id,
      't1',
      'm2',
    );
    expect(ownLike).toEqual({
      feedback: {
        messageId: 'm2',
        rating: 'LIKE',
        updatedAt: '2026-10-30T10:02:00Z',
      },
    });

    await service.deleteOwnFeedback(
      { authorization: 'Bearer ok' },
      project.id,
      't1',
      'm2',
    );

    const shareCreated = await service.createShare(
      { authorization: 'Bearer ok' },
      project.id,
      't1',
      'm2',
    );
    expect(shareCreated).toEqual({
      status: 201,
      share: {
        id: 'sh_1',
        projectId: project.id,
        messageId: 'm2',
        createdAt: '2026-10-30T10:03:00Z',
      },
    });

    const encoder = new TextEncoder();
    const rawSse = [
      'event: run.started\ndata: {"run_id":"r2","type":"run.started","payload":{"user_message_id":"m1"}}\n\n',
      'event: run.completed\ndata: {"run_id":"r2","type":"run.completed","payload":{"message_id":"m3","reply_to_message_id":"m1","regenerated_from_message_id":"m2","output":"Bản trả lời mới [1].","answer_status":"answered","citations":[]}}\n\n',
    ].join('');
    requestStreamMock.mockResolvedValueOnce({
      status: 200,
      contentType: 'text/event-stream',
      stream: new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(encoder.encode(rawSse));
          ctrl.close();
        },
      }),
    });

    const frames = [];
    for await (const frame of await service.openRegenerateStream(
      { authorization: 'Bearer ok' },
      project.id,
      't1',
      'm2',
    )) {
      frames.push(frame);
    }
    expect(frames).toEqual([
      {
        event: 'started',
        data: { runId: 'r2', threadId: 't1', userMessageId: 'm1' },
      },
      {
        event: 'completed',
        data: {
          messageId: 'm3',
          replyToMessageId: 'm1',
          regeneratedFromMessageId: 'm2',
          content: 'Bản trả lời mới [1].',
          answerStatus: 'answered',
          citations: [],
          sessionCitations: [],
          retrievalSteps: [],
        },
      },
    ]);
  });

  it('enforces ACTIVE Project membership for shared answers (denying non-member Org Managers and non-member PUBLIC viewers with safe 404)', async () => {
    const getCurrentIdentity = jest.fn().mockResolvedValue({
      ...actor,
      roles: ['ADMIN'],
    });
    const resolveProjectActorContext = jest.fn();
    const requestMock = jest.fn();
    const service = new AiChatService(
      { getCurrentIdentity } as unknown as AuthenticationApplicationService,
      { get: jest.fn() } as unknown as ProjectService,
      { request: requestMock, requestStream: jest.fn() },
      {
        resolveProjectActorContext,
      } as unknown as HandoverIamScopeService,
    );

    // Org ADMIN (Manager) in a PUBLIC project WITHOUT active project membership -> MUST get safe 404 without touching SAG!
    resolveProjectActorContext.mockResolvedValueOnce({
      userId: actor.id,
      userName: actor.name,
      organizationId: project.organizationId,
      projectId: project.id,
      projectVisibility: 'PUBLIC',
      isProjectMember: false,
      isProjectLeader: false,
      canAdministerCoordinator: true,
    });
    await expect(
      service.readSharedAnswer(
        { authorization: 'Bearer manager' },
        project.id,
        'sh_1',
      ),
    ).rejects.toThrow(NotFoundException);
    expect(requestMock).not.toHaveBeenCalled();

    // Non-ObjectId projectId -> safe 404 without leaking validation details
    await expect(
      service.readSharedAnswer(
        { authorization: 'Bearer manager' },
        'legacy-non-objectid',
        'sh_1',
      ),
    ).rejects.toThrow(NotFoundException);
    expect(requestMock).not.toHaveBeenCalled();

    // Active member of exact Project -> calls SAG with scoped BFF headers and sanitizes payload
    resolveProjectActorContext.mockResolvedValueOnce({
      userId: actor.id,
      userName: actor.name,
      organizationId: project.organizationId,
      projectId: project.id,
      projectVisibility: 'PRIVATE',
      isProjectMember: true,
      isProjectLeader: false,
      canAdministerCoordinator: false,
    });
    requestMock.mockResolvedValueOnce({
      status: 200,
      body: {
        share: {
          id: 'sh_1',
          project_id: project.id,
          message_id: 'm2',
          created_at: '2026-10-30T10:03:00Z',
        },
        question: { content: 'Quy trình bàn giao?' },
        answer: {
          id: 'm2',
          content: 'Theo tài liệu [1].',
          prompt_preview: 'MUST_NEVER_LEAK',
          steps: [{ kind: 'thinking', raw: 'secret' }],
          citations: [
            {
              n: 1,
              source_id: 'src-1',
              document_id: 'doc-1',
              document_name: 'Handover Guide',
              snippet: 'Bước 1...',
            },
          ],
        },
      },
    });

    const shared = await service.readSharedAnswer(
      { authorization: 'Bearer member' },
      project.id,
      'sh_1',
    );
    expect(requestMock).toHaveBeenCalledWith({
      path: `/api/v1/projects/${project.id}/shares/sh_1`,
      method: 'GET',
      headers: {
        'X-Continuum-User-Id': actor.id,
        'X-Continuum-Organization-Id': project.organizationId,
        'X-Continuum-Tenant-Id': project.organizationId,
        'X-Continuum-Project-Id': project.id,
        'X-Continuum-Security-Partition': project.id,
      },
    });
    expect(shared).toEqual({
      share: {
        id: 'sh_1',
        projectId: project.id,
        messageId: 'm2',
        createdAt: '2026-10-30T10:03:00Z',
      },
      question: { content: 'Quy trình bàn giao?' },
      answer: {
        id: 'm2',
        content: 'Theo tài liệu [1].',
        citations: [
          {
            number: 1,
            sourceId: 'src-1',
            documentId: 'doc-1',
            documentName: 'Handover Guide',
            label: 'Handover Guide',
            snippet: 'Bước 1...',
          },
        ],
      },
    });
  });

  it('validates Organization/Project relationship on Platform AI feedback queries and maps totals + rows', async () => {
    const findOrganization = jest.fn();
    const findProject = jest.fn();
    const requestMock = jest.fn();
    const service = new AiChatService(
      {
        getCurrentIdentity: jest.fn(),
      } as unknown as AuthenticationApplicationService,
      { get: jest.fn() } as unknown as ProjectService,
      { request: requestMock, requestStream: jest.fn() },
      undefined,
      {
        findOrganization,
        findProject,
      } as unknown as PlatformAdministrationRepository,
    );

    // Mismatched projectId vs organizationId -> 400 BadRequestException without calling SAG
    findOrganization.mockResolvedValueOnce({ id: project.organizationId });
    findProject.mockResolvedValueOnce({
      id: project.id,
      organization: {
        id: '507f1f77bcf86cd799439099',
        name: 'Other',
        slug: 'other',
      },
    });
    await expect(
      service.listPlatformFeedback({
        organizationId: project.organizationId,
        projectId: project.id,
        limit: 20,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(requestMock).not.toHaveBeenCalled();

    // Matching organizationId + projectId -> calls SAG and maps camelCase page without voter identity
    findOrganization.mockResolvedValueOnce({ id: project.organizationId });
    findProject.mockResolvedValueOnce({
      id: project.id,
      organization: { id: project.organizationId, name: 'Core', slug: 'core' },
    });
    requestMock.mockResolvedValueOnce({
      status: 200,
      body: {
        totals: { likes: 5, dislikes: 2 },
        items: [
          {
            id: 'fb_1',
            organization_id: project.organizationId,
            project_id: project.id,
            message_id: 'm2',
            voter_subject: 'MUST_NEVER_LEAK',
            rating: 'DISLIKE',
            reason_category: 'OTHER',
            reason_text: 'Thiếu trích dẫn chương 3.',
            created_at: '2026-10-30T10:00:00Z',
            updated_at: '2026-10-30T10:00:00Z',
          },
        ],
        next_cursor: 'cur.sig',
      },
    });

    const page = await service.listPlatformFeedback({
      organizationId: project.organizationId,
      projectId: project.id,
      rating: 'DISLIKE',
      limit: 20,
    });
    expect(page).toEqual({
      totals: { likes: 5, dislikes: 2 },
      items: [
        {
          id: 'fb_1',
          organizationId: project.organizationId,
          projectId: project.id,
          messageId: 'm2',
          rating: 'DISLIKE',
          reasonCategory: 'OTHER',
          reasonText: 'Thiếu trích dẫn chương 3.',
          createdAt: '2026-10-30T10:00:00Z',
          updatedAt: '2026-10-30T10:00:00Z',
        },
      ],
      nextCursor: 'cur.sig',
    });
  });

  it('rejects answer actions when Project is ARCHIVED even if a SAG session was previously cached (Finding #5)', async () => {
    const { service, getProject, requestMock, requestStreamMock } = setup();

    // Warm session cache while ACTIVE
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
        body: { feedback: null },
      });
    await service.getOwnFeedback(
      { authorization: 'Bearer continuum-jwt' },
      project.id,
      't1',
      'm2',
    );
    requestMock.mockClear();

    // Archive project -> every answer-action session endpoint fails closed with 404 NotFoundException
    const archivedProject = { ...project, status: 'ARCHIVED' as const };
    getProject.mockResolvedValue(archivedProject);

    await expect(
      service.createShare(
        { authorization: 'Bearer continuum-jwt' },
        project.id,
        't1',
        'm2',
      ),
    ).rejects.toThrow(NotFoundException);

    await expect(
      service.putOwnFeedback(
        { authorization: 'Bearer continuum-jwt' },
        project.id,
        't1',
        'm2',
        { rating: 'LIKE' },
      ),
    ).rejects.toThrow(NotFoundException);

    await expect(
      service.deleteOwnFeedback(
        { authorization: 'Bearer continuum-jwt' },
        project.id,
        't1',
        'm2',
      ),
    ).rejects.toThrow(NotFoundException);

    await expect(
      service.getOwnFeedback(
        { authorization: 'Bearer continuum-jwt' },
        project.id,
        't1',
        'm2',
      ),
    ).rejects.toThrow(NotFoundException);

    await expect(
      service.openRegenerateStream(
        { authorization: 'Bearer continuum-jwt' },
        project.id,
        't1',
        'm2',
      ),
    ).rejects.toThrow(NotFoundException);

    expect(requestMock).not.toHaveBeenCalled();
    expect(requestStreamMock).not.toHaveBeenCalled();
  });

  it('keeps BFF OpenAPI FeedbackInput conditional allOf rules in sync with approved spec (Finding #9)', () => {
    const raw = readFileSync(
      resolve(__dirname, '../../../docs/openapi/ai-chat-sag.openapi.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as {
      components?: {
        schemas?: {
          FeedbackInput?: { allOf?: unknown[] };
        };
      };
    };
    const allOf = parsed.components?.schemas?.FeedbackInput?.allOf;
    expect(Array.isArray(allOf)).toBe(true);
    expect(allOf).toHaveLength(3);
  });

  it('authorizes active Project read access on generateMindMap, forwards BFF scope headers, and validates tree/citation invariants', async () => {
    const { service, getCurrentIdentity, getProject, requestMock } = setup();

    // Unauthenticated -> 401 without calling SAG
    getCurrentIdentity.mockRejectedValueOnce(new UnauthorizedException());
    await expect(
      service.generateMindMap({ cookie: 'bad' }, project.id, {}),
    ).rejects.toThrow(UnauthorizedException);
    expect(requestMock).not.toHaveBeenCalled();

    // Missing/forbidden project -> 403/404 without calling SAG
    getProject.mockRejectedValueOnce(new ForbiddenException());
    await expect(
      service.generateMindMap({ authorization: 'Bearer ok' }, project.id, {}),
    ).rejects.toThrow(ForbiddenException);
    expect(requestMock).not.toHaveBeenCalled();

    // Archived project -> safe 404 without calling SAG
    getProject.mockResolvedValueOnce({
      ...project,
      status: 'ARCHIVED' as const,
    });
    await expect(
      service.generateMindMap({ authorization: 'Bearer ok' }, project.id, {}),
    ).rejects.toThrow(NotFoundException);
    expect(requestMock).not.toHaveBeenCalled();

    // Active project -> calls POST /api/v1/projects/:id/mind-map with verified Continuum BFF headers and sanitizes payload
    requestMock.mockResolvedValueOnce({
      status: 200,
      body: {
        projectId: project.id,
        topic: 'Bàn giao hệ thống',
        status: 'ready',
        generationMode: 'outline_fallback',
        fallbackReason: 'LLM_UNAVAILABLE',
        scopeFingerprint: 'f'.repeat(64),
        coverage: {
          accessibleReadyDocumentCount: 3,
          usedDocumentCount: 2,
          omittedDocumentCount: 1,
          pendingDocumentCount: 1,
          truncatedDocumentCount: 0,
          evidenceUnitCount: 8,
        },
        tree: {
          id: 'root',
          label: 'Continuum Core',
          summary: 'Sơ đồ theo mục lục tài liệu',
          citationNumbers: [],
          children: [
            {
              id: 'branch_1',
              label: 'Quy trình bàn giao',
              summary: 'Chi tiết checklist bàn giao',
              citationNumbers: [1],
              children: [],
            },
          ],
        },
        citations: [
          {
            number: 1,
            sourceId: 'src-1',
            documentId: '507f1f77bcf86cd799439088',
            documentName: 'Handover Guide.pdf',
            versionNo: 2,
            heading: '1. Quy trình bàn giao',
            snippet: 'Checklist bàn giao gồm 5 bước xác minh.',
            pageFrom: 3,
            pageTo: 4,
          },
        ],
        generatedAt: '2026-10-30T16:10:00Z',
      },
    });

    const mindMap = await service.generateMindMap(
      { authorization: 'Bearer ok' },
      project.id,
      { topic: 'Bàn giao hệ thống' },
    );

    expect(requestMock).toHaveBeenCalledWith({
      path: `/api/v1/projects/${project.id}/mind-map`,
      method: 'POST',
      headers: {
        'X-Continuum-User-Id': actor.id,
        'X-Continuum-Organization-Id': project.organizationId,
        'X-Continuum-Tenant-Id': project.organizationId,
        'X-Continuum-Project-Id': project.id,
        'X-Continuum-Security-Partition': project.id,
      },
      body: { topic: 'Bàn giao hệ thống' },
    });
    expect(mindMap.generationMode).toBe('outline_fallback');
    expect(mindMap.fallbackReason).toBe('LLM_UNAVAILABLE');
    expect(mindMap.tree?.children[0]?.citationNumbers).toEqual([1]);
    expect(mindMap.citations[0]?.documentId).toBe('507f1f77bcf86cd799439088');

    // Malformed upstream tree (e.g. ready status with null tree, or depth > 3) fails closed with 502 BadGatewayException
    requestMock.mockResolvedValueOnce({
      status: 200,
      body: {
        projectId: project.id,
        topic: null,
        status: 'ready',
        generationMode: 'llm',
        fallbackReason: null,
        scopeFingerprint: 'f'.repeat(64),
        coverage: {
          accessibleReadyDocumentCount: 1,
          usedDocumentCount: 1,
          omittedDocumentCount: 0,
          pendingDocumentCount: 0,
          truncatedDocumentCount: 0,
          evidenceUnitCount: 2,
        },
        tree: null,
        citations: [],
        generatedAt: '2026-10-30T16:10:00Z',
      },
    });
    await expect(
      service.generateMindMap({ authorization: 'Bearer ok' }, project.id, {}),
    ).rejects.toThrow(BadGatewayException);
  });

  it('fetches persisted Project MindMap via getMindMap, maps uninitialized and cached flags, and forwards refresh on generateMindMap', async () => {
    const { service, getProject, requestMock } = setup();

    // Archived project fails closed with 404 before calling SAG
    getProject.mockResolvedValueOnce({
      ...project,
      status: 'ARCHIVED' as const,
    });
    await expect(
      service.getMindMap({ authorization: 'Bearer ok' }, project.id),
    ).rejects.toThrow(NotFoundException);
    expect(requestMock).not.toHaveBeenCalled();

    // Uninitialized snapshot response maps cleanly with null tree
    requestMock.mockResolvedValueOnce({
      status: 200,
      body: {
        projectId: project.id,
        topic: null,
        status: 'uninitialized',
        generationMode: 'none',
        fallbackReason: null,
        scopeFingerprint: 'a'.repeat(64),
        cached: false,
        hasSourceUpdates: false,
        coverage: {
          accessibleReadyDocumentCount: 3,
          usedDocumentCount: 0,
          omittedDocumentCount: 0,
          pendingDocumentCount: 0,
          truncatedDocumentCount: 0,
          evidenceUnitCount: 0,
        },
        tree: null,
        citations: [],
        generatedAt: '2026-10-31T05:30:00Z',
      },
    });
    const uninitialized = await service.getMindMap(
      { authorization: 'Bearer ok' },
      project.id,
    );
    expect(requestMock).toHaveBeenCalledWith({
      path: `/api/v1/projects/${project.id}/mind-map`,
      method: 'GET',
      headers: {
        'X-Continuum-User-Id': actor.id,
        'X-Continuum-Organization-Id': project.organizationId,
        'X-Continuum-Tenant-Id': project.organizationId,
        'X-Continuum-Project-Id': project.id,
        'X-Continuum-Security-Partition': project.id,
      },
    });
    expect(uninitialized.status).toBe('uninitialized');
    expect(uninitialized.cached).toBe(false);
    expect(uninitialized.hasSourceUpdates).toBe(false);
    expect(uninitialized.tree).toBeNull();

    // Cached ready snapshot with topic and hasSourceUpdates=true
    requestMock.mockResolvedValueOnce({
      status: 200,
      body: {
        projectId: project.id,
        topic: 'Kiến trúc Microservice',
        status: 'ready',
        generationMode: 'llm',
        fallbackReason: null,
        scopeFingerprint: 'b'.repeat(64),
        cached: true,
        hasSourceUpdates: true,
        coverage: {
          accessibleReadyDocumentCount: 4,
          usedDocumentCount: 3,
          omittedDocumentCount: 1,
          pendingDocumentCount: 0,
          truncatedDocumentCount: 0,
          evidenceUnitCount: 9,
        },
        tree: {
          id: 'root',
          label: 'Kiến trúc Microservice',
          summary: 'Tổng quan kiến trúc',
          citationNumbers: [],
          children: [],
        },
        citations: [],
        generatedAt: '2026-10-31T05:31:00Z',
      },
    });
    const saved = await service.getMindMap(
      { authorization: 'Bearer ok' },
      project.id,
      'Kiến trúc Microservice',
    );
    expect(requestMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: `/api/v1/projects/${project.id}/mind-map?topic=${encodeURIComponent('Kiến trúc Microservice')}`,
        method: 'GET',
      }),
    );
    expect(saved.status).toBe('ready');
    expect(saved.cached).toBe(true);
    expect(saved.hasSourceUpdates).toBe(true);

    // generateMindMap forwards explicit refresh boolean
    requestMock.mockResolvedValueOnce({
      status: 200,
      body: {
        projectId: project.id,
        topic: null,
        status: 'empty',
        generationMode: 'none',
        fallbackReason: null,
        scopeFingerprint: '0'.repeat(64),
        cached: false,
        hasSourceUpdates: false,
        coverage: {
          accessibleReadyDocumentCount: 0,
          usedDocumentCount: 0,
          omittedDocumentCount: 0,
          pendingDocumentCount: 0,
          truncatedDocumentCount: 0,
          evidenceUnitCount: 0,
        },
        tree: null,
        citations: [],
        generatedAt: '2026-10-31T05:32:00Z',
      },
    });
    await service.generateMindMap({ authorization: 'Bearer ok' }, project.id, {
      refresh: false,
    });
    expect(requestMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'POST',
        body: { refresh: false },
      }),
    );
  });

  it('keeps BFF OpenAPI MindMap route and schemas synchronized with approved contract', () => {
    const raw = readFileSync(
      resolve(__dirname, '../../../docs/openapi/ai-chat-sag.openapi.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as {
      paths?: Record<
        string,
        {
          get?: { operationId?: string };
          post?: { operationId?: string };
        }
      >;
      components?: {
        schemas?: Record<string, unknown>;
      };
    };
    expect(
      parsed.paths?.['/api/v1/ai-chat/projects/{projectId}/mind-map']?.get
        ?.operationId,
    ).toBe('getAiChatMindMap');
    expect(
      parsed.paths?.['/api/v1/ai-chat/projects/{projectId}/mind-map']?.post
        ?.operationId,
    ).toBe('generateAiChatMindMap');
    expect(parsed.components?.schemas?.GenerateMindMapRequest).toBeDefined();
    expect(parsed.components?.schemas?.MindMapCoverage).toBeDefined();
    expect(parsed.components?.schemas?.MindMapNode).toBeDefined();
    expect(parsed.components?.schemas?.MindMapResponse).toBeDefined();
  });

  it('prefers public_document_id for Continuum deep-linking and preserves multiline Markdown/diagram snippets and chunkId in mapSagCitation', () => {
    const multilineDiagram = [
      '6. Trực Quan Hóa Vũ Trụ Tri Thức 3D',
      '> ⭐ ĐIỂM NHẤN CỐT LÕI',
      '```',
      '┌───────────────────────┐',
      '│ 3D KNOWLEDGE PIPELINE │',
      '└───────────────────────┘',
      '```',
    ].join('\n');

    const mapped = mapSagCitation({
      n: 4,
      source_id: 'src-fe',
      source_name: 'Frontend Docs',
      document_id: 'sag-internal-uuid-999',
      public_document_id: '507f1f77bcf86cd799439011',
      document_name: '02_FRONTEND_NEXTJS.md',
      chunk_id: 'su_chunk_4',
      section_path: 'Architecture > 6. 3D Universe',
      version_no: 1,
      heading: 'Architecture > 6. 3D Universe',
      snippet: multilineDiagram,
      page_from: 1,
      page_to: 1,
    });

    expect(mapped).toEqual({
      number: 4,
      sourceId: 'src-fe',
      sourceName: 'Frontend Docs',
      documentId: '507f1f77bcf86cd799439011',
      sagDocumentId: 'sag-internal-uuid-999',
      documentName: '02_FRONTEND_NEXTJS.md',
      chunkId: 'su_chunk_4',
      sectionPath: 'Architecture > 6. 3D Universe',
      versionNo: 1,
      heading: 'Architecture > 6. 3D Universe',
      snippet: multilineDiagram,
      label: '02_FRONTEND_NEXTJS.md · Architecture > 6. 3D Universe',
      pageFrom: 1,
      pageTo: 1,
    });
  });
});
