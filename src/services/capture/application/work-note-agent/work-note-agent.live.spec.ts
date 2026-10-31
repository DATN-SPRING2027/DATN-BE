import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import request from 'supertest';
import { WorkNoteAgentDraftsService } from './work-note-agent-drafts.service';
import { WorkNoteAgentController } from '../../controllers/work-note-agent.controller';
import { WorkNoteAgentModel } from '../../infrastructure/ai/work-note-agent.model';
import type { RedisService } from '../../infrastructure/redis/redis.service';
import type { WorkNotesService } from '../work-notes.service';
import type { WorkNotesAuthorizationService } from '../work-notes-authorization.service';
import type { CaptureRequestHeaders } from '../work-notes.types';
import type {
  AgentDraftView,
  CanonicalTaskNote,
} from './work-note-agent-drafts.types';
import type { AgentResult } from './work-note-agent';

const live =
  process.env.WORKNOTE_AGENT_LIVE_TEST === 'true' ? describe : describe.skip;
live('synthetic-only HTTP → MongoDB → real xKiro → Apply → Save', () => {
  jest.setTimeout(120000);
  let app: INestApplication, repl: MongoMemoryReplSet, connection: Connection;
  const projectId = new Types.ObjectId().toHexString(),
    taskId = new Types.ObjectId().toHexString(),
    organizationId = new Types.ObjectId().toHexString(),
    userId = new Types.ObjectId().toHexString();
  const token = `synthetic-${randomUUID()}`,
    prefix = `/internal/capture/projects/${projectId}/work-note-drafts`;
  beforeAll(async () => {
    const env = parse(readFileSync(resolve(process.cwd(), '.env')));
    const key = process.env.XKIRO_API_KEY ?? env.XKIRO_API_KEY;
    if (!key) throw Error('Configure the local xKiro test credential.');
    repl = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: { count: 1 },
    });
    connection = await mongoose
      .createConnection(repl.getUri(), { dbName: 'continuum_capture' })
      .asPromise();
    await connection
      .db!.collection('work_note_versions')
      .createIndex({ workNoteId: 1, versionNumber: 1 }, { unique: true });
    for (const name of ['work_note_agent_drafts', 'work_note_agent_operations'])
      await connection
        .db!.collection(name)
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    const actor = {
      userId,
      userName: 'Synthetic author',
      projectId,
      organizationId,
      canReview: false,
      canConfigure: false,
      taskTitle: 'Retry flow',
      taskContext: {
        title: 'Retry flow',
        description: 'Validate behaviour when the network is unavailable.',
        status: 'DONE',
        steps: [],
      },
    };
    const authorize = (
      headers: CaptureRequestHeaders,
      p: string,
      t = taskId,
    ) => {
      if (
        headers.authorization !== `Bearer ${token}` ||
        p !== projectId ||
        t !== taskId
      )
        throw new UnauthorizedException();
      return Promise.resolve(actor);
    };
    const auth = { resolveProject: authorize, resolveTask: authorize };
    const config = new ConfigService({
      WORKNOTE_EDITOR_ENABLED: true,
      WORKNOTE_AGENT_ENABLED: true,
      WORKNOTE_AGENT_FORMATTING_RECOVERY: true,
      XKIRO_API_KEY: key,
      XKIRO_MODEL: 'qwen/qwen3.7-flash:free',
    });
    const service = new WorkNoteAgentDraftsService(
      config,
      auth as unknown as WorkNotesAuthorizationService,
      {} as WorkNotesService,
      new WorkNoteAgentModel(config),
      {
        consumeRateLimit: () => Promise.resolve(true),
      } as unknown as RedisService,
      connection,
    );
    const module = await Test.createTestingModule({
      controllers: [WorkNoteAgentController],
      providers: [{ provide: WorkNoteAgentDraftsService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('internal');
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await connection?.close();
    await repl?.stop();
  });
  it('persists only the explicitly confirmed canonical text and no conversation/raw input', async () => {
    const http = () => request(app.getHttpServer());
    const created = await http()
      .post(prefix)
      .set('authorization', `Bearer ${token}`)
      .send({ operationId: randomUUID(), taskId })
      .expect(201);
    const d = created.body as AgentDraftView;
    const edited = await http()
      .patch(`${prefix}/${d.id}`)
      .set('authorization', `Bearer ${token}`)
      .send({
        operationId: randomUUID(),
        expectedRevision: 1,
        title: 'Synthetic network retry',
        contentMarkdown: 'Đả thêm nút retry; chưa kiểm thử lỗi mất mạng.',
      })
      .expect(200);
    const draft = edited.body as AgentDraftView;
    const response = await http()
      .post(`${prefix}/${d.id}/agent/messages`)
      .set('authorization', `Bearer ${token}`)
      .send({
        operationId: randomUUID(),
        expectedRevision: draft.revision,
        operation: 'grammar',
        scope: 'whole_note',
        instruction: 'Sửa chính tả, giữ nguyên ý và giới hạn kiểm thử.',
        includeWholeNoteContext: false,
      })
      .expect(200);
    const agent = response.body as AgentResult;
    expect(agent.status).toBe('SUGGESTION_READY');
    expect(agent.suggestion?.replacementText).toContain('chưa');
    const applied = await http()
      .post(`${prefix}/${d.id}/agent/suggestions/${agent.suggestion!.id}/apply`)
      .set('authorization', `Bearer ${token}`)
      .send({
        operationId: randomUUID(),
        expectedRevision: draft.revision,
        action: 'replace_body',
        applyTitle: false,
      })
      .expect(200);
    const next = applied.body as AgentDraftView;
    await http()
      .post(`${prefix}/${d.id}/save`)
      .set('authorization', `Bearer ${token}`)
      .send({
        operationId: randomUUID(),
        expectedRevision: next.revision,
        discardOriginalConfirmed: false,
      })
      .expect(422);
    const saved = await http()
      .post(`${prefix}/${d.id}/save`)
      .set('authorization', `Bearer ${token}`)
      .send({
        operationId: randomUUID(),
        expectedRevision: next.revision,
        discardOriginalConfirmed: true,
      })
      .expect(200);
    const canonical = saved.body as CanonicalTaskNote;
    expect(canonical.contentMarkdown).toBe(agent.suggestion!.replacementText);
    expect(canonical.currentVersionNumber).toBe(1);
    expect(
      await connection
        .db!.collection('work_note_agent_drafts')
        .countDocuments(),
    ).toBe(0);
    const receipt = JSON.stringify(
      await connection
        .db!.collection('work_note_agent_operations')
        .find()
        .toArray(),
    );
    expect(receipt).not.toContain('replacementText');
    expect(receipt).not.toContain('conversation');
    expect(receipt).not.toContain('contentMarkdown');
  });
});
