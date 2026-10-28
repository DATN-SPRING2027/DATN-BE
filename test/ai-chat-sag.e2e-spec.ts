import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ForbiddenException,
  INestApplication,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { configureApplication } from '../src/bootstrap';
import { validateEnvironment } from '../src/config/env.validation';
import { AiChatController } from '../src/integrations/ai-engine/ai-chat.controller';
import { AiChatService } from '../src/integrations/ai-engine/ai-chat.service';
import { AI_ENGINE_CLIENT } from '../src/integrations/ai-engine/ai-engine.port';
import { HttpAiEngineClient } from '../src/integrations/ai-engine/http-ai-engine.client';
import { AuthenticationApplicationService } from '../src/services/iam/application/authentication/authentication.application.service';
import { ProjectService } from '../src/services/iam/application/projects/project.service';

describe('AI Chat <-> SAG BFF (e2e)', () => {
  let app: INestApplication;
  let sagServer: ReturnType<typeof createServer>;
  let sagBaseUrl = '';
  const serviceToken = 't'.repeat(48);

  const actor = {
    id: '507f1f77bcf86cd799439011',
    email: 'thang@continuum.ai',
    name: 'Nguyễn Văn Thắng',
    organizationId: '507f1f77bcf86cd799439022',
    roles: ['ADMIN'],
  };
  const project = {
    id: '507f1f77bcf86cd799439033',
    organizationId: '507f1f77bcf86cd799439022',
    name: 'Continuum AI',
    code: 'CONT',
  };

  let authMock: { getCurrentIdentity: jest.Mock };
  let projectsMock: { get: jest.Mock };
  const recordedSagRequests: Array<{
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: string;
  }> = [];

  beforeAll(async () => {
    sagServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        recordedSagRequests.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers,
          body: bodyText,
        });

        if (
          req.method === 'POST' &&
          req.url === '/api/v1/auth/continuum-login'
        ) {
          if (req.headers['x-sag-bff-service-token'] !== serviceToken) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ detail: 'invalid service token' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.sig',
            }),
          );
          return;
        }

        if (req.method === 'GET' && req.url === '/api/v1/agents/default') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'agent_default' }));
          return;
        }

        if (
          req.method === 'GET' &&
          req.url?.startsWith('/api/v1/agents/agent_default/threads?')
        ) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify([
              {
                id: 'thread_1',
                agent_id: 'agent_default',
                title: 'Kiến trúc SAG ECCE',
                archived: false,
                created_at: '2026-10-28T10:00:00Z',
                updated_at: '2026-10-28T10:05:00Z',
              },
            ]),
          );
          return;
        }

        if (
          req.method === 'POST' &&
          req.url === '/api/v1/agents/agent_default/threads'
        ) {
          const parsed = JSON.parse(bodyText || '{}') as { title?: string };
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'thread_2',
              agent_id: 'agent_default',
              title: parsed.title ?? 'New chat',
              archived: false,
              created_at: '2026-10-28T10:06:00Z',
              updated_at: '2026-10-28T10:06:00Z',
            }),
          );
          return;
        }

        if (
          req.method === 'DELETE' &&
          req.url === '/api/v1/agents/agent_default/threads/thread_2'
        ) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, detail: 'deleted' }));
          return;
        }

        if (
          req.method === 'GET' &&
          req.url?.startsWith(
            '/api/v1/agents/agent_default/threads/thread_1/messages?',
          )
        ) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              items: [
                {
                  id: 'msg_assistant_1',
                  thread_id: 'thread_1',
                  role: 'assistant',
                  content: 'Dùng BFF proxy an toàn [1, S1].',
                  status: 'ok',
                  prompt_preview: 'TOP_SECRET_PROMPT',
                  created_at: '2026-10-28T10:07:00Z',
                  citations: [
                    {
                      n: 1,
                      source_id: 'src_1',
                      document_id: 'doc_1',
                      document_name: 'Security Spec',
                      snippet: 'BFF mints short-lived token.',
                      page_from: 1,
                      page_to: 1,
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
                      ms: 14,
                      audit: {
                        selected_groups: [
                          {
                            citation_tag: 'S1',
                            primary_turn_id: 'u1',
                            included_turn_ids: ['u0', 'u1'],
                          },
                        ],
                        recent_turn_ids: ['u2'],
                      },
                      session_citations: [
                        {
                          kind: 'session_memory',
                          ref: 'S1',
                          primary_message_id: 'u1',
                          message_ids: ['u0', 'u1'],
                          turn_ordinals: [1, 2],
                          epistemic_status: 'CONFIRMED',
                          sha256: 'hash_s1',
                          cited_source_ids: [],
                          mapped: true,
                          claim_level: 'claim',
                        },
                        {
                          kind: 'session_memory',
                          ref: 'S2',
                          primary_message_id: 'u2',
                          message_ids: ['u2'],
                          turn_ordinals: [3],
                          epistemic_status: 'INFO',
                          sha256: 'hash_s2',
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
            }),
          );
          return;
        }

        if (
          req.method === 'POST' &&
          req.url === '/api/v1/agents/agent_default/threads/thread_1/ask'
        ) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
          });
          res.write(
            'event: run.started\ndata: {"run_id":"run_1","payload":{"user_message_id":"msg_u1"}}\n\n',
          );
          res.write(
            'event: message.delta\ndata: {"payload":{"role":"assistant","delta":"Dùng BFF proxy an toàn [1, S1]."}}\n\n',
          );
          res.write(
            'event: run.completed\ndata: ' +
              JSON.stringify({
                payload: {
                  message_id: 'msg_assistant_1',
                  output: 'Dùng BFF proxy an toàn [1, S1].',
                  answer_status: 'answered',
                  prompt_preview: 'TOP_SECRET_PROMPT',
                  citations: [
                    {
                      n: 1,
                      source_id: 'src_1',
                      document_id: 'doc_1',
                      document_name: 'Security Spec',
                      snippet: 'BFF mints short-lived token.',
                      page_from: 1,
                      page_to: 1,
                      mapped: true,
                      claim_level: 'claim',
                    },
                  ],
                },
              }) +
              '\n\n',
          );
          res.end();
          return;
        }

        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Not found' }));
      });
    });

    await new Promise<void>((resolve) =>
      sagServer.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (sagServer.address() as AddressInfo).port;
    sagBaseUrl = `http://127.0.0.1:${port}`;

    authMock = {
      getCurrentIdentity: jest.fn().mockResolvedValue(actor),
    };
    projectsMock = {
      get: jest.fn().mockResolvedValue(project),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () =>
              validateEnvironment({
                NODE_ENV: 'test',
                SAG_API_BASE_URL: sagBaseUrl,
                SAG_BFF_SERVICE_TOKEN: serviceToken,
                BACKEND_TIMEOUT_MS: 5000,
                SAG_CHAT_STREAM_TIMEOUT_MS: 30000,
              }),
          ],
        }),
      ],
      controllers: [AiChatController],
      providers: [
        AiChatService,
        { provide: AI_ENGINE_CLIENT, useClass: HttpAiEngineClient },
        { provide: AuthenticationApplicationService, useValue: authMock },
        { provide: ProjectService, useValue: projectsMock },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  beforeEach(() => {
    recordedSagRequests.length = 0;
    authMock.getCurrentIdentity.mockReset().mockResolvedValue(actor);
    projectsMock.get.mockReset().mockResolvedValue(project);
  });

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => sagServer.close(() => resolve()));
  });

  it('enforces 401/403/404 structured errors before touching SAG, including cookie CSRF protection', async () => {
    const server = app.getHttpServer() as App;

    authMock.getCurrentIdentity.mockRejectedValueOnce(
      new UnauthorizedException({ code: 'AUTH_REQUIRED', message: 'Sign in' }),
    );
    await request(server)
      .get(`/api/v1/ai-chat/projects/${project.id}/threads`)
      .expect(401);
    expect(recordedSagRequests).toHaveLength(0);

    // Cookie mutation without X-CSRF-Token -> 403 CSRF_INVALID
    const csrfResp = await request(server)
      .post(`/api/v1/ai-chat/projects/${project.id}/threads`)
      .set('Cookie', 'continuum_access=jwt; __Host-csrf=csrf123')
      .send({ title: 'Blocked' })
      .expect(403);
    expect((csrfResp.body as { code?: string }).code).toBe('CSRF_INVALID');
    expect(recordedSagRequests).toHaveLength(0);

    // Cross-project / inaccessible project -> 404 before SAG
    projectsMock.get.mockRejectedValueOnce(
      new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Not found',
      }),
    );
    await request(server)
      .post(`/api/v1/ai-chat/projects/${project.id}/threads/thread_1/ask`)
      .set('Authorization', 'Bearer continuum-jwt')
      .send({ query: 'Secret project data?' })
      .expect(404);
    expect(recordedSagRequests).toHaveLength(0);

    // Inactive org membership -> 403 before SAG
    projectsMock.get.mockRejectedValueOnce(
      new ForbiddenException({
        code: 'MEMBERSHIP_INACTIVE',
        message: 'Inactive membership',
      }),
    );
    await request(server)
      .get(`/api/v1/ai-chat/projects/${project.id}/threads/thread_1/messages`)
      .set('Authorization', 'Bearer continuum-jwt')
      .expect(403);
    expect(recordedSagRequests).toHaveLength(0);
  });

  it('completes full thread CRUD, message history, and SSE /ask streaming with ECCE citations over HTTP', async () => {
    const server = app.getHttpServer() as App;
    const cookieHeader = 'continuum_access=jwt; continuum_csrf=csrf-secret-xyz';

    const listResp = await request(server)
      .get(`/api/v1/ai-chat/projects/${project.id}/threads?limit=10&offset=0`)
      .set('Cookie', cookieHeader)
      .expect(200);
    expect(listResp.body).toEqual([
      {
        id: 'thread_1',
        title: 'Kiến trúc SAG ECCE',
        createdAt: '2026-10-28T10:00:00Z',
        updatedAt: '2026-10-28T10:05:00Z',
      },
    ]);

    const createResp = await request(server)
      .post(`/api/v1/ai-chat/projects/${project.id}/threads`)
      .set('Cookie', cookieHeader)
      .set('x-csrf-token', 'csrf-secret-xyz')
      .send({ title: 'Họp bàn giao Sprint' })
      .expect(201);
    const createdThread = createResp.body as { id?: string; title?: string };
    expect(createdThread.id).toBe('thread_2');
    expect(createdThread.title).toBe('Họp bàn giao Sprint');

    await request(server)
      .delete(`/api/v1/ai-chat/projects/${project.id}/threads/thread_2`)
      .set('Cookie', cookieHeader)
      .set('x-csrf-token', 'csrf-secret-xyz')
      .expect(204);

    const sseResp = await request(server)
      .post(`/api/v1/ai-chat/projects/${project.id}/threads/thread_1/ask`)
      .set('Cookie', cookieHeader)
      .set('x-csrf-token', 'csrf-secret-xyz')
      .send({ query: 'Giải thích cơ chế BFF?' })
      .expect(200);

    expect(sseResp.headers['content-type']).toContain('text/event-stream');
    expect(sseResp.headers['x-accel-buffering']).toBe('no');
    expect(sseResp.text).toContain('event: started');
    expect(sseResp.text).toContain('event: delta');
    expect(sseResp.text).toContain('event: completed');
    expect(sseResp.text).toContain('"ref":"S1"');
    expect(sseResp.text).toContain('"turnIds":["u1","u0"]');
    expect(sseResp.text).not.toContain('"ref":"S2"');
    expect(sseResp.text).not.toContain('TOP_SECRET_PROMPT');
    expect(sseResp.text).not.toContain(serviceToken);
    expect(sseResp.text).not.toContain('eyJhbGciOiJIUzI1NiJ9');

    const loginCalls = recordedSagRequests.filter(
      (r) => r.url === '/api/v1/auth/continuum-login',
    );
    expect(loginCalls).toHaveLength(1);
    expect(loginCalls[0]?.headers['x-continuum-name']).toBe('Nguyen Van Thang');
    expect(projectsMock.get).toHaveBeenCalledTimes(4);

    // Verify ask sent knowledge_only=true & web_enabled=false to SAG without leaking service token
    const askUpstream = recordedSagRequests.find((r) =>
      r.url.endsWith('/threads/thread_1/ask'),
    );
    expect(askUpstream).toBeDefined();
    expect(askUpstream?.headers['x-sag-bff-service-token']).toBeUndefined();
    expect(JSON.parse(askUpstream?.body ?? '{}')).toEqual({
      query: 'Giải thích cơ chế BFF?',
      web_enabled: false,
      knowledge_only: true,
    });
  });
});
