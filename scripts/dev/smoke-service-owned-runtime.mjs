import { createRequire } from 'node:module';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {
  parseDevelopmentMongoUri,
  requireDevelopmentEnvironment,
} from './development-target-policy.mjs';

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

async function validateDevelopmentHost(host, label, lookupHost) {
  const normalized = String(host ?? '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (loopbackAddresses.has(normalized)) return;

  if (normalized === 'localhost') {
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
    return;
  }

  if (
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    (!isIP(normalized) &&
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(
        normalized,
      ))
  ) {
    throw new Error(
      `A valid ${label} development hostname or IP address is required.`,
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

export async function assertSafeDevelopmentRuntimeEndpoints(
  env,
  { lookupHost = dnsLookup } = {},
) {
  requireDevelopmentEnvironment(env);
  rejectDotenvOverrides(env);

  const mongo = parseDevelopmentMongoUri(env.MONGODB_URI);
  await validateDevelopmentHost(mongo.hostname, 'MongoDB', lookupHost);

  const redis = redisEndpoints(env);
  for (const endpoint of redis) {
    await requireValidPort(endpoint.port, 'Redis');
    await validateDevelopmentHost(endpoint.host, 'Redis', lookupHost);
  }
}

export async function createAppAfterDevelopmentEndpointValidation({
  env,
  validateConfiguration,
  importAppModule,
  createApp,
  endpointOptions,
}) {
  await validateConfiguration(env);
  await assertSafeDevelopmentRuntimeEndpoints(env, endpointOptions);

  const importedApp = await importAppModule();

  // AppModule imports dotenv/config. Revalidate its effective process env before
  // NestFactory can open Mongo/Redis connections or run any application hook.
  await validateConfiguration(env);
  await assertSafeDevelopmentRuntimeEndpoints(env, endpointOptions);

  return { importedApp, app: await createApp(importedApp) };
}

export function redactRuntimeError(error, env) {
  let message =
    error instanceof Error ? error.message : 'Runtime smoke failed.';
  const secrets = [
    env.MONGODB_URI,
    env.REDIS_PASSWORD,
    env.DATN_DEV_SEED_PASSWORD,
    env.JWT_SECRET,
  ].filter((value) => typeof value === 'string' && value.length > 0);

  if (typeof env.MONGODB_URI === 'string') {
    try {
      const uri = new URL(env.MONGODB_URI);
      secrets.push(uri.username, uri.password);
      for (const value of [uri.username, uri.password]) {
        if (value) {
          try {
            secrets.push(decodeURIComponent(value));
          } catch {
            // The encoded value is still redacted below.
          }
        }
      }
    } catch {
      // The malformed URI itself is still redacted if it appears in the error.
    }
  }

  for (const secret of new Set(secrets)) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message;
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

  const { validateDevelopmentSeedEnvironment } =
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

  const { importedApp, app } =
    await createAppAfterDevelopmentEndpointValidation({
      env: process.env,
      validateConfiguration: validateDevelopmentSeedEnvironment,
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
        const { SERVICE_DATABASES } = require(
          path.join(repositoryRoot, 'src/common/mongodb/database-names.ts'),
        );
        return {
          NestFactory,
          getConnectionToken,
          AppModule,
          configureApplication,
          AUDIT_CONNECTION_NAME,
          IAM_AUDIT_COLLECTION_NAME,
          SERVICE_DATABASES,
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
    SERVICE_DATABASES,
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
    const iamConnection = app.get(getConnectionToken(SERVICE_DATABASES.iam));
    const { Types } = require('mongoose');
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
    const createdProjectId = new Types.ObjectId(created.id);
    const creatorId = new Types.ObjectId(member.user.id);
    const createdProject = await iamConnection.db
      .collection('projects')
      .findOne({ _id: createdProjectId }, { projection: { visibility: 1 } });
    if (createdProject?.visibility !== 'PRIVATE') {
      throw new Error('A newly created Project did not default to PRIVATE.');
    }
    const [projectMembershipCount, projectRoleAssignmentCount, teamCount] =
      await Promise.all([
        iamConnection.db.collection('project_memberships').countDocuments({
          organizationId: new Types.ObjectId(member.user.organizationId),
          projectId: createdProjectId,
          userId: creatorId,
        }),
        iamConnection.db.collection('role_assignments').countDocuments({
          organizationId: new Types.ObjectId(member.user.organizationId),
          projectId: createdProjectId,
          userId: creatorId,
        }),
        iamConnection.db.collection('teams').countDocuments({
          organizationId: new Types.ObjectId(member.user.organizationId),
          projectId: createdProjectId,
        }),
      ]);
    if (projectMembershipCount !== 0) {
      throw new Error('Project creation added an implicit ProjectMembership.');
    }
    if (projectRoleAssignmentCount !== 0) {
      throw new Error('Project creation added an implicit RoleAssignment.');
    }
    if (teamCount !== 0) {
      throw new Error('Project creation added an implicit Team.');
    }

    const { body: refreshedMemberList } = await requestJson(
      `${baseUrl}/iam/projects`,
      { headers: memberHeaders },
      'Project list after creation',
    );
    if (
      refreshedMemberList.data?.some((project) => project.id === created.id)
    ) {
      throw new Error(
        'The creator without ProjectMembership could see the new Private Project.',
      );
    }
    const creatorDetail = await fetch(`${baseUrl}/iam/projects/${created.id}`, {
      headers: memberHeaders,
    });
    if (creatorDetail.status !== 404) {
      throw new Error(
        'The creator without ProjectMembership should not read the Private Project.',
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
      'Runtime smoke passed: health, MEMBER authentication, trusted organization context, Project create with PRIVATE default and no implicit membership/role/Team, creator read denial, ADMIN metadata access, and audit persistence.',
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
      console.error(redactRuntimeError(error, process.env));
      process.exit(1);
    });
}
