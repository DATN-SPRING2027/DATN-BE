import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import {
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign as signBytes,
} from 'node:crypto';
import { createConnection, createServer as createTcpServer } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { resolve } from 'node:path';
import { Controller, Get, Inject, Req, Res, UseGuards } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import mongoose, { type Connection } from 'mongoose';
import { configureApplication } from '../../../../bootstrap';
import { GatewayModule } from '../../../../gateway/gateway.module';
import { TASK_DISPOSABLE_FIXTURE_MARKER } from '../../infrastructure/mongodb/initialize-task-disposable-database';
import {
  DenyAllTaskOperationPermissionPolicy,
  TaskAuthorizationBoundary,
  TASK_OPERATION_PERMISSION_POLICY,
  TASK_PROJECT_SCOPE_EVIDENCE_PROVIDER,
  TASK_RESOURCE_PROJECT_RESOLVER,
  type TaskOperationPermissionFacts,
  type TaskOperationPermissionPolicy,
  type TaskProjectScopeEvidenceProvider,
  type TaskResourceProjectResolver,
} from '../task-authorization-boundary';
import {
  RequireTaskAuthorization,
  TaskAuthorizationHttpGuard,
  getTaskAuthorizedRequestContext,
} from '../task-authorization-http.guard';
import {
  TASK_INBOUND_CONTEXT_VERIFIER,
  TaskInboundContextTrustBoundary,
  TaskInboundContextVerificationError,
  type TaskInboundContextVerifier,
} from '../task-inbound-context';
import { TaskDelegationAssertionPrototypeVerifier } from './task-delegation-assertion.prototype';
import { ConsumingTaskDelegationAssertionPrototypeVerifier } from './task-delegation-replay-consumer.prototype';
import {
  MongoTaskDelegationReplayStore,
  TASK_DELEGATION_REPLAY_COLLECTION,
  TASK_DELEGATION_REPLAY_EXPIRY_INDEX,
  TASK_DELEGATION_REPLAY_UNIQUE_INDEX,
} from './task-delegation-replay-store.prototype';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? describe : describe.skip;
const configuredUri = process.env.MONGODB_URI;
const databaseName = `datn96replay_${randomUUID().replaceAll('-', '')}`;
const issuer = 'urn:datn:iam';
const audience = 'urn:datn:task';
const gatewayServiceId = 'svc:be-gateway';
const gatewayClientId = 'oauth-client:be-gateway';
const keyId = 'task-replay-integration-key';
const projectId = 'abcdef0123456789abcdef01';
const binding = {
  method: 'GET',
  target: `/api/v1/projects/${projectId}/tasks`,
  projectId,
};
const guardedDetailTarget = `/test/projects/${projectId}/tasks/fedcba9876543210fedcba98`;
const testHandlerSink = Symbol('TEST_TASK_REPLAY_HTTP_HANDLER');
const testGatewayOptionsToken = Symbol('D04_TEST_GATEWAY_OPTIONS');
const testGatewaySessionCookie = 'd04_test_session=valid';
const testGatewayActorId = '0123456789abcdef01234567';
const testGatewayServiceId = 'svc:be-gateway';
const testGatewayKeyId = keyId;
const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface TestHandlerSink {
  handle: jest.MockedFunction<(context: unknown) => void>;
}

@Controller('test/projects/:projectId/tasks/:taskId')
class ReplayGuardHttpTestController {
  constructor(
    @Inject(testHandlerSink) private readonly sink: TestHandlerSink,
  ) {}

  @Get()
  @UseGuards(TaskAuthorizationHttpGuard)
  @RequireTaskAuthorization({
    operation: 'detail',
    projectIdParam: 'projectId',
    resourceIdParam: 'taskId',
  })
  detail(@Req() requestValue: unknown): { ok: true } {
    this.sink.handle(getTaskAuthorizedRequestContext(requestValue));
    return { ok: true };
  }
}

interface TestGatewayOptions {
  taskBaseUrl: string;
  upstreamTimeoutMs?: number;
  privateKey: KeyObject;
  assertionCache: Map<string, string>;
  observedRequestIds: string[];
}

function signGatewayTestAssertion(options: {
  privateKey: KeyObject;
  target: string;
  projectId: string;
  requestId: string;
  claimProjectId?: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({
      alg: 'EdDSA',
      typ: 'task-delegation+jwt',
      kid: testGatewayKeyId,
    }),
  ).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      iss: issuer,
      aud: audience,
      sub: testGatewayActorId,
      client_id: gatewayClientId,
      act: { sub: testGatewayServiceId },
      project_id: options.claimProjectId ?? options.projectId,
      htm: 'GET',
      htu: options.target,
      jti: randomUUID(),
      rid: options.requestId,
      iat: now,
      nbf: now,
      exp: now + 60,
    }),
  ).toString('base64url');
  const signingInput = `${header}.${claims}`;
  const signature = signBytes(
    null,
    Buffer.from(signingInput, 'ascii'),
    options.privateKey,
  );
  return `${signingInput}.${signature.toString('base64url')}`;
}

