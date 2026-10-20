import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MongooseModule } from '@nestjs/mongoose';
import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { X509Certificate } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { HttpsOptions } from '@nestjs/common/interfaces/external/https-options.interface';
import type { AddressInfo, Server } from 'node:net';
import { checkServerIdentity, type TLSSocket } from 'node:tls';
import {
  RequireTaskAuthorization,
  TaskAuthorizationHttpGuard,
  getTaskAuthorizedRequestContext,
  type TaskHttpRequestBinding,
} from '../../services/task/runtime/task-authorization-http.guard';
import {
  TASK_OPERATION_PERMISSION_POLICY,
  TASK_PROJECT_SCOPE_EVIDENCE_PROVIDER,
  TASK_RESOURCE_PROJECT_RESOLVER,
  TaskAuthorizationBoundary,
  type TaskOperationPermissionPolicy,
  type TaskProjectScopeEvidenceProvider,
  type TaskResourceProjectResolver,
} from '../../services/task/runtime/task-authorization-boundary';
import {
  TASK_INBOUND_CONTEXT_VERIFIER,
  TaskInboundContextTrustBoundary,
  TaskInboundContextVerificationError,
  type TaskInboundContextVerifier,
} from '../../services/task/runtime/task-inbound-context';
import {
  TaskGatewayClient,
  TaskGatewayClientError,
  type TaskGatewayProofProvider,
  type TaskGatewayRequest,
  type TaskGatewayRequestBinding,
} from './task-gateway-client';
import {
  createTaskMtlsCertificates,
  GATEWAY_TEST_CLIENT_IDENTITY,
  TASK_TEST_SERVER_IDENTITY,
  type TaskMtlsCertificates,
} from '../../../test/support/task-mtls-certificates';

const testSinkToken = Symbol('TASK_GATEWAY_HTTP_TEST_SINK');
const proof = 'fixture-only-opaque-proof';
const actorUserId = '0123456789abcdef01234567';
const projectId = 'abcdef0123456789abcdef01';
const mismatchedProjectId = 'fedcba9876543210fedcba98';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

interface HttpTestState {
  readonly bindings: unknown[];
  readonly authorizedContexts: unknown[];
  readonly inboundHeaders: Record<string, string | string[] | undefined>[];
  readonly slowEntered: Deferred<void>;
  readonly slowAborted: Deferred<void>;
  readonly slowBodyEntered: Deferred<void>;
  readonly slowBodyAborted: Deferred<void>;
  readonly handler: jest.Mock;
}

@Controller('fixture/projects/:projectId/tasks')
class TaskGatewayHttpFixtureController {
  constructor(@Inject(testSinkToken) private readonly state: HttpTestState) {}

  @Get()
  @UseGuards(TaskAuthorizationHttpGuard)
  @RequireTaskAuthorization({ operation: 'list', projectIdParam: 'projectId' })
  list(@Req() request: Request): Record<string, unknown> {
    this.record(request);
    return { ok: true, context: this.state.authorizedContexts.at(-1) };
  }

  @Post()
  @UseGuards(TaskAuthorizationHttpGuard)
  @RequireTaskAuthorization({
    operation: 'create',
    projectIdParam: 'projectId',
  })
  create(
    @Body() body: unknown,
    @Req() request: Request,
  ): Record<string, unknown> {
    this.record(request);
    this.state.handler(body);
    return { ok: true, context: this.state.authorizedContexts.at(-1) };
  }

