import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const require = createRequire(import.meta.url);

function requireLoopbackRedis(env) {
  const host = (env.REDIS_HOST ?? '127.0.0.1').toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(
      'Only loopback Redis is allowed for the development smoke test.',
    );
  }
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
  if (fs.existsSync(path.join(scriptDirectory, '.env'))) {
    throw new Error(
      'Refusing to run from scripts/dev while a local .env file is present.',
    );
  }

  const { validateLocalDevelopmentEnvironment } =
    await import('./initialize-service-owned-databases.mjs');
  validateLocalDevelopmentEnvironment(process.env);
  requireLoopbackRedis(process.env);

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

  require('ts-node/register/transpile-only');
  const { NestFactory } = require('@nestjs/core');
  const { getConnectionToken } = require('@nestjs/mongoose');
  const { AppModule } = require(path.join(repositoryRoot, 'src/app.module.ts'));
  const { configureApplication } = require(
    path.join(repositoryRoot, 'src/bootstrap.ts'),
  );
  const { AUDIT_CONNECTION_NAME, IAM_AUDIT_COLLECTION_NAME } = require(
    path.join(repositoryRoot, 'src/common/mongodb/database-names.ts'),
  );

  const app = await NestFactory.create(AppModule, { logger: false });
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
