import { createRequire } from 'node:module';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Explicit isolated app smoke: never uses an operator-supplied MongoDB URI. */
export async function runApplicationSmoke() {
  if (process.env.WORKNOTE_AGENT_APP_SMOKE !== 'true')
    return {
      dryRun: true,
      networkCalls: 0,
      status: 'EXPLICIT_OPT_IN_REQUIRED',
    };
  if (
    process.env.NODE_ENV === 'production' ||
    Object.keys(process.env).some(
      (k) => k === 'DOTENV_KEY' || k.startsWith('DOTENV_CONFIG_'),
    )
  )
    throw Error('Unsafe smoke environment');
  const redisPort = Number(process.env.WORKNOTE_AGENT_REDIS_TEST_PORT);
  if (!Number.isSafeInteger(redisPort) || redisPort < 1024 || redisPort > 65535)
    throw Error('Explicit disposable loopback Redis port required');
  const dbPackage = process.env.WORKNOTE_AGENT_DB_PACKAGE;
  if (!dbPackage) throw Error('Separate DB worktree required');
  const require = createRequire(import.meta.url);
  const { MongoMemoryReplSet } = require('mongodb-memory-server'),
    mongoose = require('mongoose');
  const { parse } = require('dotenv');
  const credential = parse(
    readFileSync(resolve(root, '.env'), 'utf8'),
  ).XKIRO_API_KEY;
  if (!credential) throw Error('Local xKiro credential required');
  const repl = await MongoMemoryReplSet.create({
    binary: { version: '7.0.24' },
    replSet: { count: 1 },
  });
  let connection, app;
  let stage = 'ISOLATED_SETUP';
  const completed = [];
  const mark = (next) => {
    stage = next;
    console.log(JSON.stringify({ stage }));
  };
  try {
    const password = randomBytes(24).toString('base64url') + 'Aa!1';
    Object.assign(process.env, {
      NODE_ENV: 'development',
      DATN_DB_ENV: 'development',
      DATN_DEV_DB_INITIALIZATION: 'service-owned-development',
      DATN_DEV_SEED_PASSWORD: password,
      INFRA_ENABLED: 'true',
      MONGODB_URI: repl.getUri(),
      MONGODB_AUTO_INDEX: 'false',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: String(redisPort),
      REDIS_MODE: 'standalone',
      REDIS_PASSWORD: '',
      REDIS_CLUSTER_NODES: '',
      BULLMQ_PREFIX: `worknote-smoke-${randomUUID()}`,
      JWT_SECRET: randomBytes(48).toString('base64url'),
      IAM_GATEWAY_SECRET: randomBytes(48).toString('base64url'),
      PASSWORD_RESET_OUTBOX_KEY: randomBytes(48).toString('base64url'),
      EMAIL_REGISTRATION_OUTBOX_KEY: randomBytes(48).toString('base64url'),
      WORKNOTE_EDITOR_ENABLED: 'true',
      WORKNOTE_SHARED_EDITOR_ENABLED: 'true',
      WORKNOTE_AGENT_ENABLED: 'true',
      WORKNOTE_AGENT_FORMATTING_RECOVERY: 'true',
      XKIRO_API_KEY: credential,
      XKIRO_MODEL: 'mistralai/ministral-14b',
      TS_NODE_PROJECT: resolve(root, 'tsconfig.json'),
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      SAG_API_BASE_URL: '',
      SAG_BFF_SERVICE_TOKEN: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
    });
    delete process.env.TASK_SERVICE_URL;
    delete process.env.SERVICE_DATABASE;
    for (const service of [
      'IAM',
      'CAPTURE',
      'JIRA',
      'LIFECYCLE',
      'CHAT',
      'HANDOVER',
      'INGESTION',
      'NOTIFICATION',
      'SAG',
    ])
      process.env[`${service}_SERVICE_URL`] = 'http://127.0.0.1:9';
    process.chdir(resolve(root, 'scripts/dev'));
    if (existsSync('.env') || existsSync('.env.vault'))
      throw Error('Unsafe dotenv file');
    require('ts-node/register/transpile-only');
    mark('IMPORT_ISOLATED_SEED_HELPER');
    const init = await import('../dev/initialize-service-owned-databases.mjs');
    mark('ISOLATED_SEED_VALIDATION');
    init.validateDevelopmentSeedEnvironment(process.env);
    connection = await mongoose
      .createConnection(repl.getUri(), { dbName: 'continuum_iam' })
      .asPromise();
    mark('ISOLATED_SCHEMA_INITIALIZATION');
    await init.initializeServiceOwnedDatabases(connection);
    mark('ISOLATED_ACCOUNT_SEED');
    await init.seedDevelopmentDataset(connection, password);
    const workspaceMigration =
      await import('../migrations/20261022-task-workspace-fields.mjs');
    await workspaceMigration.applyWorkspaceMigration(
      connection.getClient().db('continuum_task'),
      connection.db,
    );
    const taskCatalog = require(
      resolve(root, 'src/services/task/workspace/task-workspace.types.ts'),
    ).WORKSPACE_INDEX_CATALOGUE;
    for (const [name, indexes] of Object.entries(taskCatalog))
      for (const { key, ...options } of indexes)
        await connection
          .getClient()
          .db('continuum_task')
          .collection(name)
          .createIndex(key, options);
    const migration = await import(
      pathToFileURL(
        resolve(dbPackage, 'scripts/migrations/20261027-work-note-agent.mjs'),
      ).href
    );
    const extension = await import(
      pathToFileURL(
        resolve(dbPackage, 'scripts/migrations/20261028-work-note-editor.mjs'),
      ).href
    );
    await migration.migrateWorkNoteAgent(connection.getClient(), {
      apply: true,
    });
    await extension.migrateWorkNoteEditor(connection.getClient(), {
      apply: true,
    });
    mark('REAL_APPLICATION_BOOTSTRAP');
    const { NestFactory } = require('@nestjs/core'),
      { ConfigService, ConfigModule } = require('@nestjs/config');
    require(resolve(root, 'src/config/env.validation.ts')).validateEnvironment(
      process.env,
    );
    mark('IMPORT_APPLICATION');
    const { AppModule } = require(resolve(root, 'src/app.module.ts'));
    mark('LOAD_CONFIGURATION');
    await Promise.race([
      ConfigModule.envVariablesLoaded,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error('CONFIG_TIMEOUT')), 10000),
      ),
    ]);
    mark('CREATE_APPLICATION');
    init.validateDevelopmentSeedEnvironment(process.env);
    app = await NestFactory.create(AppModule, {
      logger: ['error'],
      abortOnError: false,
    });
    app.useWebSocketAdapter(
      new (require('@nestjs/platform-ws').WsAdapter)(app),
    );
    require(resolve(root, 'src/bootstrap.ts')).configureApplication(app);
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl(),
      config = app.get(ConfigService);
    config.set('IAM_SERVICE_URL', base);
    config.set('CAPTURE_SERVICE_URL', base);
    async function json(
      path,
      method = 'GET',
      body,
      headers = {},
      expected = 200,
    ) {
      const res = await fetch(`${base}/api/v1${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status !== expected) throw Error(`HTTP_${res.status}`);
      return { res, value: res.status === 204 ? null : await res.json() };
    }
    mark('REAL_MEMBER_LOGIN');
    const login = await json('/auth/login', 'POST', {
      email: 'member@datn-dev.example.test',
      password,
    });
    let cookies = login.res.headers
      .getSetCookie()
      .map((v) => v.split(';', 1)[0]);
    const organization = await connection.db
      .collection('organizations')
      .findOne({ slug: 'datn-dev' });
    if (!organization) throw Error('NO_SYNTHETIC_ORGANIZATION');
    const loginCsrf = cookies
      .find((v) => v.startsWith('__Host-csrf='))
      ?.slice('__Host-csrf='.length);
    const selected = await json(
      '/auth/select-organization',
      'POST',
      { organizationId: String(organization._id) },
      {
        cookie: cookies.join('; '),
        'x-csrf-token': decodeURIComponent(loginCsrf ?? ''),
      },
    );
    cookies = selected.res.headers
      .getSetCookie()
      .map((v) => v.split(';', 1)[0]);
    const csrf = cookies
      .find((v) => /^continuum_csrf=|^__Host-csrf=|^csrf_token=/.test(v))
      ?.split('=')
      .slice(1)
      .join('=');
    if (!cookies.some((v) => v.startsWith('continuum_access=')))
      throw Error('NO_SESSION');
    const headers = {
      cookie: cookies.join('; '),
      ...(csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {}),
    };
    const current = await json('/auth/me', 'GET', undefined, headers);
    if (!current.value.organizationId) throw Error('NO_ORGANIZATION');
    completed.push(stage);
    const project = await connection.db.collection('projects').findOne({
      organizationId: new mongoose.Types.ObjectId(current.value.organizationId),
    });
    if (!project) throw Error('NO_SYNTHETIC_PROJECT');
    const p = String(project._id);
    mark('REAL_TASK_CREATION');
    const task = await json(
      `/tasks/projects/${p}/tasks`,
      'POST',
      { title: 'Synthetic retry verification' },
      { ...headers, 'idempotency-key': randomUUID() },
      201,
    );
    const taskId = task.value.id;
    if (!taskId) throw Error('NO_TASK');
    completed.push(stage);
    mark('TASK_NOTE_AUTOSAVE');
    const draftRoot = `/capture/projects/${p}/work-note-drafts`;
    const draft = await json(
      draftRoot,
      'POST',
      { operationId: randomUUID(), taskId },
      headers,
      201,
    );
    const edited = await json(
      `${draftRoot}/${draft.value.id}`,
      'PATCH',
      {
        operationId: randomUUID(),
        expectedRevision: draft.value.revision,
        title: 'Synthetic retry note',
        contentMarkdown: 'Đả thêm nút retry; chưa kiểm thử lỗi mất mạng.',
      },
      headers,
    );
    completed.push(stage);
    mark('REAL_XKIRO_PROPOSAL');
    const reply = await json(
      `${draftRoot}/${draft.value.id}/agent/messages`,
      'POST',
      {
        operationId: randomUUID(),
        expectedRevision: edited.value.revision,
        operation: 'grammar',
        scope: 'whole_note',
        instruction: 'Sửa chính tả, giữ thông tin chưa kiểm thử.',
        includeWholeNoteContext: false,
      },
      headers,
    );
    if (
      reply.value.status !== 'SUGGESTION_READY' ||
      !reply.value.suggestion?.replacementText?.includes('chưa')
    )
      throw Error('INVALID_SYNTHETIC_PROPOSAL');
    completed.push(stage);
    const applied = await json(
      `${draftRoot}/${draft.value.id}/agent/suggestions/${reply.value.suggestion.id}/apply`,
      'POST',
      {
        operationId: randomUUID(),
        expectedRevision: edited.value.revision,
        action: 'replace_body',
        applyTitle: false,
      },
      headers,
    );
    mark('CANONICAL_SAVE_AND_REPLAY');
    const save = {
      operationId: randomUUID(),
      expectedRevision: applied.value.revision,
      discardOriginalConfirmed: true,
    };
    const saved = await json(
        `${draftRoot}/${draft.value.id}/save`,
        'POST',
        save,
        headers,
      ),
      replayed = await json(
        `${draftRoot}/${draft.value.id}/save`,
        'POST',
        save,
        headers,
      );
    if (saved.value.id !== replayed.value.id) throw Error('REPLAY_MISMATCH');
    completed.push(stage);
    mark('SHARED_DOCUMENT_SAVE');
    const editorRoot = `/capture/projects/${p}/editor-drafts`;
    const doc = await json(
      editorRoot,
      'POST',
      {
        operationId: randomUUID(),
        workflow: 'PROJECT_DOCUMENT',
        documentType: 'RESEARCH',
      },
      headers,
      201,
    );
    const docEdit = await json(
      `${editorRoot}/${doc.value.id}`,
      'PATCH',
      {
        operationId: randomUUID(),
        expectedRevision: doc.value.revision,
        title: 'Synthetic research',
        contentMarkdown: 'Chưa xác minh nguyên nhân timeout.',
      },
      headers,
    );
    const docSave = await json(
      `${editorRoot}/${doc.value.id}/save`,
      'POST',
      {
        operationId: randomUUID(),
        expectedRevision: docEdit.value.revision,
        discardOriginalConfirmed: false,
      },
      headers,
    );
    if (docSave.value.status !== 'DRAFT') throw Error('IMPLICIT_SUBMISSION');
    completed.push(stage);
    const result = {
      status: 'PASS',
      model: 'mistralai/ministral-14b',
      realIam: true,
      realTaskApi: true,
      realCapture: true,
      realRedis: true,
      disposableMongoDB: true,
      realProvider: true,
      gateway: 'Separate HTTP transport suite; monolith AppModule used here',
      completed,
      sharedAtlasMigration: false,
    };
    mkdirSync(resolve(root, '.worknote-agent-evals'), { recursive: true });
    writeFileSync(
      resolve(root, '.worknote-agent-evals/application-smoke-result.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
    return result;
  } catch (error) {
    const result = {
      status: 'FAIL',
      stage,
      errorCode:
        error instanceof Error && /^HTTP_\d+$/.test(error.message)
          ? error.message
          : 'APPLICATION_SMOKE_FAILED',
      errorType: error?.name,
      errorLocation: error?.stack
        ?.split('\n')
        .find((line) => line.trim().startsWith('at '))
        ?.replace(root, '<repository>'),
      completed,
      sharedAtlasMigration: false,
    };
    mkdirSync(resolve(root, '.worknote-agent-evals'), { recursive: true });
    writeFileSync(
      resolve(root, '.worknote-agent-evals/application-smoke-result.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
    return result;
  } finally {
    await app?.close();
    await connection?.close();
    await repl.stop();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runApplicationSmoke()
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(result.status === 'FAIL' ? 1 : 0);
    })
    .catch(() => {
      console.error(
        'Application smoke setup failed. No credentials or source content are logged.',
      );
      process.exit(1);
    });