/** Test-only transport adapter. It is never imported by GatewayModule. */
@Controller('task-test/projects/:projectId/tasks/:taskId')
class TestOnlyGatewayTaskAdapter {
  constructor(
    @Inject(testGatewayOptionsToken)
    private readonly options: TestGatewayOptions,
  ) {}

  @Get()
  async detail(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    if (request.headers.cookie !== testGatewaySessionCookie) {
      response.status(401).json({ code: 'TEST_SESSION_REQUIRED' });
      return;
    }

    const { projectId, taskId } = request.params as {
      projectId: string;
      taskId: string;
    };
    const target = `/test/projects/${projectId}/tasks/${taskId}`;
    const fixture = new URL(
      request.originalUrl,
      'http://test.local',
    ).searchParams.get('fixture');
    const incomingRequestId = request.headers['x-request-id'];
    const requestId =
      typeof incomingRequestId === 'string' &&
      uuidV4Pattern.test(incomingRequestId)
        ? incomingRequestId
        : randomUUID();
    this.options.observedRequestIds.push(requestId);

    let token: string;
    if (fixture === 'replay' && this.options.assertionCache.has(target)) {
      token = this.options.assertionCache.get(target)!;
    } else {
      token = signGatewayTestAssertion({
        privateKey: this.options.privateKey,
        target,
        projectId,
        requestId,
        ...(fixture === 'project-mismatch'
          ? { claimProjectId: 'ffffffffffffffffffffffff' }
          : {}),
      });
      if (fixture === 'replay') {
        this.options.assertionCache.set(target, token);
      }
    }
    if (fixture === 'invalid-signature') {
      const replacement = token.endsWith('A') ? 'B' : 'A';
      token = `${token.slice(0, -1)}${replacement}`;
    }

    try {
      const upstream = await fetch(new URL(target, this.options.taskBaseUrl), {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.options.upstreamTimeoutMs ?? 2_000),
      });
      const contentType = upstream.headers.get('content-type');
      if (contentType) response.setHeader('content-type', contentType);
      response
        .status(upstream.status)
        .send(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.status(503).json({
        code: 'TASK_UPSTREAM_UNAVAILABLE',
        message: 'Task service unavailable',
      });
    }
  }
}

async function createReplayGuardHttpApp(options: {
  verifier: TaskInboundContextVerifier;
  events: string[];
  policy: TaskOperationPermissionPolicy;
  resourceProjectId?: string;
}) {
  const sink: TestHandlerSink = {
    handle: jest.fn((context: unknown): void => {
      void context;
      options.events.push('handler');
    }),
  };
  const resourceResolver: TaskResourceProjectResolver = {
    resolveProjectId: jest.fn(({ requestedProjectId, resourceId }) => {
      options.events.push('resource');
      return requestedProjectId === projectId &&
        resourceId === 'fedcba9876543210fedcba98'
        ? (options.resourceProjectId ?? projectId)
        : undefined;
    }),
  };
  const scopeProvider: TaskProjectScopeEvidenceProvider = {
    resolve: jest.fn(({ actorUserId, projectId: requestedProjectId }) => {
      options.events.push('project-scope');
      if (
        actorUserId !== '0123456789abcdef01234567' ||
        requestedProjectId !== projectId
      ) {
        return { kind: 'denied' as const };
      }
      return {
        kind: 'resolved' as const,
        evidence: {
          actorUserId,
          projectId: requestedProjectId,
          organizationId: 'organization-from-test-fixture',
          organizationMembershipStatus: 'ACTIVE' as const,
          projectMembershipStatus: 'ACTIVE' as const,
        },
      };
    }),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [ReplayGuardHttpTestController],
    providers: [
      TaskInboundContextTrustBoundary,
      TaskAuthorizationBoundary,
      TaskAuthorizationHttpGuard,
      {
        provide: TASK_INBOUND_CONTEXT_VERIFIER,
        useValue: options.verifier,
      },
      {
        provide: TASK_PROJECT_SCOPE_EVIDENCE_PROVIDER,
        useValue: scopeProvider,
      },
      {
        provide: TASK_OPERATION_PERMISSION_POLICY,
        useValue: options.policy,
      },
      {
        provide: TASK_RESOURCE_PROJECT_RESOLVER,
        useValue: resourceResolver,
      },
      { provide: testHandlerSink, useValue: sink },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();

  return {
    app,
    httpServer: app.getHttpServer() as App,
    sink,
    scopeProvider,
    resourceResolver,
    close: async () => app.close(),
  };
}

async function createTestGatewayHttpApp(options: TestGatewayOptions): Promise<{
  app: INestApplication;
  url: string;
  close: () => Promise<void>;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [GatewayModule],
    controllers: [TestOnlyGatewayTaskAdapter],
    providers: [{ provide: testGatewayOptionsToken, useValue: options }],
  })
    .overrideProvider(ConfigService)
    .useValue({
      getOrThrow: (name: string) =>
        name === 'IAM_SERVICE_URL'
          ? 'http://iam.test:3001'
          : name === 'IAM_GATEWAY_SECRET'
            ? 'test-gateway-secret-at-least-32-characters'
            : 5000,
    })
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApplication(app);
  await app.listen(0, '127.0.0.1');
  const address = (app.getHttpServer() as HttpServer).address();
  if (!address || typeof address === 'string') {
    await app.close();
    throw new Error('Test Gateway did not bind a TCP port');
  }
  return {
    app,
    url: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
  };
}

