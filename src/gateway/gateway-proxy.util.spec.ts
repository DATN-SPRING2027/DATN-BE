import { BadRequestException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { buildSafeInternalProxyUrl } from './gateway-proxy.util';
import { GatewayAiController } from './gateway-ai.controller';
import { GatewayCaptureController } from './gateway-capture.controller';
import { GatewayChatController } from './gateway-chat.controller';
import { GatewayIamController } from './gateway-iam.controller';
import { GatewayTaskWorkspaceController } from './gateway-task-workspace.controller';

describe('Gateway proxy hardening (SEC-BE-005 / INFRA-003 / BE-LOGIC-001)', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    '/api/v1/iam/projects/../platform/users',
    '/api/v1/iam/projects/%2e%2e/platform/users',
    '/api/v1/iam/projects/%2E%2E/platform/users',
    '/api/v1/capture/projects/1111/documents/%2f/file',
    '/api/v1/chat/conversations/..\\internal',
    '/api/v1/tasks/projects//tasks',
    '/api/v1/iam/projects/./secret',
    '/internal/admin',
  ])('SEC-BE-005: rejects traversal or malformed proxy path %s', (badUrl) => {
    expect(() =>
      buildSafeInternalProxyUrl(badUrl, 'http://127.0.0.1:3001'),
    ).toThrow(BadRequestException);
  });

  it('rewrites clean /api/v1/* paths to /internal/* preserving query parameters', () => {
    const resolved = buildSafeInternalProxyUrl(
      '/api/v1/chat/conversations/abc/attachments/def/content?download=1',
      'http://127.0.0.1:3005',
    );
    expect(resolved.toString()).toBe(
      'http://127.0.0.1:3005/internal/chat/conversations/abc/attachments/def/content?download=1',
    );
  });

  it('SEC-BE-005 & #47: GatewayChatController forwards x-organization-id, x-expected-organization-id, and attachment content security headers', async () => {
    const config = {
      get: (key: string) =>
        key === 'CAPTURE_FILE_TIMEOUT_MS' ? 60000 : undefined,
      getOrThrow: (key: string) =>
        key === 'CHAT_SERVICE_URL' ? 'http://127.0.0.1:3005' : 5000,
    };
    const controller = new GatewayChatController(config as never);
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new globalThis.Response(Buffer.from('PDFBYTES'), {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="spec.pdf"',
          'x-content-type-options': 'nosniff',
          'content-security-policy': 'sandbox',
          'content-length': '8',
        },
      }),
    );
    const response = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };

    await controller.getAttachmentContent(
      {
        method: 'GET',
        path: '/api/v1/chat/conversations/c1/attachments/a1/content',
        originalUrl: '/api/v1/chat/conversations/c1/attachments/a1/content',
        headers: {
          authorization: 'Bearer tok',
          'x-organization-id': 'org1',
          'x-expected-organization-id': 'org1',
        },
      } as unknown as Request,
      response as unknown as Response,
    );

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'manual',
    });
    const chatHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(chatHeaders['x-organization-id']).toBe('org1');
    expect(chatHeaders['x-expected-organization-id']).toBe('org1');
    expect(response.setHeader).toHaveBeenCalledWith(
      'content-disposition',
      'attachment; filename="spec.pdf"',
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'x-content-type-options',
      'nosniff',
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'content-security-policy',
      'sandbox',
    );
  });

  it('BE-LOGIC-001: GatewayCaptureController strips untrusted x-auto-sync-sag header', async () => {
    const config = {
      getOrThrow: (key: string) =>
        key === 'CAPTURE_SERVICE_URL'
          ? 'http://127.0.0.1:3002'
          : key === 'CAPTURE_FILE_TIMEOUT_MS'
            ? 120000
            : 5000,
    };
    const controller = new GatewayCaptureController(config as never);
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new globalThis.Response('{}', { status: 200 }));
    const response = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };

    await controller.createDocument(
      {
        method: 'POST',
        originalUrl: '/api/v1/capture/projects/1111/documents',
        headers: {
          'x-auto-sync-sag': 'true',
          'x-expected-organization-id': 'org1',
          authorization: 'Bearer tok',
        },
        body: { title: 'Doc' },
      } as unknown as Request,
      response as unknown as Response,
    );

    const forwardedHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(forwardedHeaders['x-auto-sync-sag']).toBeUndefined();
    expect(forwardedHeaders['x-expected-organization-id']).toBe('org1');
  });

  it('INFRA-003 & SEC-BE-005: GatewayAiController proxies AI Chat SSE and SAG SSO routes with redirect: manual', async () => {
    const config = {
      get: (key: string) =>
        key === 'SAG_CHAT_STREAM_TIMEOUT_MS' ? 120000 : undefined,
      getOrThrow: (key: string) =>
        key === 'IAM_SERVICE_URL' ? 'http://127.0.0.1:3001' : 5000,
    };
    const controller = new GatewayAiController(config as never);
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new globalThis.Response('{"code":"abc"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const response = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };

    await controller.postSagLogin(
      {
        method: 'POST',
        originalUrl: '/api/v1/ai-engine/auth/sag-login',
        headers: {
          authorization: 'Bearer tok',
          'x-expected-organization-id': 'org1',
        },
        body: { projectId: 'p1', state: 'state_1234567890' },
      } as unknown as Request,
      response as unknown as Response,
    );

    const calledTarget = fetchMock.mock.calls[0]?.[0];
    const calledUrl =
      calledTarget instanceof URL
        ? calledTarget.href
        : typeof calledTarget === 'string'
          ? calledTarget
          : calledTarget?.url;
    expect(calledUrl).toBe(
      'http://127.0.0.1:3001/internal/ai-engine/auth/sag-login',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'manual',
    });
  });

  it('SEC-BE-005: GatewayTaskWorkspaceController enforces redirect: manual and rejects dot-segment paths', async () => {
    const config = {
      get: () => undefined,
      getOrThrow: (key: string) =>
        key === 'IAM_SERVICE_URL' ? 'http://127.0.0.1:3001' : 5000,
    };
    const controller = new GatewayTaskWorkspaceController(config as never);
    const response = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };

    await expect(
      controller.listProjectTasks(
        {
          method: 'GET',
          originalUrl: '/api/v1/tasks/projects/../organization/tasks',
          headers: {},
        } as unknown as Request,
        response as unknown as Response,
      ),
    ).rejects.toThrow(BadRequestException);

    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new globalThis.Response('{"items":[]}', { status: 200 }),
      );
    await controller.listProjectTasks(
      {
        method: 'GET',
        originalUrl: '/api/v1/tasks/projects/507f1f77bcf86cd799439033/tasks',
        headers: { 'x-expected-organization-id': 'org1' },
      } as unknown as Request,
      response as unknown as Response,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'manual',
    });
    const taskHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(taskHeaders['x-expected-organization-id']).toBe('org1');
  });

  it('INFRA-003 & INFRA-005: GatewayIamController signs client IP on /auth/invitations/resolve and /iam/organizations/slug-availability', async () => {
    const config = {
      getOrThrow: (key: string) =>
        key === 'IAM_GATEWAY_SECRET'
          ? 'gateway-secret-with-at-least-thirty-two-characters'
          : key === 'IAM_SERVICE_URL'
            ? 'http://127.0.0.1:3001'
            : 5000,
    };
    const controller = new GatewayIamController(config as never);
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new globalThis.Response('{}', { status: 200 }));
    const response = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };

    await controller.checkOrganizationSlugAvailability(
      {
        method: 'GET',
        path: '/api/v1/iam/organizations/slug-availability',
        originalUrl: '/api/v1/iam/organizations/slug-availability?slug=acme',
        ip: '203.0.113.10',
        headers: { authorization: 'Bearer tok' },
      } as unknown as Request,
      response as unknown as Response,
    );

    const forwarded = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(forwarded['x-iam-source-ip']).toBe('203.0.113.10');
    expect(forwarded['x-iam-source-signature']).toEqual(expect.any(String));
  });
});