  @Get('slow')
  @UseGuards(TaskAuthorizationHttpGuard)
  @RequireTaskAuthorization({ operation: 'list', projectIdParam: 'projectId' })
  slow(@Req() request: Request, @Res() response: Response): Promise<void> {
    this.record(request);
    this.state.slowEntered.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        response.status(200).json({ ok: true });
        resolve();
      }, 15_000);
      const cleanup = () => {
        clearTimeout(timer);
        this.state.slowAborted.resolve();
        resolve();
      };
      request.once('aborted', cleanup);
      response.once('close', cleanup);
    });
  }

  @Get('slow-body')
  @UseGuards(TaskAuthorizationHttpGuard)
  @RequireTaskAuthorization({ operation: 'list', projectIdParam: 'projectId' })
  slowBody(@Req() request: Request, @Res() response: Response): void {
    this.record(request);
    response.status(200).type('text/plain').write('headers sent');
    this.state.slowBodyEntered.resolve();
    const timer = setTimeout(() => response.end('body completed'), 2_000);
    const cleanup = () => {
      clearTimeout(timer);
      if (!response.writableEnded) this.state.slowBodyAborted.resolve();
    };
    request.once('aborted', cleanup);
    response.once('close', cleanup);
  }

  @Get('unavailable')
  @UseGuards(TaskAuthorizationHttpGuard)
  @RequireTaskAuthorization({ operation: 'list', projectIdParam: 'projectId' })
  unavailable(@Req() request: Request, @Res() response: Response): void {
    this.record(request);
    response.status(503).json({ code: 'FIXTURE_UNAVAILABLE' });
  }

  private record(request: Request): void {
    this.state.authorizedContexts.push(
      getTaskAuthorizedRequestContext(request),
    );
    this.state.inboundHeaders.push(request.headers);
  }
}

async function createTaskHttpFixture(options?: {
  verifiedProjectId?: string;
  httpsOptions?: HttpsOptions;
  expectedClientIdentity?: string;
}) {
  const state: HttpTestState = {
    bindings: [],
    authorizedContexts: [],
    inboundHeaders: [],
    slowEntered: deferred<void>(),
    slowAborted: deferred<void>(),
    slowBodyEntered: deferred<void>(),
    slowBodyAborted: deferred<void>(),
    handler: jest.fn(),
  };
  const verifier: TaskInboundContextVerifier = {
    verify: jest.fn((candidate: unknown, binding: unknown) => {
      state.bindings.push(binding);
      if (candidate !== proof) {
        throw new TaskInboundContextVerificationError('INVALID_SIGNATURE');
      }
      const bound = binding as TaskHttpRequestBinding;
      return {
        actorUserId,
        gatewayServiceId: 'explicit-test-fixture',
        projectId: options?.verifiedProjectId ?? bound.projectId,
        requestId: 'test-request-id',
      };
    }),
  };
  const scopeProvider: TaskProjectScopeEvidenceProvider = {
    resolve: ({ actorUserId: actor, projectId: project }) => ({
      kind: 'resolved',
      evidence: {
        actorUserId: actor,
        projectId: project,
        organizationId: 'test-organization',
        organizationMembershipStatus: 'ACTIVE',
        projectMembershipStatus: 'ACTIVE',
      },
    }),
  };
  const permissionPolicy: TaskOperationPermissionPolicy = {
    decide: jest.fn(() => 'ALLOW'),
  };
  const resourceResolver: TaskResourceProjectResolver = {
    resolveProjectId: jest.fn(({ requestedProjectId }) => requestedProjectId),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [TaskGatewayHttpFixtureController],
    providers: [
      TaskAuthorizationHttpGuard,
      TaskAuthorizationBoundary,
      TaskInboundContextTrustBoundary,
      { provide: TASK_INBOUND_CONTEXT_VERIFIER, useValue: verifier },
      {
        provide: TASK_PROJECT_SCOPE_EVIDENCE_PROVIDER,
        useValue: scopeProvider,
      },
      { provide: TASK_OPERATION_PERMISSION_POLICY, useValue: permissionPolicy },
      { provide: TASK_RESOURCE_PROJECT_RESOLVER, useValue: resourceResolver },
      { provide: testSinkToken, useValue: state },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({
    logger: false,
    rawBody: true,
    ...(options?.httpsOptions ? { httpsOptions: options.httpsOptions } : {}),
  });
  if (options?.expectedClientIdentity) {
    app.use((request: Request, response: Response, next: NextFunction) => {
      const socket = request.socket as TLSSocket;
      const peerCertificate = socket.getPeerCertificate();
      if (!socket.authorized || !peerCertificate.raw) {
        response.status(401).end();
        return;
      }
      const peer = new X509Certificate(peerCertificate.raw);
      if (peer.subjectAltName !== `DNS:${options.expectedClientIdentity}`) {
        response.status(403).end();
        return;
      }
      next();
    });
    const tlsServer = app.getHttpServer() as Server;
    tlsServer.on('tlsClientError', () => {
      // Keep test TLS handshake errors out of externally visible responses.
    });
  }
  await app.listen(0, '127.0.0.1');
  const address = (app.getHttpServer() as Server).address() as AddressInfo;

  return {
    app,
    endpoint: `${options?.httpsOptions ? 'https' : 'http'}://127.0.0.1:${address.port}`,
    state,
    close: () => app.close(),
  };
}

function makeProofProvider() {
  return {
    createProof: jest.fn(
      (binding: TaskGatewayRequestBinding, signal: AbortSignal) => {
        void binding;
        void signal;
        return Promise.resolve(proof);
      },
    ),
  };
}

function makeClient(
  endpoint: string,
  proofProvider: TaskGatewayProofProvider = makeProofProvider(),
  timeoutMs = 2_000,
): TaskGatewayClient {
  return new TaskGatewayClient({ endpoint, proofProvider, timeoutMs });
}

function createMtlsFetch(
  certificates: TaskMtlsCertificates,
  clientCertificate?: TaskMtlsCertificates['trustedClient'],
): typeof globalThis.fetch {
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const target =
      input instanceof URL
        ? input
        : typeof input === 'string'
          ? new URL(input)
          : new URL(input.url);
    const requestHeaders = Object.fromEntries(
      new Headers(init?.headers).entries(),
    );
    return new Promise<Awaited<ReturnType<typeof globalThis.fetch>>>(
      (resolve, reject) => {
        const request = httpsRequest(
          target,
          {
            method: init?.method,
            headers: requestHeaders,
            ca: certificates.ca,
            ...(clientCertificate
              ? {
                  cert: clientCertificate.cert,
                  key: clientCertificate.key,
                }
              : {}),
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
            servername: TASK_TEST_SERVER_IDENTITY,
            checkServerIdentity: (_hostname, peerCertificate) =>
              checkServerIdentity(TASK_TEST_SERVER_IDENTITY, peerCertificate),
            ...(init?.signal ? { signal: init.signal } : {}),
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer | string) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            response.once('error', reject);
            response.once('end', () => {
              const responseHeaders = new Headers();
              for (const [name, value] of Object.entries(response.headers)) {
                if (value !== undefined) {
                  responseHeaders.set(
                    name,
                    Array.isArray(value) ? value.join(', ') : value,
                  );
                }
              }
              resolve(
                new globalThis.Response(Buffer.concat(chunks), {
                  status: response.statusCode ?? 500,
                  headers: responseHeaders,
                }),
              );
            });
          },
        );
        request.once('error', reject);
        const body = init?.body;
        if (body === null || body === undefined) {
          request.end();
        } else if (typeof body === 'string' || body instanceof Uint8Array) {
          request.end(body);
        } else {
          request.destroy(new TypeError('Unsupported fixture request body'));
        }
      },
    );
  };
  return fetch;
}