async function createHangingUpstreamServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createHttpServer(() => {
    // Keep the connection open so the test adapter's upstream deadline fires.
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Hanging Task upstream did not bind a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
    throw new Error('Could not reserve a loopback port for the BFF fixture');
  }
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return port;
}

async function canConnectToLoopback(port: number): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolveConnect(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolveConnect(false);
    });
  });
}

async function waitForBffProcess(
  child: ChildProcess,
  port: number,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('The built Next.js BFF process exited before listening');
    }
    if (await canConnectToLoopback(port)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('The built Next.js BFF did not start within 30 seconds');
}

async function startBuiltNextBff(
  feRoot: string,
  gatewayUrl: string,
): Promise<{
  child: ChildProcess;
  port: number;
  url: string;
}> {
  const nextCli = resolve(feRoot, 'node_modules/next/dist/bin/next');
  if (!existsSync(resolve(feRoot, '.next/BUILD_ID')) || !existsSync(nextCli)) {
    throw new Error(
      'The FE worktree must have a successful Next.js production build and installed Next.js CLI',
    );
  }

  const port = await reserveLoopbackPort();
  const inheritedEnvironment = [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'APPDATA',
    'HOME',
  ];
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const name of inheritedEnvironment) {
    const value = process.env[name];
    if (value !== undefined) childEnvironment[name] = value;
  }
  childEnvironment.NODE_ENV = 'production';
  childEnvironment.NEXT_TELEMETRY_DISABLED = '1';
  childEnvironment.CONTINUUM_API_BASE_URL = gatewayUrl;

  const child = spawn(
    process.execPath,
    [nextCli, 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: feRoot,
      env: childEnvironment,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  try {
    await waitForBffProcess(child, port);
  } catch (error) {
    await closeChildProcess(child);
    throw error;
  }
  return { child, port, url: `http://127.0.0.1:${port}` };
}

function closeChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  const closed = new Promise<void>((resolveClose) => {
    child.once('close', () => resolveClose());
  });
  return (async () => {
    child.kill();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolveDelay) => {
        timer = setTimeout(() => resolveDelay(false), 5_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!exited) {
      child.kill('SIGKILL');
      const killed = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolveDelay) => {
          timer = setTimeout(() => resolveDelay(false), 5_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!killed) throw new Error('Next.js BFF child process did not exit');
    }
  })();
}

function consumingVerifier(
  assertion: { publicKey: string },
  replayStore: MongoTaskDelegationReplayStore,
): ConsumingTaskDelegationAssertionPrototypeVerifier {
  return new ConsumingTaskDelegationAssertionPrototypeVerifier(
    new TaskDelegationAssertionPrototypeVerifier({
      issuer,
      audience,
      gatewayServiceId,
      expectedClientId: gatewayClientId,
      signatureAlgorithm: 'EdDSA',
      tokenType: 'task-delegation+jwt',
      keyProvider: {
        getPublicKey: (requestedKeyId) =>
          new Map([[keyId, assertion.publicKey]]).get(requestedKeyId),
      },
    }),
    replayStore,
  );
}

function cryptoRandomId(): string {
  return randomUUID().replaceAll('-', '');
}

function safeFixtureUri(value: string | undefined): URL {
  if (!value) {
    throw new Error('Replay integration requires MONGODB_URI');
  }
  const uri = new URL(value);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(uri.hostname) ||
    !uri.username ||
    !uri.password ||
    uri.pathname !== '/continuum_task' ||
    !uri.searchParams.get('replicaSet') ||
    !uri.searchParams.get('authSource')
  ) {
    throw new Error(
      'Replay integration requires an authenticated loopback replica-set fixture URI',
    );
  }
  return uri;
}

function workerPromise(
  uri: string,
  token: string,
  publicKey: string,
): Promise<{
  exitCode: number | null;
  accepted: boolean;
  reason?: string;
}> {
  return new Promise((resolveResult, rejectResult) => {
    const repoRoot = resolve(__dirname, '../../../../..');
    const child = spawn(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        '-r',
        'tsconfig-paths/register',
        resolve(__dirname, 'task-delegation-replay-store.worker.ts'),
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          TASK_REPLAY_TEST_URI: uri,
          TASK_REPLAY_TEST_ISSUER: issuer,
          TASK_REPLAY_TEST_AUDIENCE: audience,
          TASK_REPLAY_TEST_GATEWAY_ID: gatewayServiceId,
          TASK_REPLAY_TEST_CLIENT_ID: gatewayClientId,
          TASK_REPLAY_TEST_KEY_ID: keyId,
          TASK_REPLAY_TEST_PUBLIC_KEY: publicKey,
          TASK_REPLAY_TEST_TOKEN: token,
          TASK_REPLAY_TEST_BINDING: JSON.stringify(binding),
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );

    let output = '';
    const timeout = setTimeout(() => child.kill(), 30_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', () => {
      clearTimeout(timeout);
      rejectResult(new Error('Replay test worker could not start'));
    });
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      if (exitCode !== 0) {
        rejectResult(new Error('Replay test worker failed without a result'));
        return;
      }
      try {
        const result = JSON.parse(output) as {
          accepted?: unknown;
          reason?: unknown;
        };
        if (
          typeof result.accepted !== 'boolean' ||
          (result.reason !== undefined && typeof result.reason !== 'string')
        ) {
          throw new Error();
        }
        resolveResult({
          exitCode,
          accepted: result.accepted,
          ...(typeof result.reason === 'string'
            ? { reason: result.reason }
            : {}),
        });
      } catch {
        rejectResult(
          new Error('Replay test worker returned an invalid result'),
        );
      }
    });
  });
}

