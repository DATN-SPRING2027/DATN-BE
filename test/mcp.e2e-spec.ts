import { INestApplication, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../src/bootstrap';
import { validateEnvironment } from '../src/config/env.validation';
import { GatewayIamController } from '../src/gateway/gateway-iam.controller';
import { GatewayMcpController } from '../src/gateway/gateway-mcp.controller';
import { AI_ENGINE_CLIENT } from '../src/integrations/ai-engine/ai-engine.port';
import { McpController } from '../src/mcp/mcp.controller';
import { AccessTokenService } from '../src/services/iam/application/authentication/access-token.service';
import { AUTH_SECURITY_STORE } from '../src/services/iam/application/authentication/auth-security.store';
import { AUTHENTICATION_REPOSITORY } from '../src/services/iam/application/authentication/authentication.repository';
import { ORGANIZATION_CONTEXT_RESOLVER } from '../src/services/iam/application/authentication/organization-context.resolver';
import { PROJECT_ACCESS_REPOSITORY } from '../src/services/iam/application/projects/project-access.repository';
import { PROJECT_REPOSITORY } from '../src/services/iam/application/projects/project.repository';
import { McpApiKeysController } from '../src/services/iam/controllers/mcp-api-keys.controller';
import type { IamModule as IamModuleType } from '../src/services/iam/iam.module';
import { NOTIFICATION_REALTIME_PUBLISHER } from '../src/services/notification/notification-realtime.bus';
import { NotificationService } from '../src/services/notification/notification.service';

const USER_ID = '651a2b3c4d5e6f7a8b9c0d1e';
const ORG_ID = '651a2b3c4d5e6f7a8b9c0d1f';
const PROJECT_A = '651a2b3c4d5e6f7a8b9c0da1';
const PROJECT_B = '651a2b3c4d5e6f7a8b9c0db2';
const SESSION_ID = '7b4e98c4-4a2d-4e36-9d69-4c42b8a093f1';

function extractRoutes(
  controller: { prototype: object },
  prefix = '',
): string[] {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).flatMap((name) => {
    if (name === 'constructor') return [];
    const fn = proto[name];
    if (typeof fn !== 'function' || !Reflect.hasMetadata(PATH_METADATA, fn)) {
      return [];
    }
    const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod;
    const rawPath = Reflect.getMetadata(PATH_METADATA, fn) as string | string[];
    const pathList = Array.isArray(rawPath) ? rawPath : [rawPath];
    return pathList.map((p) => {
      const normalized = p === '/' ? '' : p;
      return `${method}:${[prefix, normalized].filter(Boolean).join('/')}`;
    });
  });
}

