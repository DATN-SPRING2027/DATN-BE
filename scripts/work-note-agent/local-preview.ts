/** Disposable local integration fixture. Never imported by application modules. */
import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { parse } from 'dotenv';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { WorkNoteAgentController } from '../../src/services/capture/controllers/work-note-agent.controller';
import { WorkNoteEditorController } from '../../src/services/capture/controllers/work-note-editor.controller';
import { WorkNoteEditorService } from '../../src/services/capture/application/work-note-agent/work-note-editor.service';
import { WorkNoteAgentDraftsService } from '../../src/services/capture/application/work-note-agent/work-note-agent-drafts.service';
import { WorkNotesService } from '../../src/services/capture/application/work-notes.service';
import type { WorkNotesAuthorizationService } from '../../src/services/capture/application/work-notes-authorization.service';
import type { CaptureRequestHeaders } from '../../src/services/capture/application/work-notes.types';
import { WorkNoteAgentModel } from '../../src/services/capture/infrastructure/ai/work-note-agent.model';
import { RedisService } from '../../src/services/capture/infrastructure/redis/redis.service';

async function main() {
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.WORKNOTE_AGENT_LOCAL_PREVIEW !== 'true'
  )
    throw Error('Explicit development-only preview opt-in required.');
  const dbPackage = process.env.WORKNOTE_AGENT_DB_PACKAGE;
  if (!dbPackage)
    throw Error(
      'Set WORKNOTE_AGENT_DB_PACKAGE to the separate reviewed DB worktree.',
    );
  const migrationModule: unknown = await import(
    pathToFileURL(
      resolve(dbPackage, 'scripts/migrations/20261027-work-note-agent.mjs'),
    ).href
  );
  const migrate = (
    migrationModule as {
      migrateWorkNoteAgent: (
        client: mongoose.mongo.MongoClient,
        options: { apply: boolean },
      ) => Promise<unknown>;
    }
  ).migrateWorkNoteAgent;
  if (typeof migrate !== 'function')
    throw Error('DB package migration is unavailable.');
  const env = parse(await readFile(resolve(__dirname, '../../.env'), 'utf8'));
  const repl = await MongoMemoryReplSet.create({
    binary: { version: '7.0.24' },
    replSet: { count: 1 },
  });
  const connection = await mongoose
    .createConnection(repl.getUri(), { dbName: 'continuum_capture' })
    .asPromise();
  await migrate(connection.getClient(), { apply: true });
  const editorMigration = (await import(
    pathToFileURL(
      resolve(dbPackage, 'scripts/migrations/20261028-work-note-editor.mjs'),
    ).href
  )) as {
    migrateWorkNoteEditor: (
      client: mongoose.mongo.MongoClient,
      options: { apply: boolean },
    ) => Promise<unknown>;
  };
  await editorMigration.migrateWorkNoteEditor(connection.getClient(), {
    apply: true,
  });
  const projectId = '651a2b3c4d5e6f7a8b9c0d21',
    taskId = '851a2b3c4d5e6f7a8b9c0d21';
  const actor = {
    userId: '951a2b3c4d5e6f7a8b9c0d21',
    organizationId: 'a51a2b3c4d5e6f7a8b9c0d21',
    projectId,
    userName: 'Synthetic preview author',
    canReview: false,
    canConfigure: false,
    taskTitle: 'Validate retry behaviour',
    taskContext: {
      title: 'Validate retry behaviour',
      description:
        'Add retry support; verify network failure and rollback before release.',
      status: 'DONE',
      steps: [],
    },
  };
  const authorize = (headers: CaptureRequestHeaders, p: string, t = taskId) => {
    if (
      headers.authorization !== 'Bearer worknote-local-fixture' ||
      p !== projectId ||
      t !== taskId
    )
      throw new UnauthorizedException();
    return Promise.resolve(actor);
  };
  const authorization = {
    resolveProject: authorize,
    resolveTask: authorize,
  } as unknown as WorkNotesAuthorizationService;
  const notes = new WorkNotesService(authorization, connection);
  const reportPeriod = new Date('2026-10-26T00:00:00.000Z'),
    reportEnd = new Date('2026-11-02T00:00:00.000Z');
  await connection.db!.collection('work_reports').insertOne({
    _id: new mongoose.Types.ObjectId('b51a2b3c4d5e6f7a8b9c0d21'),
    organizationId: new mongoose.Types.ObjectId(actor.organizationId),
    projectId: new mongoose.Types.ObjectId(projectId),
    memberUserId: new mongoose.Types.ObjectId(actor.userId),
    reportScope: 'MEMBER',
    frequency: 'WEEKLY',
    periodStart: reportPeriod,
    periodEnd: reportEnd,
    dueAt: reportEnd,
    status: 'DRAFT',
    accomplishments: 'Đã thêm nút retry.',
    approach: 'Kiểm tra log.',
    reason: 'Chưa xác định nguyên nhân timeout.',
    reviewHistory: [],
    createdAt: reportPeriod,
    updatedAt: reportPeriod,
  });
  const config = new ConfigService({
    WORKNOTE_EDITOR_ENABLED: true,
    WORKNOTE_SHARED_EDITOR_ENABLED: true,
    WORKNOTE_AGENT_ENABLED: true,
    WORKNOTE_AGENT_FORMATTING_RECOVERY: true,
    XKIRO_API_KEY: process.env.XKIRO_API_KEY ?? env.XKIRO_API_KEY,
    XKIRO_MODEL:
      process.env.XKIRO_MODEL ?? env.XKIRO_MODEL ?? 'qwen/qwen3.7-flash:free',
  });
  const rateWindows = new Map<string, { started: number; count: number }>();
  const quotaFixture = {
    consumeRateLimit: (key: string, limit: number, seconds: number) => {
      let window = rateWindows.get(key);
      if (!window || Date.now() - window.started >= seconds * 1000) {
        window = { started: Date.now(), count: 0 };
        rateWindows.set(key, window);
      }
      return Promise.resolve(++window.count <= limit);
    },
  } as unknown as RedisService;
  const redisPort = process.env.WORKNOTE_AGENT_PREVIEW_REDIS_PORT;
  if (
    redisPort &&
    (!Number.isSafeInteger(Number(redisPort)) ||
      Number(redisPort) < 1024 ||
      Number(redisPort) > 65535)
  )
    throw Error('Explicit disposable loopback Redis port is invalid');
  const realRedis = redisPort
    ? new RedisService(
        new ConfigService({
          REDIS_HOST: '127.0.0.1',
          REDIS_PORT: Number(redisPort),
        }),
      )
    : undefined;
  const redis = realRedis ?? quotaFixture;
  const service = new WorkNoteAgentDraftsService(
    config,
    authorization,
    notes,
    new WorkNoteAgentModel(config),
    redis,
    connection,
  );
  const module = await Test.createTestingModule({
    controllers: [WorkNoteAgentController, WorkNoteEditorController],
    providers: [
      { provide: WorkNoteAgentDraftsService, useValue: service },
      {
        provide: WorkNoteEditorService,
        useValue: new WorkNoteEditorService(
          config,
          authorization,
          notes,
          new WorkNoteAgentModel(config),
          redis,
          connection,
        ),
      },
    ],
  }).compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix('internal');
  await app.listen(3192, '127.0.0.1');
  console.log(
    'Disposable WorkNote fixture ready at http://127.0.0.1:3192/internal. Only synthetic fixture identity and a temporary local MongoDB are used.',
  );
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    realRedis?.onModuleDestroy();
    void app
      .close()
      .then(() => connection.close())
      .then(() => repl.stop())
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
void main().catch(() => {
  console.error(
    'Local WorkNote preview setup failed. No credential or source content is logged.',
  );
  process.exitCode = 1;
});