function signedAssertion(requestBinding = binding): {
  token: string;
  publicKey: string;
  requestId: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const now = Math.floor(Date.now() / 1000);
  const requestId = randomUUID();
  const header = Buffer.from(
    JSON.stringify({ alg: 'EdDSA', typ: 'task-delegation+jwt', kid: keyId }),
  ).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      iss: issuer,
      aud: audience,
      sub: '0123456789abcdef01234567',
      client_id: gatewayClientId,
      act: { sub: gatewayServiceId },
      project_id: requestBinding.projectId,
      htm: requestBinding.method,
      htu: requestBinding.target,
      jti: randomUUID(),
      rid: requestId,
      iat: now,
      nbf: now,
      exp: now + 60,
    }),
  ).toString('base64url');
  const input = `${header}.${claims}`;
  const signature = signBytes(null, Buffer.from(input, 'ascii'), privateKey);
  return {
    token: `${input}.${signature.toString('base64url')}`,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    requestId,
  };
}

integration(
  'Task delegation replay prototype on an authenticated MongoDB 7 replica set',
  () => {
    let connection: Connection | undefined;
    let uri: URL;
    let store: MongoTaskDelegationReplayStore;

    beforeAll(async () => {
      uri = safeFixtureUri(configuredUri);
      uri.pathname = `/${databaseName}`;
      connection = mongoose.createConnection(uri.toString(), {
        dbName: databaseName,
        autoIndex: false,
        serverSelectionTimeoutMS: 5000,
      });
      await connection.asPromise();

      const hello = await connection.db!.admin().command({ hello: 1 });
      const build = await connection.db!.admin().command({ buildInfo: 1 });
      const marker = await connection
        .db!.client.db('admin')
        .collection<{ _id: string }>('datn_migration_test_fixture')
        .findOne({ _id: TASK_DISPOSABLE_FIXTURE_MARKER });
      if (
        !hello.setName ||
        !String(build.version).startsWith('7.') ||
        !marker
      ) {
        throw new Error(
          'Replay integration requires the marked disposable MongoDB 7 replica set',
        );
      }

      store = await MongoTaskDelegationReplayStore.create(connection);
    }, 30_000);

    afterAll(async () => {
      if (connection?.readyState === mongoose.ConnectionStates.connected) {
        const marker = await connection
          .db!.client.db('admin')
          .collection<{ _id: string }>('datn_migration_test_fixture')
          .findOne({ _id: TASK_DISPOSABLE_FIXTURE_MARKER });
        if (
          connection.name !== databaseName ||
          !/^datn96replay_[a-f\d]{32}$/.test(databaseName) ||
          !marker
        ) {
          throw new Error('Refusing to drop an unmarked replay test database');
        }
        await connection.dropDatabase();
      }
      await connection?.close();
    });

    it('uses an authenticated 7.0 replica set and creates unique plus TTL indexes', async () => {
      const build = await connection!.db!.admin().command({ buildInfo: 1 });
      expect(String(build.version)).toMatch(/^7\./);
      expect(uri.username).not.toBe('');
      expect(uri.password).not.toBe('');
      expect(
        (await connection!.db!.admin().command({ hello: 1 })).setName,
      ).toBeTruthy();

      const indexes = await connection!
        .db!.collection(TASK_DELEGATION_REPLAY_COLLECTION)
        .indexes();
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: TASK_DELEGATION_REPLAY_UNIQUE_INDEX,
            key: { issuer: 1, tokenId: 1 },
            unique: true,
          }),
          expect.objectContaining({
            name: TASK_DELEGATION_REPLAY_EXPIRY_INDEX,
            key: { retainUntil: 1 },
            expireAfterSeconds: 0,
          }),
        ]),
      );
    });

    it('allows only one of two independent processes to consume the same signed assertion', async () => {
      const assertion = signedAssertion();
      const results = await Promise.all([
        workerPromise(uri.toString(), assertion.token, assertion.publicKey),
        workerPromise(uri.toString(), assertion.token, assertion.publicKey),
      ]);

      expect(results.map(({ exitCode }) => exitCode)).toEqual([0, 0]);
      expect(results.map(({ accepted }) => accepted).sort()).toEqual([
        false,
        true,
      ]);
      expect(results.find(({ accepted }) => !accepted)?.reason).toBe(
        'VERIFICATION_FAILED',
      );
      expect(
        await connection!
          .db!.collection(TASK_DELEGATION_REPLAY_COLLECTION)
          .countDocuments(),
      ).toBe(1);
    }, 45_000);

    it('runs the consuming replay verifier through a real Nest HTTP authorization boundary', async () => {
      const requestBinding = {
        method: 'GET',
        target: guardedDetailTarget,
        projectId,
      };
      const assertion = signedAssertion(requestBinding);
      const initialReplayCount = await connection!
        .db!.collection(TASK_DELEGATION_REPLAY_COLLECTION)
        .countDocuments();
      const events: string[] = [];
      const policyFacts: TaskOperationPermissionFacts[] = [];
      const policy: TaskOperationPermissionPolicy = {
        decide: jest.fn((facts: TaskOperationPermissionFacts) => {
          events.push('permission');
          policyFacts.push(facts);
          return 'ALLOW';
        }),
      };
      const test = await createReplayGuardHttpApp({
        verifier: consumingVerifier(assertion, store),
        events,
        policy,
      });
      const authorization = `Bearer ${assertion.token}`;

      try {
        const accepted = await request(test.httpServer)
          .get(guardedDetailTarget)
          .set('authorization', authorization)
          .set('x-actor-user-id', 'forged-actor')
          .set('x-project-id', 'ffffffffffffffffffffffff')
          .set('x-internal-auth', 'forged-credential')
          .set('x-request-id', 'client-controlled-correlation-id');

        expect(accepted.status).toBe(200);
        expect(accepted.body).toEqual({ ok: true });
        expect(events).toEqual([
          'resource',
          'project-scope',
          'permission',
          'handler',
        ]);
        expect(policyFacts[0]).toMatchObject({
          actorUserId: '0123456789abcdef01234567',
          projectId,
          gatewayServiceId,
          operation: 'detail',
          resolvedResourceProjectId: projectId,
        });
        expect(test.resourceResolver.resolveProjectId).toHaveBeenCalledWith({
          resourceId: 'fedcba9876543210fedcba98',
          requestedProjectId: projectId,
        });
        expect(test.scopeProvider.resolve).toHaveBeenCalledWith({
          actorUserId: '0123456789abcdef01234567',
          projectId,
        });
        expect(test.sink.handle).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'authorized',
            actorUserId: '0123456789abcdef01234567',
            projectId,
            requestId: assertion.requestId,
          }),
        );
        expect(test.sink.handle).not.toHaveBeenCalledWith(
          expect.objectContaining({
            requestId: 'client-controlled-correlation-id',
          }),
        );

        const replay = await request(test.httpServer)
          .get(guardedDetailTarget)
          .set('authorization', authorization);

        expect(replay.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(replay.body)).not.toContain(assertion.token);
        expect(JSON.stringify(replay.body)).not.toContain(assertion.requestId);
        expect(test.sink.handle).toHaveBeenCalledTimes(1);
        expect(policy.decide).toHaveBeenCalledTimes(1);
        expect(events).toEqual([
          'resource',
          'project-scope',
          'permission',
          'handler',
        ]);
        expect(
          await connection!
            .db!.collection(TASK_DELEGATION_REPLAY_COLLECTION)
            .countDocuments(),
        ).toBe(initialReplayCount + 1);
      } finally {
        await test.close();
      }
    }, 20_000);

    it('keeps the operation handler unreachable under the default deny policy', async () => {
      const assertion = signedAssertion({
        method: 'GET',
        target: guardedDetailTarget,
        projectId,
      });
      const events: string[] = [];
      const test = await createReplayGuardHttpApp({
        verifier: consumingVerifier(assertion, store),
        events,
        policy: new DenyAllTaskOperationPermissionPolicy(),
      });

      try {
        const response = await request(test.httpServer)
          .get(guardedDetailTarget)
          .set('authorization', `Bearer ${assertion.token}`);

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(response.body)).not.toContain(assertion.token);
        expect(events).toEqual(['resource', 'project-scope']);
        expect(test.sink.handle).not.toHaveBeenCalled();
      } finally {
        await test.close();
      }
    }, 20_000);

    it('rejects a foreign resource Project before operation policy evaluation', async () => {
      const assertion = signedAssertion({
        method: 'GET',
        target: guardedDetailTarget,
        projectId,
      });
      const events: string[] = [];
      const policy: TaskOperationPermissionPolicy = {
        decide: jest.fn(() => {
          events.push('permission');
          return 'ALLOW';
        }),
      };
      const test = await createReplayGuardHttpApp({
        verifier: consumingVerifier(assertion, store),
        events,
        policy,
        resourceProjectId: 'ffffffffffffffffffffffff',
      });

      try {
        const response = await request(test.httpServer)
          .get(guardedDetailTarget)
          .set('authorization', `Bearer ${assertion.token}`);

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(response.body)).not.toContain(assertion.token);
        expect(events).toEqual(['resource']);
        expect(policy.decide).not.toHaveBeenCalled();
        expect(test.scopeProvider.resolve).not.toHaveBeenCalled();
        expect(test.sink.handle).not.toHaveBeenCalled();
      } finally {
        await test.close();
      }
    }, 20_000);

    it('rejects malformed credentials and forged context headers before scope resolution', async () => {
      const assertion = signedAssertion({
        method: 'GET',
        target: guardedDetailTarget,
        projectId,
      });
      const events: string[] = [];
      const policy: TaskOperationPermissionPolicy = {
        decide: jest.fn(() => 'ALLOW'),
      };
      const test = await createReplayGuardHttpApp({
        verifier: consumingVerifier(assertion, store),
        events,
        policy,
      });

      try {
        const response = await request(test.httpServer)
          .get(guardedDetailTarget)
          .set('authorization', 'Bearer malformed-credential')
          .set('x-actor-user-id', 'forged-actor')
          .set('x-project-id', 'forged-project')
          .set('x-gateway-service-id', 'forged-service')
          .set('x-delegation-assertion', assertion.token)
          .set('x-internal-auth', 'forged-secret');

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(response.body)).not.toContain(
          'malformed-credential',
        );
        expect(JSON.stringify(response.body)).not.toContain(assertion.token);
        expect(events).toEqual([]);
        expect(test.resourceResolver.resolveProjectId).not.toHaveBeenCalled();
        expect(test.scopeProvider.resolve).not.toHaveBeenCalled();
        expect(policy.decide).not.toHaveBeenCalled();
        expect(test.sink.handle).not.toHaveBeenCalled();
      } finally {
        await test.close();
      }
    }, 20_000);

    it('does not retain already-expired replay evidence', async () => {
      const initialReplayCount = await connection!
        .db!.collection(TASK_DELEGATION_REPLAY_COLLECTION)
        .countDocuments();
      const result = await store.consume({
        issuer,
        tokenId: cryptoRandomId(),
        retainUntil: new Date(Date.now() - 1000),
      });

      expect(result).toBe(false);
      expect(
        await connection!
          .db!.collection(TASK_DELEGATION_REPLAY_COLLECTION)
          .countDocuments(),
      ).toBe(initialReplayCount);
    });

    it('fails closed when the replay database is unavailable', async () => {
      const initialReplayCount = await connection!
        .db!.collection(TASK_DELEGATION_REPLAY_COLLECTION)
        .countDocuments();
      const assertion = signedAssertion();
      const prototype = new TaskDelegationAssertionPrototypeVerifier({
        issuer,
        audience,
        gatewayServiceId,
        expectedClientId: gatewayClientId,
        signatureAlgorithm: 'EdDSA',
        tokenType: 'task-delegation+jwt',
        keyProvider: {
          getPublicKey: (requestedKeyId) =>
            new Map([[keyId, assertion.publicKey]]).get(requestedKeyId),
        },
      });
      const unavailableConnection = mongoose.createConnection(uri.toString(), {
        dbName: databaseName,
        autoIndex: false,
        serverSelectionTimeoutMS: 500,
      });
      await unavailableConnection.asPromise();
      const unavailableStore = await MongoTaskDelegationReplayStore.create(
        unavailableConnection,
      );
      const consuming = new ConsumingTaskDelegationAssertionPrototypeVerifier(
        prototype,
        unavailableStore,
      );
      await unavailableConnection.close();

      await expect(consuming.verify(assertion.token, binding)).rejects.toEqual(
        new TaskInboundContextVerificationError('VERIFICATION_FAILED'),
      );
      expect(
        await connection!
          .db!.collection(TASK_DELEGATION_REPLAY_COLLECTION)
          .countDocuments(),
      ).toBe(initialReplayCount);
    }, 15_000);

    it('fails closed through the HTTP guard when the replay store is unavailable', async () => {
      const requestBinding = {
        method: 'GET',
        target: guardedDetailTarget,
        projectId,
      };
      const assertion = signedAssertion(requestBinding);
      const unavailableConnection = mongoose.createConnection(uri.toString(), {
        dbName: databaseName,
        autoIndex: false,
        serverSelectionTimeoutMS: 500,
      });
      await unavailableConnection.asPromise();
      const unavailableStore = await MongoTaskDelegationReplayStore.create(
        unavailableConnection,
      );
      await unavailableConnection.close();
      const initialReplayCount = await connection!
        .db!.collection(TASK_DELEGATION_REPLAY_COLLECTION)
        .countDocuments();

      const events: string[] = [];
      const policy: TaskOperationPermissionPolicy = {
        decide: jest.fn(() => 'ALLOW'),
      };
      const test = await createReplayGuardHttpApp({
        verifier: consumingVerifier(assertion, unavailableStore),
        events,
        policy,
      });

      try {
        const response = await request(test.httpServer)
          .get(guardedDetailTarget)
          .set('authorization', `Bearer ${assertion.token}`)
          .set('x-actor-user-id', 'forged-actor')
          .set('x-project-id', projectId);

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(response.body)).not.toContain(assertion.token);
        expect(JSON.stringify(response.body)).not.toContain(
          'Replay store database is unavailable',
        );
        expect(events).toEqual([]);
        expect(test.resourceResolver.resolveProjectId).not.toHaveBeenCalled();
        expect(test.scopeProvider.resolve).not.toHaveBeenCalled();
        expect(policy.decide).not.toHaveBeenCalled();
        expect(test.sink.handle).not.toHaveBeenCalled();
        expect(
          await connection!
            .db!.collection(TASK_DELEGATION_REPLAY_COLLECTION)
            .countDocuments(),
        ).toBe(initialReplayCount);
      } finally {
        await test.close();
      }
    }, 20_000);

    const bffIntegration = process.env.DATN_FE_WORKTREE ? it : it.skip;
    bffIntegration(
      'traverses the built BFF, test-only Gateway adapter and Task HTTP guard over loopback',
      async () => {
        const feRoot = process.env.DATN_FE_WORKTREE!;
        let nextProcess: ChildProcess | undefined;
        let gateway:
          Awaited<ReturnType<typeof createTestGatewayHttpApp>> | undefined;
        let hangingUpstream:
          Awaited<ReturnType<typeof createHangingUpstreamServer>> | undefined;
        let taskFixture:
          | (Awaited<ReturnType<typeof createReplayGuardHttpApp>> & {
              events: string[];
              url: string;
            })
          | undefined;
        const keyPair = generateKeyPairSync('ed25519');
        const publicKey = keyPair.publicKey
          .export({ type: 'spki', format: 'pem' })
          .toString();
        const gatewayOptions: TestGatewayOptions = {
          taskBaseUrl: '',
          privateKey: keyPair.privateKey,
          assertionCache: new Map(),
          observedRequestIds: [],
        };

        const startTaskFixture = async (
          policy: TaskOperationPermissionPolicy,
          resourceProjectId?: string,
        ) => {
          if (taskFixture) {
            await taskFixture.close();
            taskFixture = undefined;
          }
          const events: string[] = [];
          const candidate = await createReplayGuardHttpApp({
            verifier: consumingVerifier({ publicKey }, store),
            events,
            policy,
            ...(resourceProjectId === undefined ? {} : { resourceProjectId }),
          });
          await candidate.app.listen(0, '127.0.0.1');
          const address = (
            candidate.app.getHttpServer() as HttpServer
          ).address();
          if (!address || typeof address === 'string') {
            await candidate.close();
            throw new Error('Test Task process did not bind a TCP port');
          }
          const url = `http://127.0.0.1:${address.port}`;
          gatewayOptions.taskBaseUrl = url;
          taskFixture = { ...candidate, events, url };
          return taskFixture;
        };

        try {
          if (
            !existsSync(
              resolve(feRoot, 'src/app/api/backend/[...path]/route.ts'),
            )
          ) {
            throw new Error(
              'DATN_FE_WORKTREE does not identify the FE worktree',
            );
          }

          const denyPolicy = new DenyAllTaskOperationPermissionPolicy();
          const denySpy = jest.spyOn(denyPolicy, 'decide');
          let currentTask = await startTaskFixture(denyPolicy);
          gateway = await createTestGatewayHttpApp(gatewayOptions);
          const bff = await startBuiltNextBff(feRoot, gateway.url);
          nextProcess = bff.child;
          const bffTaskUrl = `${bff.url}/api/backend/task-test/projects/${projectId}/tasks/fedcba9876543210fedcba98`;

          const noCredential = await fetch(bffTaskUrl);
          expect(noCredential.status).toBe(401);
          expect(currentTask.events).toEqual([]);
          expect(currentTask.sink.handle).not.toHaveBeenCalled();

          const forgedHeaders = {
            cookie: testGatewaySessionCookie,
            'x-actor-user-id': 'forged-actor',
            'x-project-id': 'ffffffffffffffffffffffff',
            'x-gateway-service-id': 'forged-service',
            'x-delegation-assertion': 'forged-token',
            'x-internal-auth': 'forged-credential',
            'x-request-id': 'client-controlled-request-id',
          };
          const defaultDenied = await fetch(bffTaskUrl, {
            headers: forgedHeaders,
          });
          expect(defaultDenied.status).toBe(403);
          expect(currentTask.events).toEqual(['resource', 'project-scope']);
          expect(denySpy).toHaveBeenCalledTimes(1);
          expect(currentTask.scopeProvider.resolve).toHaveBeenCalledWith({
            actorUserId: testGatewayActorId,
            projectId,
          });
          expect(currentTask.sink.handle).not.toHaveBeenCalled();
          expect(JSON.stringify(await defaultDenied.json())).not.toContain(
            'forged-credential',
          );

          currentTask = await startTaskFixture({
            decide: jest.fn((facts: TaskOperationPermissionFacts) => {
              currentTask.events.push('permission');
              expect(facts.actorUserId).toBe(testGatewayActorId);
              return 'ALLOW';
            }),
          });
          const invalidVerifier = await fetch(
            `${bffTaskUrl}?fixture=invalid-signature`,
            { headers: { cookie: testGatewaySessionCookie } },
          );
          expect(invalidVerifier.status).toBe(403);
          expect(currentTask.events).toEqual([]);
          expect(
            currentTask.resourceResolver.resolveProjectId,
          ).not.toHaveBeenCalled();
          expect(currentTask.sink.handle).not.toHaveBeenCalled();

          const accepted = await fetch(bffTaskUrl, { headers: forgedHeaders });
          expect(accepted.status).toBe(200);
          expect(await accepted.json()).toEqual({ ok: true });
          expect(currentTask.events).toEqual([
            'resource',
            'project-scope',
            'permission',
            'handler',
          ]);
          const authorizedContext = currentTask.sink.handle.mock.calls[0]?.[0];
          expect(authorizedContext).toMatchObject({
            kind: 'authorized',
            actorUserId: testGatewayActorId,
            projectId,
            requestId: gatewayOptions.observedRequestIds.at(-1),
          });
          expect(gatewayOptions.observedRequestIds.at(-1)).toMatch(
            uuidV4Pattern,
          );
          expect(gatewayOptions.observedRequestIds).not.toContain(
            'client-controlled-request-id',
          );

          currentTask.events.length = 0;
          currentTask.sink.handle.mockClear();
          gatewayOptions.assertionCache.clear();
          const replayFirst = await fetch(`${bffTaskUrl}?fixture=replay`, {
            headers: { cookie: testGatewaySessionCookie },
          });
          const replaySecond = await fetch(`${bffTaskUrl}?fixture=replay`, {
            headers: { cookie: testGatewaySessionCookie },
          });
          expect(replayFirst.status).toBe(200);
          expect(replaySecond.status).toBe(403);
          expect(currentTask.sink.handle).toHaveBeenCalledTimes(1);
          expect(currentTask.events).toEqual([
            'resource',
            'project-scope',
            'permission',
            'handler',
          ]);
          expect(JSON.stringify(await replaySecond.json())).not.toContain(
            'task-delegation+jwt',
          );

          currentTask.events.length = 0;
          currentTask.sink.handle.mockClear();
          const projectMismatch = await fetch(
            `${bffTaskUrl}?fixture=project-mismatch`,
            { headers: { cookie: testGatewaySessionCookie } },
          );
          expect(projectMismatch.status).toBe(403);
          expect(currentTask.events).toEqual([]);
          expect(currentTask.sink.handle).not.toHaveBeenCalled();

          currentTask = await startTaskFixture(
            {
              decide: jest.fn(() => {
                currentTask.events.push('permission');
                return 'ALLOW';
              }),
            },
            'ffffffffffffffffffffffff',
          );
          const resourceMismatch = await fetch(bffTaskUrl, {
            headers: { cookie: testGatewaySessionCookie },
          });
          expect(resourceMismatch.status).toBe(403);
          expect(currentTask.events).toEqual(['resource']);
          expect(currentTask.scopeProvider.resolve).not.toHaveBeenCalled();
          expect(currentTask.sink.handle).not.toHaveBeenCalled();

          const unavailableTaskUrl = currentTask.url;
          await currentTask.close();
          taskFixture = undefined;
          gatewayOptions.taskBaseUrl = unavailableTaskUrl;
          const upstreamFailure = await fetch(bffTaskUrl, {
            headers: { cookie: testGatewaySessionCookie },
          });
          expect(upstreamFailure.status).toBe(503);
          const upstreamFailureBody = await upstreamFailure.text();
          expect(upstreamFailureBody).toContain('Task service unavailable');
          expect(upstreamFailureBody).not.toContain(unavailableTaskUrl);
          expect(upstreamFailureBody).not.toContain('127.0.0.1');

          currentTask.events.length = 0;
          currentTask.sink.handle.mockClear();
          hangingUpstream = await createHangingUpstreamServer();
          gatewayOptions.taskBaseUrl = hangingUpstream.url;
          gatewayOptions.upstreamTimeoutMs = 50;
          const upstreamTimeout = await fetch(bffTaskUrl, {
            headers: { cookie: testGatewaySessionCookie },
          });
          expect(upstreamTimeout.status).toBe(503);
          const upstreamTimeoutBody = await upstreamTimeout.text();
          expect(upstreamTimeoutBody).toContain('Task service unavailable');
          expect(upstreamTimeoutBody).not.toContain(hangingUpstream.url);
          expect(upstreamTimeoutBody).not.toContain('127.0.0.1');
          expect(currentTask.events).toEqual([]);
          expect(currentTask.sink.handle).not.toHaveBeenCalled();
        } finally {
          if (hangingUpstream) await hangingUpstream.close();
          if (taskFixture) await taskFixture.close();
          if (gateway) await gateway.close();
          if (nextProcess) await closeChildProcess(nextProcess);
        }

        expect(nextProcess).toBeDefined();
        expect(
          nextProcess?.exitCode !== null || nextProcess?.signalCode !== null,
        ).toBe(true);
      },
      120_000,
    );
  },
);