describe('Continuum System-Wide MCP & API Key Lifecycle (E2E)', () => {
  let app: INestApplication;
  let iamModuleClass: typeof IamModuleType;
  let jwtToken: string;
  const prevSecret = process.env.JWT_SECRET;
  const prevInfra = process.env.INFRA_ENABLED;

  const aiEngineMock = {
    request: jest.fn((req: { path: string }) => {
      if (req.path === '/api/v1/auth/continuum-login') {
        return Promise.resolve({
          status: 200,
          body: { access_token: 'sag.jwt.token' },
        });
      }
      if (req.path === '/api/v1/agents/default') {
        return Promise.resolve({
          status: 200,
          body: { id: 'agent_default_1' },
        });
      }
      if (req.path === '/api/v1/search') {
        return Promise.resolve({
          status: 200,
          body: {
            query: 'mcp architecture',
            summary: 'Continuum exposes 28 MCP tools [1].',
            answer_status: 'answered',
            sections: [
              {
                chunk_id: 'chk_1',
                document_id: 'doc_1',
                document_name: 'MCP-Spec.md',
                heading: 'Architecture',
                content: 'Streamable HTTP JSON-RPC 2.0 on /api/v1/mcp.',
                score: 0.96,
                rank: 1,
                source_id: 'src_1',
              },
            ],
            citations: [],
            stats: {},
          },
        });
      }
      return Promise.resolve({ status: 200, body: {} });
    }),
    requestStream: jest.fn(),
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = 'mcp-e2e-test-secret-with-at-least-32-chars';
    process.env.INFRA_ENABLED = 'false';

    const { IamModule } = jest.requireActual<
      typeof import('../src/services/iam/iam.module')
    >('../src/services/iam/iam.module');
    iamModuleClass = IamModule;

    const { AppModule } =
      jest.requireActual<typeof import('../src/app.module')>(
        '../src/app.module',
      );

    const moduleBuilder = Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AUTHENTICATION_REPOSITORY)
      .useValue({
        findAccountById: jest.fn().mockResolvedValue({
          email: 'architect@continuum.ai',
          status: 'ACTIVE',
          twoFactorEnabled: false,
        }),
        findProfileById: jest.fn().mockResolvedValue({
          name: 'System Architect',
          status: 'ACTIVE',
          mutationFence: 0,
        }),
        findActiveOrganizationMembershipIds: jest
          .fn()
          .mockResolvedValue([ORG_ID]),
        hasActiveRefreshSession: jest.fn().mockResolvedValue(true),
      })
      .overrideProvider(AUTH_SECURITY_STORE)
      .useValue({
        consumeRateLimit: jest.fn().mockResolvedValue(true),
        clearRateLimit: jest.fn(),
        isTokenRevoked: jest.fn().mockResolvedValue(false),
        revokeToken: jest.fn(),
      })
      .overrideProvider(ORGANIZATION_CONTEXT_RESOLVER)
      .useValue({
        resolveForUser: jest.fn().mockResolvedValue({
          outcome: 'RESOLVED',
          context: { orgId: ORG_ID, roles: ['ADMIN', 'MEMBER'] },
        }),
      })
      .overrideProvider(PROJECT_REPOSITORY)
      .useValue({
        listVisible: jest.fn().mockResolvedValue({
          data: [
            {
              id: PROJECT_A,
              organizationId: ORG_ID,
              name: 'Project Alpha',
              code: 'ALPHA',
              visibility: 'PRIVATE',
              status: 'ACTIVE',
              createdBy: USER_ID,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
            {
              id: PROJECT_B,
              organizationId: ORG_ID,
              name: 'Project Beta',
              code: 'BETA',
              visibility: 'PRIVATE',
              status: 'ACTIVE',
              createdBy: USER_ID,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          totalItems: 2,
        }),
        findVisible: jest.fn(
          (_orgId: string, _userId: string, projectId: string) => {
            if (projectId === PROJECT_A || projectId === PROJECT_B) {
              return Promise.resolve({
                id: projectId,
                organizationId: ORG_ID,
                name:
                  projectId === PROJECT_A ? 'Project Alpha' : 'Project Beta',
                code: projectId === PROJECT_A ? 'ALPHA' : 'BETA',
                visibility: 'PRIVATE',
                status: 'ACTIVE',
                createdBy: USER_ID,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              });
            }
            return Promise.resolve(null);
          },
        ),
      })
      .overrideProvider(PROJECT_ACCESS_REPOSITORY)
      .useValue({
        listMembers: jest.fn().mockResolvedValue({
          data: [{ userId: USER_ID, status: 'ACTIVE' }],
          totalItems: 1,
        }),
        listLeaders: jest.fn().mockResolvedValue([
          {
            userId: USER_ID,
            fullName: 'System Architect',
            email: 'architect@continuum.ai',
          },
        ]),
      })
      .overrideProvider(AI_ENGINE_CLIENT)
      .useValue(aiEngineMock)
      .overrideProvider(NOTIFICATION_REALTIME_PUBLISHER)
      .useValue({
        publish: jest.fn().mockResolvedValue(undefined),
      });

    const moduleRef = await moduleBuilder.compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    configureApplication(app);
    await app.init();

    const tokenService = app.get(AccessTokenService);
    jwtToken = tokenService.signAccessToken({
      sub: USER_ID,
      email: 'architect@continuum.ai',
      orgId: ORG_ID,
      roles: ['ADMIN', 'MEMBER'],
      sid: SESSION_ID,
      userFence: 0,
    });
  }, 30000);

  afterAll(async () => {
    await app?.close();
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
    if (prevInfra === undefined) delete process.env.INFRA_ENABLED;
    else process.env.INFRA_ENABLED = prevInfra;
  });

  it('keeps GatewayIamController and GatewayMcpController routes 100% aligned with upstream MCP controllers', () => {
    const keyRoutes = extractRoutes(McpApiKeysController, 'iam/mcp-api-keys');
    const gatewayIamSet = new Set(extractRoutes(GatewayIamController));
    for (const route of keyRoutes) {
      expect(gatewayIamSet).toContain(route);
    }

    const mcpRoutes = extractRoutes(McpController, 'mcp');
    const gatewayMcpSet = new Set(extractRoutes(GatewayMcpController, 'mcp'));
    for (const route of mcpRoutes) {
      expect(gatewayMcpSet).toContain(route);
    }
  });

  it('executes full end-to-end API key minting, MCP Streamable HTTP JSON-RPC, scope & project enforcement, SAG search, and instant revocation', async () => {
    const server = app.getHttpServer() as App;

    // 1. Mint a READ_ONLY key scoped strictly to PROJECT_A
    const mintReadOnly = await request(server)
      .post('/api/v1/iam/mcp-api-keys')
      .set('Authorization', `Bearer ${jwtToken}`)
      .send({
        name: 'Claude Desktop ReadOnly',
        scope: 'READ_ONLY',
        allowedProjectIds: [PROJECT_A],
        expiresInDays: 14,
      })
      .expect(201);

    const roRawKey = (mintReadOnly.body as { rawKey: string }).rawKey;
    const roKeyId = (mintReadOnly.body as { key: { id: string } }).key.id;
    expect(roRawKey).toMatch(/^ctm_mcp_[A-Za-z0-9_-]{43}$/);

    // 2. Mint a FULL_OPERATIONS key across all accessible projects
    const mintFull = await request(server)
      .post('/api/v1/iam/mcp-api-keys')
      .set('Authorization', `Bearer ${jwtToken}`)
      .send({
        name: 'Antigravity Full Ops',
        scope: 'FULL_OPERATIONS',
        allowedProjectIds: null,
      })
      .expect(201);
    const fullRawKey = (mintFull.body as { rawKey: string }).rawKey;

    // 3. List keys via interactive JWT session -> 2 items, toolCount: 28, no rawKey exposed
    const listKeys = await request(server)
      .get('/api/v1/iam/mcp-api-keys')
      .set('Authorization', `Bearer ${jwtToken}`)
      .expect(200);
    expect(listKeys.body).toMatchObject({
      mcpEndpointPath: '/api/v1/mcp',
      protocolVersion: '2025-03-26',
      toolCount: 28,
    });
    expect((listKeys.body as { items: unknown[] }).items).toHaveLength(2);
    expect(JSON.stringify(listKeys.body)).not.toContain(roRawKey);

    // 4. MCP key CANNOT list/mint/revoke MCP keys or mutate REST endpoints directly
    await request(server)
      .get('/api/v1/iam/mcp-api-keys')
      .set('Authorization', `Bearer ${fullRawKey}`)
      .expect(401);

    const directMutation = await request(server)
      .post('/api/v1/iam/projects')
      .set('Authorization', `Bearer ${fullRawKey}`)
      .send({ name: 'Bypass', code: 'BYP' })
      .expect(403);
    expect(directMutation.body).toMatchObject({
      code: 'MCP_KEY_DIRECT_MUTATION_FORBIDDEN',
    });

    // 5. Internal loopback GET /api/v1/auth/me works with Bearer ctm_mcp_..., while cookie ctm_mcp_... is rejected
    const meLoopback = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${roRawKey}`)
      .expect(200);
    expect(meLoopback.body).toMatchObject({
      id: USER_ID,
      organizationId: ORG_ID,
      mcpGrant: {
        keyId: roKeyId,
        scope: 'READ_ONLY',
        allowedProjectIds: [PROJECT_A],
      },
    });

    await request(server)
      .get('/api/v1/auth/me')
      .set('Cookie', `continuum_access=${roRawKey}`)
      .expect(401);

    // 6. MCP Streamable HTTP discovery, SSE 405, initialize, notifications, tools/list, tools/call
    await request(server)
      .get('/api/v1/mcp')
      .set('Authorization', `Bearer ${roRawKey}`)
      .set('Accept', 'text/event-stream')
      .expect(405);

    const discovery = await request(server)
      .get('/api/v1/mcp')
      .set('Authorization', `Bearer ${roRawKey}`)
      .expect(200);
    expect(discovery.body).toMatchObject({
      name: 'continuum-mcp',
      protocolVersion: '2025-03-26',
      endpoint: '/api/v1/mcp',
      status: 'ok',
    });

    const initRpc = await request(server)
      .post('/api/v1/mcp')
      .set('Authorization', `Bearer ${roRawKey}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26' },
      })
      .expect(200);
    expect(initRpc.body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'continuum-mcp', version: '1.0.0' },
      },
    });

    await request(server)
      .post('/api/v1/mcp')
      .set('Authorization', `Bearer ${roRawKey}`)
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      .expect(202);

    // Full key sees all 28 tools; ReadOnly key sees only READ_ONLY-accessible tools
    const fullToolsRes = await request(server)
      .post('/api/v1/mcp')
      .set('Authorization', `Bearer ${fullRawKey}`)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      .expect(200);
    expect(
      (fullToolsRes.body as { result: { tools: unknown[] } }).result.tools,
    ).toHaveLength(28);

    const roToolsRes = await request(server)
      .post('/api/v1/mcp')
      .set('Authorization', `Bearer ${roRawKey}`)
      .send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
      .expect(200);
    const roToolNames = (
      roToolsRes.body as { result: { tools: Array<{ name: string }> } }
    ).result.tools.map((t) => t.name);
    expect(roToolNames).not.toContain('continuum_create_task');
    expect(roToolNames).toContain('continuum_list_projects');

    // continuum_list_projects with roRawKey returns ONLY PROJECT_A (intersects allowedProjectIds!)
    const roProjectsCall = await request(server)
      .post('/api/v1/mcp')
      .set('Authorization', `Bearer ${roRawKey}`)
      .send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'continuum_list_projects', arguments: {} },
      })
      .expect(200);
    const listedProjects = (
      roProjectsCall.body as {
        result: { structuredContent: { data: Array<{ id: string }> } };
      }
    ).result.structuredContent.data;
    expect(listedProjects.map((p) => p.id)).toEqual([PROJECT_A]);

    // Accessing PROJECT_B with roRawKey is rejected with MCP_SCOPE_FORBIDDEN
    const forbiddenProjCall = await request(server)
      .post('/api/v1/mcp')
      .set('Authorization', `Bearer ${roRawKey}`)
      .send({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'continuum_get_project',
          arguments: { projectId: PROJECT_B },
        },
      })
      .expect(200);
    expect(forbiddenProjCall.body).toMatchObject({
      result: {
        isError: true,
        structuredContent: { code: 'MCP_SCOPE_FORBIDDEN' },
      },
    });

    // Calling SAG knowledge search over MCP succeeds for PROJECT_A
    const searchCall = await request(server)
      .post('/api/v1/mcp')
      .set('Authorization', `Bearer ${roRawKey}`)
      .send({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'continuum_search_knowledge',
          arguments: { projectId: PROJECT_A, query: 'mcp architecture' },
        },
      })
      .expect(200);
    expect(searchCall.body).toMatchObject({
      result: {
        structuredContent: {
          summary: 'Continuum exposes 28 MCP tools [1].',
        },
      },
    });

    // 7. Revoke roRawKey -> immediate 401 on subsequent MCP call
    const revokeRes = await request(server)
      .delete(`/api/v1/iam/mcp-api-keys/${roKeyId}`)
      .set('Authorization', `Bearer ${jwtToken}`)
      .expect(200);
    expect(revokeRes.body).toMatchObject({
      key: { id: roKeyId, status: 'REVOKED' },
    });

    await request(server)
      .post('/api/v1/mcp')
      .set('Authorization', `Bearer ${roRawKey}`)
      .send({ jsonrpc: '2.0', id: 7, method: 'ping' })
      .expect(401);
  });

  it('forwards GET, POST, and DELETE over live HTTP through GatewayMcpController (/internal/mcp) and enforces BE-1..BE-4 contracts end-to-end', async () => {
    // Validate MCP_SERVICE_URL localhost -> 127.0.0.1 loopback normalization in env.validation.ts
    const validatedEnv = validateEnvironment({
      NODE_ENV: 'test',
      MCP_SERVICE_URL: 'http://localhost:4310',
    });
    expect(validatedEnv.MCP_SERVICE_URL).toBe('http://127.0.0.1:4310');

    await app.listen(0, '127.0.0.1');
    const httpServer = app.getHttpServer() as import('node:http').Server;
    const address = httpServer.address() as { port: number };
    const upstreamUrl = `http://127.0.0.1:${address.port}`;

    let gatewayApp: INestApplication | undefined;
    try {
      const gatewayModule = await Test.createTestingModule({
        controllers: [GatewayMcpController],
        providers: [
          {
            provide: ConfigService,
            useValue: {
              get: (key: string) => {
                if (key === 'MCP_SERVICE_URL') return upstreamUrl;
                if (key === 'SAG_CHAT_STREAM_TIMEOUT_MS') return 120000;
                return undefined;
              },
              getOrThrow: (key: string) => {
                if (key === 'BACKEND_TIMEOUT_MS') return 5000;
                throw new Error(`Unexpected config key: ${key}`);
              },
            },
          },
        ],
      }).compile();

      gatewayApp = gatewayModule.createNestApplication();
      configureApplication(gatewayApp);
      await gatewayApp.init();
      const gwServer = gatewayApp.getHttpServer() as App;

      // Mint a project-restricted READ_WRITE key on PROJECT_A
      const mintScoped = await request(app.getHttpServer() as App)
        .post('/api/v1/iam/mcp-api-keys')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          name: 'Gateway Scoped RW',
          scope: 'READ_WRITE',
          allowedProjectIds: [PROJECT_A],
        })
        .expect(201);
      const scopedRawKey = (mintScoped.body as { rawKey: string }).rawKey;

      // 1. GatewayMcpController GET /api/v1/mcp -> forwards to /internal/mcp
      const gwGet = await request(gwServer)
        .get('/api/v1/mcp')
        .set('Authorization', `Bearer ${scopedRawKey}`)
        .expect(200);
      expect(gwGet.body).toMatchObject({
        name: 'continuum-mcp',
        status: 'ok',
      });

      // 2. GatewayMcpController unauthenticated 401 forwards WWW-Authenticate + -32001
      const gwUnauth = await request(gwServer)
        .post('/api/v1/mcp')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' })
        .expect(401);
      expect(gwUnauth.headers['www-authenticate']).toBe(
        'Bearer realm="continuum-mcp"',
      );
      expect(gwUnauth.body).toMatchObject({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001 },
      });

      // 3. GatewayMcpController POST initialize (2025-11-25) & DELETE
      const gwInit = await request(gwServer)
        .post('/api/v1/mcp')
        .set('Authorization', `Bearer ${scopedRawKey}`)
        .set('MCP-Protocol-Version', '2025-11-25')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25' },
        })
        .expect(200);
      expect(gwInit.headers['mcp-protocol-version']).toBe('2025-11-25');
      expect(gwInit.body).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-11-25' },
      });

      await request(gwServer)
        .delete('/api/v1/mcp')
        .set('Authorization', `Bearer ${scopedRawKey}`)
        .expect(204);

      // 4. Malformed JSON -32700, unsupported MCP-Protocol-Version 400, id:null / 1.5 / notif-with-id -32600
      const parseErr = await request(gwServer)
        .post('/api/v1/mcp')
        .set('Authorization', `Bearer ${scopedRawKey}`)
        .set('Content-Type', 'application/json')
        .send('{"jsonrpc":"2.0"')
        .expect(400);
      expect(parseErr.body).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error: Invalid JSON payload.',
        },
      });

      await request(gwServer)
        .post('/api/v1/mcp')
        .set('Authorization', `Bearer ${scopedRawKey}`)
        .set('MCP-Protocol-Version', '1999-01-01')
        .send({ jsonrpc: '2.0', id: 2, method: 'ping' })
        .expect(400);

      for (const invalidEnvelope of [
        { jsonrpc: '2.0', id: null, method: 'ping' },
        { jsonrpc: '2.0', id: 1.5, method: 'ping' },
      ]) {
        const inv = await request(gwServer)
          .post('/api/v1/mcp')
          .set('Authorization', `Bearer ${scopedRawKey}`)
          .send(invalidEnvelope)
          .expect(200);
        expect(inv.body).toMatchObject({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600 },
        });
      }

      const notifWithIdRes = await request(gwServer)
        .post('/api/v1/mcp')
        .set('Authorization', `Bearer ${scopedRawKey}`)
        .send({ jsonrpc: '2.0', id: 99, method: 'notifications/initialized' })
        .expect(200);
      expect(notifWithIdRes.body).toMatchObject({
        jsonrpc: '2.0',
        id: 99,
        error: { code: -32600 },
      });

      // 5. Runtime inputSchema validation rejects unknown argument (additionalProperties: false)
      const badArgs = await request(gwServer)
        .post('/api/v1/mcp')
        .set('Authorization', `Bearer ${scopedRawKey}`)
        .send({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: {
            name: 'continuum_list_tasks',
            arguments: { projectId: PROJECT_A, assignee: 'me' },
          },
        })
        .expect(200);
      expect(badArgs.body).toMatchObject({
        result: {
          isError: true,
          structuredContent: { code: 'MCP_INVALID_ARGUMENTS' },
        },
      });

      // 6. Live allowedProjectIds isolation across continuum_chat, continuum_notifications, and direct REST GET
      const chatDenied = await request(gwServer)
        .post('/api/v1/mcp')
        .set('Authorization', `Bearer ${scopedRawKey}`)
        .send({
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'continuum_chat',
            arguments: { action: 'LIST_CONVERSATIONS' },
          },
        })
        .expect(200);
      expect(chatDenied.body).toMatchObject({
        result: {
          isError: true,
          structuredContent: { code: 'MCP_SCOPE_FORBIDDEN' },
        },
      });

      const notifSvc = app
        .select(iamModuleClass)
        .get(NotificationService, { strict: true });
      const [notifA] = await notifSvc.emit({
        type: 'TASK_ASSIGNED',
        actorId: '651a2b3c4d5e6f7a8b9c0d77',
        recipients: [USER_ID],
        title: 'Alpha Task',
        message: 'Assigned in Project A',
        organizationId: ORG_ID,
        projectId: PROJECT_A,
        taskId: '651a2b3c4d5e6f7a8b9c0dc3',
        target: {
          kind: 'TASK',
          url: `/projects/${PROJECT_A}/work`,
          organizationId: ORG_ID,
          projectId: PROJECT_A,
        },
        eventKey: 'e2e_notif_proj_a',
      });
      const [notifB] = await notifSvc.emit({
        type: 'TASK_ASSIGNED',
        actorId: '651a2b3c4d5e6f7a8b9c0d77',
        recipients: [USER_ID],
        title: 'Beta Secret Task',
        message: 'Secret in Project B',
        organizationId: ORG_ID,
        projectId: PROJECT_B,
        taskId: '651a2b3c4d5e6f7a8b9c0dc4',
        target: {
          kind: 'TASK',
          url: `/projects/${PROJECT_B}/work`,
          organizationId: ORG_ID,
          projectId: PROJECT_B,
        },
        eventKey: 'e2e_notif_proj_b',
      });

      const notifList = await request(gwServer)
        .post('/api/v1/mcp')
        .set('Authorization', `Bearer ${scopedRawKey}`)
        .send({
          jsonrpc: '2.0',
          id: 12,
          method: 'tools/call',
          params: {
            name: 'continuum_notifications',
            arguments: { action: 'LIST' },
          },
        })
        .expect(200);
      const notifContent = (
        notifList.body as {
          result: {
            structuredContent: {
              items: Array<{ id: string; projectId: string }>;
              unreadCount: number;
            };
          };
        }
      ).result.structuredContent;
      expect(notifContent.items.map((n) => n.id)).toEqual([notifA.id]);
      expect(notifContent.unreadCount).toBe(1);

      const notifMarkB = await request(gwServer)
        .post('/api/v1/mcp')
        .set('Authorization', `Bearer ${scopedRawKey}`)
        .send({
          jsonrpc: '2.0',
          id: 13,
          method: 'tools/call',
          params: {
            name: 'continuum_notifications',
            arguments: { action: 'MARK_READ', notificationId: notifB.id },
          },
        })
        .expect(200);
      expect(notifMarkB.body).toMatchObject({
        result: {
          isError: true,
          structuredContent: { code: 'MCP_SCOPE_FORBIDDEN' },
        },
      });

      const notifMarkAll = await request(gwServer)
        .post('/api/v1/mcp')
        .set('Authorization', `Bearer ${scopedRawKey}`)
        .send({
          jsonrpc: '2.0',
          id: 14,
          method: 'tools/call',
          params: {
            name: 'continuum_notifications',
            arguments: { action: 'MARK_ALL_READ' },
          },
        })
        .expect(200);
      expect(notifMarkAll.body).toMatchObject({
        result: {
          isError: true,
          structuredContent: { code: 'MCP_SCOPE_FORBIDDEN' },
        },
      });

      // Direct REST GET /api/v1/notifications with Bearer ctm_mcp_... blocked with 403 MCP_KEY_DIRECT_REST_FORBIDDEN
      const restNotifDenied = await request(app.getHttpServer() as App)
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${scopedRawKey}`)
        .expect(403);
      expect(restNotifDenied.body).toMatchObject({
        code: 'MCP_KEY_DIRECT_REST_FORBIDDEN',
      });
    } finally {
      await gatewayApp?.close();
      httpServer.closeAllConnections();
    }
  });
});