function listRequest(
  target = `/fixture/projects/${projectId}/tasks`,
): TaskGatewayRequest {
  return { method: 'GET', target, projectId };
}

describe('dormant Task Gateway adapter over a real Task HTTP fixture', () => {
  jest.setTimeout(10_000);

  it('does not initialize a MongoDB connection for the HTTP boundary fixture', async () => {
    const forRoot = jest.spyOn(MongooseModule, 'forRoot');
    let close: (() => Promise<void>) | undefined;
    try {
      const fixture = await createTaskHttpFixture();
      close = fixture.close;
      expect(forRoot).not.toHaveBeenCalled();
    } finally {
      await close?.();
      forRoot.mockRestore();
    }
  });

  it('propagates only the injected opaque proof and binds the server-observed request', async () => {
    const fixture = await createTaskHttpFixture();
    const proofProvider = makeProofProvider();
    try {
      const response = await makeClient(
        fixture.endpoint,
        proofProvider,
      ).request(listRequest());

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        context: {
          actorUserId,
          gatewayServiceId: 'explicit-test-fixture',
          projectId,
        },
      });
      expect(proofProvider.createProof).toHaveBeenCalledWith(
        {
          method: 'GET',
          target: `/fixture/projects/${projectId}/tasks`,
          projectId,
        },
        expect.any(AbortSignal),
      );
      expect(fixture.state.inboundHeaders[0]).toMatchObject({
        authorization: `Bearer ${proof}`,
      });
      expect(fixture.state.inboundHeaders[0]).not.toHaveProperty(
        'x-actor-user-id',
      );
      expect(fixture.state.inboundHeaders[0]).not.toHaveProperty(
        'x-project-id',
      );
    } finally {
      await fixture.close();
    }
  });

  it('binds the exact JSON body bytes and ignores caller-supplied identity headers', async () => {
    const fixture = await createTaskHttpFixture();
    const proofProvider = makeProofProvider();
    const target = `/fixture/projects/${projectId}/tasks`;
    const body = Buffer.from(JSON.stringify({ title: 'A Task' }));
    try {
      const response = await makeClient(
        fixture.endpoint,
        proofProvider,
      ).request({
        ...({
          method: 'POST',
          target,
          projectId,
          body,
          headers: {
            'x-actor-user-id': 'forged-user',
            'x-project-id': 'forged-project',
          },
        } as unknown as TaskGatewayRequest),
      });

      expect(response.status).toBe(201);
      expect(fixture.state.handler).toHaveBeenCalledWith({ title: 'A Task' });
      expect(fixture.state.inboundHeaders[0]).not.toHaveProperty(
        'x-actor-user-id',
      );
      expect(fixture.state.inboundHeaders[0]).not.toHaveProperty(
        'x-project-id',
      );
      const binding = proofProvider.createProof.mock.calls[0]?.[0];
      expect(binding).toEqual({
        method: 'POST',
        target,
        projectId,
        bodySha256: createHash('sha256').update(body).digest('base64url'),
      });
      expect(fixture.state.bindings[0]).toEqual(binding);
    } finally {
      await fixture.close();
    }
  });

  it('does not reach the Task handler when verified Project context mismatches the request', async () => {
    const fixture = await createTaskHttpFixture({
      verifiedProjectId: mismatchedProjectId,
    });
    try {
      const response = await makeClient(fixture.endpoint).request(
        listRequest(),
      );
      // ERR-1: a request that must not reveal existence is answered 404.
      expect(response.status).toBe(404);
      expect(fixture.state.authorizedContexts).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it('does not reach the Task handler when the HTTP verifier rejects the proof', async () => {
    const fixture = await createTaskHttpFixture();
    const invalidProofProvider: TaskGatewayProofProvider = {
      createProof: jest.fn(() => 'unverified-proof'),
    };
    try {
      const response = await makeClient(
        fixture.endpoint,
        invalidProofProvider,
      ).request({
        ...listRequest(),
        ...({
          headers: {
            'x-actor-user-id': actorUserId,
            'x-project-id': projectId,
          },
        } as unknown as Partial<TaskGatewayRequest>),
      });

      // ERR-1: an unverified credential is answered 401, never a generic 403.
      expect(response.status).toBe(401);
      expect(fixture.state.authorizedContexts).toHaveLength(0);
      expect(fixture.state.handler).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it('returns upstream errors without inventing a public error mapping', async () => {
    const fixture = await createTaskHttpFixture();
    try {
      const response = await makeClient(fixture.endpoint).request(
        listRequest(`/fixture/projects/${projectId}/tasks/unavailable`),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: 'FIXTURE_UNAVAILABLE' });
    } finally {
      await fixture.close();
    }
  });

  it('aborts the in-flight HTTP request on timeout and cleans up the fixture request', async () => {
    const fixture = await createTaskHttpFixture();
    try {
      const client = makeClient(fixture.endpoint, makeProofProvider(), 75);
      const pending = client.request(
        listRequest(`/fixture/projects/${projectId}/tasks/slow`),
      );
      await fixture.state.slowEntered.promise;
      await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
      await fixture.state.slowAborted.promise;
    } finally {
      await fixture.close();
    }
  });

  it('propagates caller cancellation and closes the in-flight HTTP request', async () => {
    const fixture = await createTaskHttpFixture();
    const controller = new AbortController();
    try {
      const pending = makeClient(fixture.endpoint).request(
        listRequest(`/fixture/projects/${projectId}/tasks/slow`),
        controller.signal,
      );
      await fixture.state.slowEntered.promise;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      await fixture.state.slowAborted.promise;
    } finally {
      await fixture.close();
    }
  });

  it('keeps the deadline active while receiving the HTTP response body', async () => {
    const fixture = await createTaskHttpFixture();
    try {
      const pending = makeClient(
        fixture.endpoint,
        makeProofProvider(),
        75,
      ).request(listRequest(`/fixture/projects/${projectId}/tasks/slow-body`));
      await fixture.state.slowBodyEntered.promise;

      await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
      await fixture.state.slowBodyAborted.promise;
    } finally {
      await fixture.close();
    }
  });

  it('fails closed before network access when configuration or the proof provider is missing', async () => {
    const fetch = jest.fn(() =>
      Promise.resolve(new Response()),
    ) as unknown as typeof globalThis.fetch;
    const withoutConfig = new TaskGatewayClient({ fetch });
    await expect(withoutConfig.request(listRequest())).rejects.toBeInstanceOf(
      TaskGatewayClientError,
    );

    const withoutProofProvider = new TaskGatewayClient({
      endpoint: 'http://127.0.0.1:33333',
      timeoutMs: 100,
      fetch,
    });
    await expect(
      withoutProofProvider.request(listRequest()),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires explicit TLS transport for HTTPS and never falls back to default fetch', async () => {
    const defaultFetch = jest.spyOn(globalThis, 'fetch');
    try {
      const client = new TaskGatewayClient({
        endpoint: 'https://127.0.0.1:33333',
        timeoutMs: 100,
        proofProvider: makeProofProvider(),
      });

      await expect(client.request(listRequest())).rejects.toMatchObject({
        code: 'INVALID_CONFIGURATION',
      });
      expect(defaultFetch).not.toHaveBeenCalled();
    } finally {
      defaultFetch.mockRestore();
    }
  });

  it('rejects production use before any HTTP(S) transport is called', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const fetch = jest.fn(() => Promise.resolve(new Response()));
    try {
      process.env.NODE_ENV = 'production';
      const client = new TaskGatewayClient({
        endpoint: 'https://127.0.0.1:33333',
        timeoutMs: 100,
        proofProvider: makeProofProvider(),
        fetch: fetch as unknown as typeof globalThis.fetch,
      });

      await expect(client.request(listRequest())).rejects.toMatchObject({
        code: 'INVALID_CONFIGURATION',
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('fails closed on proof-provider errors without exposing provider details or sending HTTP', async () => {
    const fetch = jest.fn(() =>
      Promise.resolve(new Response()),
    ) as unknown as typeof globalThis.fetch;
    const proofProvider: TaskGatewayProofProvider = {
      createProof: jest.fn(() =>
        Promise.reject(new Error('private key material must not escape')),
      ),
    };
    const client = new TaskGatewayClient({
      endpoint: 'http://127.0.0.1:33333',
      timeoutMs: 100,
      proofProvider,
      fetch,
    });

    const failure = client.request(listRequest());
    await expect(failure).rejects.toMatchObject({
      code: 'PROOF_UNAVAILABLE',
    });
    await expect(failure).rejects.not.toThrow(
      'private key material must not escape',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses non-loopback endpoints and malformed proof values before network access', async () => {
    const fetch = jest.fn(() =>
      Promise.resolve(new Response()),
    ) as unknown as typeof globalThis.fetch;
    const provider = makeProofProvider();
    const remoteClient = new TaskGatewayClient({
      endpoint: 'http://task.internal:3100',
      timeoutMs: 100,
      proofProvider: provider,
      fetch,
    });
    await expect(remoteClient.request(listRequest())).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
    const hostnameClient = new TaskGatewayClient({
      endpoint: 'http://localhost:3100',
      timeoutMs: 100,
      proofProvider: provider,
      fetch,
    });
    await expect(hostnameClient.request(listRequest())).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });

    const malformedProofProvider: TaskGatewayProofProvider = {
      createProof: jest.fn(() => 'bad\r\ncredential'),
    };
    const localClient = new TaskGatewayClient({
      endpoint: 'http://127.0.0.1:33333',
      timeoutMs: 100,
      proofProvider: malformedProofProvider,
      fetch,
    });
    await expect(localClient.request(listRequest())).rejects.toMatchObject({
      code: 'PROOF_UNAVAILABLE',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  describe('explicit local/test mutual TLS transport', () => {
    let certificates: TaskMtlsCertificates;

    beforeAll(() => {
      certificates = createTaskMtlsCertificates();
    });

    afterAll(() => {
      certificates?.cleanup();
    });

    const tlsOptions = (
      serverCertificate: TaskMtlsCertificates['server'],
    ): HttpsOptions => ({
      key: serverCertificate.key,
      cert: serverCertificate.cert,
      ca: certificates.ca,
      requestCert: true,
      rejectUnauthorized: true,
    });

    it('uses the Gateway adapter and Nest Task HTTP boundary with trusted peer identities', async () => {
      const fixture = await createTaskHttpFixture({
        httpsOptions: tlsOptions(certificates.server),
        expectedClientIdentity: GATEWAY_TEST_CLIENT_IDENTITY,
      });
      const fetch = createMtlsFetch(certificates, certificates.trustedClient);
      const proofProvider = makeProofProvider();
      const target = `/fixture/projects/${projectId}/tasks`;
      const body = Buffer.from(JSON.stringify({ title: 'TLS Task' }));
      try {
        const response = await new TaskGatewayClient({
          endpoint: fixture.endpoint,
          timeoutMs: 2_000,
          proofProvider,
          fetch,
        }).request({ method: 'POST', target, projectId, body });

        expect(new URL(fixture.endpoint).protocol).toBe('https:');
        expect(response.status).toBe(201);
        expect(fixture.state.authorizedContexts).toHaveLength(1);
        expect(fixture.state.handler).toHaveBeenCalledWith({
          title: 'TLS Task',
        });
        expect(fixture.state.inboundHeaders[0]).toMatchObject({
          authorization: `Bearer ${proof}`,
        });
        expect(proofProvider.createProof).toHaveBeenCalledWith(
          {
            method: 'POST',
            target,
            projectId,
            bodySha256: createHash('sha256').update(body).digest('base64url'),
          },
          expect.any(AbortSignal),
        );
      } finally {
        await fixture.close();
      }
    });

    it.each([
      ['missing', undefined],
      ['untrusted', 'untrustedClient'],
    ] as const)(
      'does not reach the Task guard when the Gateway client certificate is %s',
      async (_caseName, selectedCertificate) => {
        const fixture = await createTaskHttpFixture({
          httpsOptions: tlsOptions(certificates.server),
          expectedClientIdentity: GATEWAY_TEST_CLIENT_IDENTITY,
        });
        const clientCertificate = selectedCertificate
          ? certificates[selectedCertificate]
          : undefined;
        try {
          const pending = new TaskGatewayClient({
            endpoint: fixture.endpoint,
            timeoutMs: 2_000,
            proofProvider: makeProofProvider(),
            fetch: createMtlsFetch(certificates, clientCertificate),
          }).request(listRequest());
          await expect(pending).rejects.toMatchObject({
            code: 'UPSTREAM_UNAVAILABLE',
          });
          expect(fixture.state.authorizedContexts).toHaveLength(0);
        } finally {
          await fixture.close();
        }
      },
    );

    it('rejects a trusted client certificate with the wrong SAN before the Task guard', async () => {
      const fixture = await createTaskHttpFixture({
        httpsOptions: tlsOptions(certificates.server),
        expectedClientIdentity: GATEWAY_TEST_CLIENT_IDENTITY,
      });
      try {
        const response = await new TaskGatewayClient({
          endpoint: fixture.endpoint,
          timeoutMs: 2_000,
          proofProvider: makeProofProvider(),
          fetch: createMtlsFetch(
            certificates,
            certificates.mismatchedIdentityClient,
          ),
        }).request(listRequest());

        expect(response.status).toBe(403);
        expect(fixture.state.authorizedContexts).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    });

    it.each([
      ['untrusted CA', 'untrustedServer'],
      ['mismatched server SAN', 'mismatchedIdentityServer'],
    ] as const)(
      'does not reach the Task guard when the Task server certificate has %s',
      async (_caseName, serverCertificateName) => {
        const fixture = await createTaskHttpFixture({
          httpsOptions: tlsOptions(certificates[serverCertificateName]),
          expectedClientIdentity: GATEWAY_TEST_CLIENT_IDENTITY,
        });
        try {
          const pending = new TaskGatewayClient({
            endpoint: fixture.endpoint,
            timeoutMs: 2_000,
            proofProvider: makeProofProvider(),
            fetch: createMtlsFetch(certificates, certificates.trustedClient),
          }).request(listRequest());
          await expect(pending).rejects.toMatchObject({
            code: 'UPSTREAM_UNAVAILABLE',
          });
          expect(fixture.state.authorizedContexts).toHaveLength(0);
        } finally {
          await fixture.close();
        }
      },
    );
  });
});
