import { createRequire } from 'node:module';
import { lookup as dnsLookup } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const require = createRequire(import.meta.url);

const loopbackAddresses = new Set(['127.0.0.1', '::1']);

function rejectDotenvOverrides(env) {
  if (
    Object.keys(env).some(
      (name) => name === 'DOTENV_KEY' || name.startsWith('DOTENV_CONFIG_'),
    )
  ) {
    throw new Error(
      'Dotenv override controls are not allowed; provide smoke configuration directly in the command environment.',
    );
  }
}

function mongoHostFromUri(uri) {
  if (typeof uri !== 'string') {
    throw new Error(
      'A local MongoDB URI is required for the development smoke test.',
    );
  }

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(
      'A valid local MongoDB URI is required for the development smoke test.',
    );
  }

  if (parsed.protocol !== 'mongodb:') {
    throw new Error(
      'Only direct loopback MongoDB URIs are allowed for the development smoke test.',
    );
  }

  const authorityStart = uri.indexOf('://') + 3;
  const authority = uri.slice(authorityStart).split(/[/?#]/, 1)[0];
  const hosts = authority.slice(authority.lastIndexOf('@') + 1);
  if (!hosts || hosts.includes(',')) {
    throw new Error(
      'Only a single loopback MongoDB host is allowed for the development smoke test.',
    );
  }

  return parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

async function requireLoopbackHost(host, label, lookupHost) {
  const normalized = String(host ?? '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (loopbackAddresses.has(normalized)) return;

  if (normalized !== 'localhost') {
    throw new Error(
      `Only loopback ${label} endpoints are allowed for the development smoke test.`,
    );
  }

  let addresses;
  try {
    addresses = await lookupHost(normalized, { all: true, verbatim: true });
  } catch {
    throw new Error(
      `The ${label} localhost endpoint could not be verified as loopback.`,
    );
  }

  if (
    !Array.isArray(addresses) ||
    addresses.length === 0 ||
    addresses.some(
      ({ address }) => !loopbackAddresses.has(address.toLowerCase()),
    )
  ) {
    throw new Error(
      `The ${label} localhost endpoint could not be verified as loopback.`,
    );
  }
}

function redisEndpoints(env) {
  const mode = (env.REDIS_MODE ?? 'standalone').toLowerCase();
  if (mode === 'standalone') {
    return [
      {
        host: env.REDIS_HOST ?? '127.0.0.1',
        port: env.REDIS_PORT ?? '6379',
      },
    ];
  }
  if (mode !== 'cluster') {
    throw new Error('Unsupported Redis mode for the development smoke test.');
  }

  const nodes = (env.REDIS_CLUSTER_NODES ?? '')
    .split(',')
    .map((node) => node.trim())
    .filter(Boolean);
  if (nodes.length === 0) {
    throw new Error(
      'Redis cluster nodes are required for the development smoke test.',
    );
  }

  return nodes.map((node) => {
    const match = /^([^:[\]]+)(?::(\d+))?$/.exec(node);
    if (!match) {
      throw new Error('Redis cluster endpoints must use host[:port] format.');
    }
    return { host: match[1], port: match[2] ?? '6379' };
  });
}

async function requireValidPort(port, label) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      `A valid ${label} port is required for the development smoke test.`,
    );
  }
}

export async function assertSafeLocalRuntimeEndpoints(
  env,
  { lookupHost = dnsLookup } = {},
) {
  rejectDotenvOverrides(env);

  const mongoHost = mongoHostFromUri(env.MONGODB_URI);
  await requireLoopbackHost(mongoHost, 'MongoDB', lookupHost);

  const redis = redisEndpoints(env);
  for (const endpoint of redis) {
    await requireValidPort(endpoint.port, 'Redis');
    await requireLoopbackHost(endpoint.host, 'Redis', lookupHost);
  }
}

export async function createAppAfterLocalEndpointValidation({
  env,
  validateConfiguration,
  importAppModule,
  createApp,
  endpointOptions,
}) {
  await validateConfiguration(env);
  await assertSafeLocalRuntimeEndpoints(env, endpointOptions);

  const importedApp = await importAppModule();

  // AppModule imports dotenv/config. Revalidate its effective process env before
  // NestFactory can open Mongo/Redis connections or run any application hook.
  await validateConfiguration(env);
  await assertSafeLocalRuntimeEndpoints(env, endpointOptions);

  return { importedApp, app: await createApp(importedApp) };
}

function assertResponse(response, operation) {
  if (!response.ok) {
    throw new Error(`${operation} returned HTTP ${response.status}.`);
  }
}

async function requestJson(url, options, operation) {
  const response = await fetch(url, options);
  assertResponse(response, operation);
  return { response, body: await response.json() };
}

async function login(baseUrl, email, password) {
  const { response, body } = await requestJson(
    `${baseUrl}/auth/login`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
    'Authentication',
  );
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie?.startsWith('continuum_access=')) {
    throw new Error('Authentication did not establish its access cookie.');
  }
  if (!body.user?.organizationId) {
    throw new Error('Authentication did not resolve an organization context.');
  }
  return { cookie, user: body.user };
}

