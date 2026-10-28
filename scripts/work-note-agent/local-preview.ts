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
import { WorkNoteAssessmentController } from '../../src/services/capture/controllers/work-note-assessment.controller';
import { WorkNoteAssessmentService } from '../../src/services/capture/application/work-note-agent/work-note-assessment.service';
import { WorkNoteEditorService } from '../../src/services/capture/application/work-note-agent/work-note-editor.service';
import { WorkNoteAgentDraftsService } from '../../src/services/capture/application/work-note-agent/work-note-agent-drafts.service';
import { WorkNotesService } from '../../src/services/capture/application/work-notes.service';
import type { WorkNotesAuthorizationService } from '../../src/services/capture/application/work-notes-authorization.service';
import type { CaptureRequestHeaders } from '../../src/services/capture/application/work-notes.types';
import { WorkNoteAgentModel } from '../../src/services/capture/infrastructure/ai/work-note-agent.model';
import { RedisService } from '../../src/services/capture/infrastructure/redis/redis.service';
import {
  ASSESSMENT_PROMPT_VERSION,
  buildAssessmentMessages,
  parseAssessmentOutput,
} from '../../src/services/capture/application/work-note-agent/work-note-assessment.protocol';
import type {
  AssessmentModelInput,
  AssessmentModelOutput,
} from '../../src/services/capture/application/work-note-agent/work-note-assessment.types';
import {
  parseAgentResult,
  prepareAgentRequest,
  type AgentInput,
} from '../../src/services/capture/application/work-note-agent/work-note-agent';

/** Synthetic UI fixture, never a provider fallback or production dependency. */
class PreviewAssessmentModel extends WorkNoteAgentModel {
  override assess(input: AssessmentModelInput) {
    buildAssessmentMessages(input);
    const body = input.sources.find((s) => s.id === 'note.body')!;
    const title = input.sources.find((s) => s.id === 'task.title')!;
    const description = input.sources.find((s) => s.id === 'task.description')!;
    const purpose =
      input.purpose === 'AUTO'
        ? /\bQA\b|kiểm thử editor/iu.test(body.text)
          ? 'QA'
          : 'PROGRESS'
        : input.purpose;
    const hasReply = input.answers.some(
      (a) => a.disposition === 'answered' && !!a.answer?.trim(),
    );
    const needsQuestion = purpose !== 'QA' && !hasReply;
    const authorSources = input.sources.filter(
      (s) =>
        (s.id === 'note.body' ||
          (s.kind === 'ANSWER' &&
            input.answers.some(
              (a) =>
                s.id === `answer.${a.id}` &&
                a.disposition === 'answered' &&
                !!a.answer?.trim(),
            ))) &&
        !!s.text.trim(),
    );
    const output: AssessmentModelOutput = {
      purpose,
      taskUnderstanding: {
        objective: title.text,
        scope:
          'Synthetic retry preview task; authors report execution results.',
        requirements: description.text
          ? [
              {
                text: description.text,
                sourceRefs: [
                  { sourceId: description.id, quote: description.text },
                ],
              },
            ]
          : [],
        unknowns: [],
      },
      claims: authorSources.map((s) => ({
        text: s.text.slice(0, 2000),
        sourceRefs: [{ sourceId: s.id, quote: s.text.slice(0, 2000) }],
        originKind: 'AUTHOR_REPORT',
        supportRelation: 'FULL',
      })),
      coverage: description.text
        ? [{ requirementIndex: 0, status: 'NOT_REPORTED', sourceRefs: [] }]
        : [],
      gaps: needsQuestion
        ? [
            {
              kind: 'RESULT',
              target: 'observed retry result',
              impact: 'BLOCKING',
              owner: 'NOTE_AUTHOR',
              sourceRefs: [
                { sourceId: body.id, quote: body.text.slice(0, 2000) },
              ],
            },
          ]
        : [],
      taskContextStatus: 'CLEAR',
      noteAdequacy: needsQuestion ? 'NEEDS_AUTHOR_INPUT' : 'ENOUGH_FOR_PURPOSE',
      nextQuestion:
        needsQuestion && !input.answers.length
          ? {
              gapIndex: 0,
              text: 'Bạn đã quan sát thấy kết quả retry nào trong lần kiểm tra này?',
              reason:
                'Cần lời tác giả mô tả kết quả để biên tập bản ghi tiến độ.',
              options: [],
            }
          : null,
    };
    return Promise.resolve({
      result: parseAssessmentOutput(input, JSON.stringify(output)),
      provenance: {
        model: 'synthetic/local-assessment-fixture',
        promptVersion: ASSESSMENT_PROMPT_VERSION,
        promptTokens: 0,
        completionTokens: 0,
        httpAttempts: 0,
        durationMs: 0,
      },
    });
  }
  override rewrite(input: AgentInput) {
    const prepared = prepareAgentRequest(input);
    const payload = JSON.parse(prepared.messages.at(-1)!.content) as {
      source: { text: string };
    };
    const clarifications = input.clarifications
      .filter((a) => a.state === 'answered' && !!a.answer)
      .map((a) => a.answer!)
      .join('\n\n');
    const replacement = [payload.source.text, clarifications]
      .filter(Boolean)
      .join('\n\n');
    return Promise.resolve({
      result: parseAgentResult(
        prepared,
        JSON.stringify({
          status: 'SUGGESTION_READY',
          message: 'Synthetic preview proposal; review before applying.',
          suggestion: {
            replacementText: input.operation === 'title' ? null : replacement,
            suggestedTitle:
              input.operation === 'title'
                ? input.draft.title || 'Synthetic preview note'
                : null,
            changeSummary: [
              'Preserved the draft and included only supplied author replies.',
            ],
          },
          questions: [],
          uncertainties: [],
        }),
      ),
      provenance: {
        provider: 'synthetic',
        model: 'synthetic/local-assessment-fixture',
        promptVersion: prepared.promptVersion,
        formattingRecovery: [] as readonly string[],
        promptTokens: 0,
        completionTokens: 0,
      },
    });
  }
}

