import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../bootstrap';
import {
  AuthenticationApplicationService,
  type AuthenticatedIdentity,
} from '../services/iam/application/authentication/authentication.application.service';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

describe('McpController Streamable HTTP Contract (Packet C)', () => {
  let app: import('@nestjs/common').INestApplication;
  const actor: AuthenticatedIdentity = {
    id: '651a2b3c4d5e6f7a8b9c0d1e',
    email: 'dev@continuum.ai',
    name: 'Dev User',
    organizationId: '651a2b3c4d5e6f7a8b9c0d1f',
    roles: ['MEMBER'],
    mcpGrant: {
      keyId: '651a2b3c4d5e6f7a8b9c0d99',
      scope: 'READ_ONLY',
      allowedProjectIds: null,
    },
  };

  const handlePayload = jest.fn((_ctx: unknown, body: unknown) => {
    if (
      typeof body === 'object' &&
      body !== null &&
      !Array.isArray(body) &&
      (body as { method?: string }).method?.startsWith('notifications/')
    ) {
      return Promise.resolve({ kind: 'accepted' as const });
    }
    return Promise.resolve({
      kind: 'response' as const,
      protocolVersion: '2025-03-26',
      body: {
        jsonrpc: '2.0' as const,
        id: 1,
        result: { ok: true },
      },
    });
  });

  beforeAll(async () => {
    const getCurrentIdentity = jest.fn(
      (authorization?: string, cookie?: string) => {
        if (
          authorization === 'Bearer ctm_mcp_valid' ||
          cookie?.includes('continuum_access=valid-jwt')
        ) {
          return Promise.resolve(actor);
        }
        return Promise.reject(
          new UnauthorizedException({
            code: 'AUTHENTICATION_FAILED',
            message: 'Authentication failed.',
          }),
        );
      },
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [McpController],
      providers: [
        { provide: McpService, useValue: { handlePayload } },
        {
          provide: AuthenticationApplicationService,
          useValue: { getCurrentIdentity },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApplication(app);
    await app.init();
  }, 15000);

  afterAll(async () => {
    await app?.close();
  });

  it('handles GET /api/v1/mcp (401 unauthenticated, 405 for SSE Accept, 200 JSON discovery) and DELETE /api/v1/mcp (204)', async () => {
    const server = app.getHttpServer() as App;

    await request(server).get('/api/v1/mcp').expect(401);

    const sseRes = await request(server)
      .get('/api/v1/mcp')
      .set('Authorization', 'Bearer ctm_mcp_valid')
      .set('Accept', 'text/event-stream')
      .expect(405);
    expect(sseRes.headers.allow).toBe('POST, DELETE, OPTIONS');

    const discovery = await request(server)
      .get('/api/v1/mcp')
      .set('Authorization', 'Bearer ctm_mcp_valid')
      .set('Accept', 'application/json')
      .expect(200);
    expect(discovery.body).toEqual({
      name: 'continuum-mcp',
      version: '1.0.0',
      protocolVersion: '2025-03-26',
      endpoint: '/api/v1/mcp',
      status: 'ok',
    });

    await request(server)
      .delete('/api/v1/mcp')
      .set('Authorization', 'Bearer ctm_mcp_valid')
      .expect(204);
  });

  it('handles POST /api/v1/mcp JSON-RPC requests, 202 notifications, and cookie CSRF enforcement', async () => {
    const server = app.getHttpServer() as App;

    const rpcRes = await request(server)
      .post('/api/v1/mcp')
      .set('Authorization', 'Bearer ctm_mcp_valid')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' })
      .expect(200);
    expect(rpcRes.headers['mcp-protocol-version']).toBe('2025-03-26');
    expect(rpcRes.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { ok: true },
    });

    await request(server)
      .post('/api/v1/mcp')
      .set('Authorization', 'Bearer ctm_mcp_valid')
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      .expect(202);

    // Cookie-authenticated call without matching CSRF fails closed with 403
    await request(server)
      .post('/api/v1/mcp')
      .set('Cookie', 'continuum_access=valid-jwt; __Host-csrf=csrf123')
      .send({ jsonrpc: '2.0', id: 2, method: 'ping' })
      .expect(403);

    // Cookie-authenticated call WITH matching CSRF succeeds
    await request(server)
      .post('/api/v1/mcp')
      .set('Cookie', 'continuum_access=valid-jwt; __Host-csrf=csrf123')
      .set('X-CSRF-Token', 'csrf123')
      .send({ jsonrpc: '2.0', id: 2, method: 'ping' })
      .expect(200);
  });

  it('mounts /internal/mcp and enforces JSON-RPC 2.0 -32700 parse errors, -32600 primitive bodies, 401 WWW-Authenticate, MCP-Protocol-Version 400, and X-Request-Id CORS', async () => {
    const server = app.getHttpServer() as App;

    // 1. /internal/mcp supports GET, POST, and DELETE without /api/v1 prefix
    const internalDiscovery = await request(server)
      .get('/internal/mcp')
      .set('Authorization', 'Bearer ctm_mcp_valid')
      .expect(200);
    expect(internalDiscovery.body).toMatchObject({
      name: 'continuum-mcp',
      status: 'ok',
    });

    await request(server)
      .post('/internal/mcp')
      .set('Authorization', 'Bearer ctm_mcp_valid')
      .send({ jsonrpc: '2.0', id: 10, method: 'ping' })
      .expect(200);

    await request(server)
      .delete('/internal/mcp')
      .set('Authorization', 'Bearer ctm_mcp_valid')
      .expect(204);

    // 2. Unauthenticated 401 emits WWW-Authenticate and JSON-RPC -32001 envelope
    for (const mcpPath of ['/api/v1/mcp', '/internal/mcp']) {
      const unauth = await request(server)
        .post(mcpPath)
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' })
        .expect(401);
      expect(unauth.headers['www-authenticate']).toBe(
        'Bearer realm="continuum-mcp"',
      );
      expect(unauth.body).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32001,
          message: 'Authentication required.',
        },
      });
    }

    // 3. Malformed JSON returns 400 with JSON-RPC -32700 Parse error
    const malformed = await request(server)
      .post('/api/v1/mcp')
      .set('Authorization', 'Bearer ctm_mcp_valid')
      .set('Content-Type', 'application/json')
      .send('{"jsonrpc":"2.0"')
      .expect(400);
    expect(malformed.body).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error: Invalid JSON payload.',
      },
    });

    // 4. Non-object/non-array JSON primitives return 400 with JSON-RPC -32600 Invalid Request
    for (const rawPrimitive of ['null', '42', '"str"', 'true']) {
      const primRes = await request(server)
        .post('/api/v1/mcp')
        .set('Authorization', 'Bearer ctm_mcp_valid')
        .set('Content-Type', 'application/json')
        .send(rawPrimitive)
        .expect(400);
      expect(primRes.body).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'Invalid Request.',
        },
      });
    }

    // 5. Unsupported MCP-Protocol-Version header returns 400 with -32600
    const badVersion = await request(server)
      .post('/api/v1/mcp')
      .set('Authorization', 'Bearer ctm_mcp_valid')
      .set('MCP-Protocol-Version', '1999-01-01')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' })
      .expect(400);
    expect(badVersion.body).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: 'Unsupported MCP-Protocol-Version header.',
      },
    });

    // Supported 2025-11-25 header succeeds
    await request(server)
      .post('/api/v1/mcp')
      .set('Authorization', 'Bearer ctm_mcp_valid')
      .set('MCP-Protocol-Version', '2025-11-25')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' })
      .expect(200);

    // 6. CORS preflight allows X-Request-Id
    const preflight = await request(server)
      .options('/api/v1/mcp')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization, X-Request-Id')
      .expect(204);
    expect(
      String(preflight.headers['access-control-allow-headers']).toLowerCase(),
    ).toContain('x-request-id');
  });
});