async function main() {
  process.chdir(scriptDirectory);
  if (
    fs.existsSync(path.join(scriptDirectory, '.env')) ||
    fs.existsSync(path.join(scriptDirectory, '.env.vault'))
  ) {
    throw new Error(
      'Refusing to run when a local dotenv file is present; supply the smoke configuration in the command environment.',
    );
  }

  const { validateLocalDevelopmentEnvironment } =
    await import('./initialize-service-owned-databases.mjs');

  const password = process.env.DATN_DEV_SEED_PASSWORD;
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error(
      'DATN_DEV_SEED_PASSWORD is required; credentials are never printed.',
    );
  }
  if ((process.env.JWT_SECRET ?? '').length < 32) {
    throw new Error(
      'A valid local JWT_SECRET is required; credentials are never printed.',
    );
  }
  if (process.env.INFRA_ENABLED !== 'true') {
    throw new Error(
      'INFRA_ENABLED=true is required for the runtime smoke test.',
    );
  }

  const { importedApp, app } = await createAppAfterLocalEndpointValidation({
    env: process.env,
    validateConfiguration: validateLocalDevelopmentEnvironment,
    importAppModule: async () => {
      require('ts-node/register/transpile-only');
      const { NestFactory } = require('@nestjs/core');
      const { ConfigModule } = require('@nestjs/config');
      const { getConnectionToken } = require('@nestjs/mongoose');
      const { AppModule } = require(
        path.join(repositoryRoot, 'src/app.module.ts'),
      );
      await ConfigModule.envVariablesLoaded;
      const { configureApplication } = require(
        path.join(repositoryRoot, 'src/bootstrap.ts'),
      );
      const { AUDIT_CONNECTION_NAME, IAM_AUDIT_COLLECTION_NAME } = require(
        path.join(repositoryRoot, 'src/common/mongodb/database-names.ts'),
      );
      return {
        NestFactory,
        getConnectionToken,
        AppModule,
        configureApplication,
        AUDIT_CONNECTION_NAME,
        IAM_AUDIT_COLLECTION_NAME,
      };
    },
    createApp: ({ NestFactory, AppModule }) =>
      NestFactory.create(AppModule, { logger: false }),
  });
  const {
    getConnectionToken,
    configureApplication,
    AUDIT_CONNECTION_NAME,
    IAM_AUDIT_COLLECTION_NAME,
  } = importedApp;
  try {
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') {
      throw new Error('The local API did not bind an ephemeral loopback port.');
    }
    const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

    await requestJson(`${baseUrl}/health`, {}, 'Health check');
    const member = await login(
      baseUrl,
      'member@datn-dev.example.test',
      password,
    );
    const memberHeaders = { cookie: member.cookie };

    const { body: identity } = await requestJson(
      `${baseUrl}/auth/me`,
      { headers: memberHeaders },
      'Authenticated identity',
    );
    if (identity.organizationId !== member.user.organizationId) {
      throw new Error(
        'The authenticated organization context changed after login.',
      );
    }

    const { body: memberProjects } = await requestJson(
      `${baseUrl}/iam/projects`,
      { headers: memberHeaders },
      'Project list for an active Project member',
    );
    const sample = memberProjects.data?.find(
      (project) => project.code === 'DEV_SAMPLE',
    );
    if (!sample) {
      throw new Error('The seeded Project member cannot read DEV_SAMPLE.');
    }
    await requestJson(
      `${baseUrl}/iam/projects/${sample.id}`,
      { headers: memberHeaders },
      'Project detail for an active Project member',
    );

    const auditConnection = app.get(getConnectionToken(AUDIT_CONNECTION_NAME));
    const auditCollection = auditConnection.db.collection(
      IAM_AUDIT_COLLECTION_NAME,
    );
    const auditBefore = await auditCollection.countDocuments({});

    const projectCode = `SMK_${Date.now().toString(36).toUpperCase()}`;
    const { body: created } = await requestJson(
      `${baseUrl}/iam/projects`,
      {
        method: 'POST',
        headers: {
          ...memberHeaders,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Fresh development runtime smoke project',
          code: projectCode,
          description: 'Synthetic local runtime verification.',
        }),
      },
      'Project create for an ACTIVE Organization member',
    );
    if (created.code !== projectCode || !created.id) {
      throw new Error('Project creation returned an unexpected record.');
    }

    await requestJson(
      `${baseUrl}/iam/projects/${created.id}`,
      { headers: memberHeaders },
      'Project detail after creation',
    );
    const { body: refreshedMemberList } = await requestJson(
      `${baseUrl}/iam/projects`,
      { headers: memberHeaders },
      'Project list after creation',
    );
    if (
      !refreshedMemberList.data?.some((project) => project.code === projectCode)
    ) {
      throw new Error(
        'The created Project was not visible in the member list.',
      );
    }

    const admin = await login(baseUrl, 'admin@datn-dev.example.test', password);
    const { body: adminDetail } = await requestJson(
      `${baseUrl}/iam/projects/${created.id}`,
      { headers: { cookie: admin.cookie } },
      'Organization ADMIN Project metadata access',
    );
    if (adminDetail.code !== projectCode) {
      throw new Error(
        'Organization ADMIN received unexpected Project metadata.',
      );
    }

    const auditAfter = await auditCollection.countDocuments({});
    if (auditAfter <= auditBefore) {
      throw new Error(
        'Project creation did not persist an event in continuum_audit.audit_logs_iam.',
      );
    }

    console.log(
      'Runtime smoke passed: health, MEMBER authentication, trusted organization context, Project list/detail/create, ADMIN metadata access, and audit persistence.',
    );
    console.log(`Audit event count increased by ${auditAfter - auditBefore}.`);
    console.log(`Created one synthetic local Project (${projectCode}).`);
  } finally {
    await app.close();
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then(() => {
      // AppModule's BullMQ event handles can remain open after app.close().
      process.exit(0);
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? error.message : 'Runtime smoke failed.',
      );
      process.exit(1);
    });
}