async function main() {
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.WORKNOTE_AGENT_LOCAL_PREVIEW !== 'true'
  )
    throw Error('Explicit development-only preview opt-in required.');
  const assessmentFixture =
    process.env.WORKNOTE_AGENT_PREVIEW_ASSESSMENT_FIXTURE === 'true';
  if (
    assessmentFixture &&
    !['development', 'test'].includes(process.env.NODE_ENV ?? '')
  )
    throw Error('Synthetic assessment preview requires development or test.');
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
  const env = assessmentFixture
    ? {}
    : parse(await readFile(resolve(__dirname, '../../.env'), 'utf8'));
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
    WORKNOTE_ASSESSMENT_ENABLED: assessmentFixture,
    XKIRO_API_KEY: assessmentFixture
      ? undefined
      : (process.env.XKIRO_API_KEY ?? env.XKIRO_API_KEY),
    XKIRO_MODEL: assessmentFixture
      ? 'synthetic/local-assessment-fixture'
      : (process.env.XKIRO_MODEL ??
        env.XKIRO_MODEL ??
        'qwen/qwen3.7-flash:free'),
  });
  const model = assessmentFixture
    ? new PreviewAssessmentModel(config)
    : new WorkNoteAgentModel(config);
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
  const redisPort = assessmentFixture
    ? undefined
    : process.env.WORKNOTE_AGENT_PREVIEW_REDIS_PORT;
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
    model,
    redis,
    connection,
  );
  const module = await Test.createTestingModule({
    controllers: [
      WorkNoteAgentController,
      WorkNoteEditorController,
      WorkNoteAssessmentController,
    ],
    providers: [
      { provide: WorkNoteAgentDraftsService, useValue: service },
      {
        provide: WorkNoteAssessmentService,
        useValue: new WorkNoteAssessmentService(
          config,
          authorization,
          notes,
          model,
          redis,
          connection,
        ),
      },
      {
        provide: WorkNoteEditorService,
        useValue: new WorkNoteEditorService(
          config,
          authorization,
          notes,
          model,
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
  if (assessmentFixture)
    console.log(
      'Assessment provider: SYNTHETIC deterministic fixture. No xKiro client, credentials or provider network calls. This is UI/lifecycle validation, not model-quality evidence.',
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
