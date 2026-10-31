import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import mongoose, { Types, type Connection } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { configureApplication } from '../../../../bootstrap';
import { GatewayCaptureController } from '../../../../gateway/gateway-capture.controller';
import { WorkNoteAgentController } from '../../controllers/work-note-agent.controller';
import { WorkNoteEditorController } from '../../controllers/work-note-editor.controller';
import { WorkNoteEditorService } from './work-note-editor.service';
import { WorkNotesAuthorizationService } from '../work-notes-authorization.service';
import { WorkNotesService } from '../work-notes.service';
import { WorkNoteAgentDraftsService } from './work-note-agent-drafts.service';
import { WorkNoteAgentModel } from '../../infrastructure/ai/work-note-agent.model';
import { RedisService } from '../../infrastructure/redis/redis.service';
import {
  parseAgentResult,
  prepareAgentRequest,
  type AgentInput,
} from './work-note-agent';
import type { AgentDraftView } from './work-note-agent-drafts.types';

/** Actual HTTP transport and authorization adapter; IAM/Task replies and quota/model are fixtures. */
describe('WorkNote Gateway → Capture → authorization HTTP → MongoDB', () => {
  jest.setTimeout(90000);
  let iam: Server,
    capture: INestApplication,
    gateway: INestApplication,
    repl: MongoMemoryReplSet,
    connection: Connection;
  const projectId = new Types.ObjectId().toHexString(),
    taskId = new Types.ObjectId().toHexString(),
    userId = new Types.ObjectId().toHexString(),
    organizationId = new Types.ObjectId().toHexString();
  const root = `/api/v1/capture/projects/${projectId}/work-note-drafts`;
  let active = true;
  let realRedis: RedisService | undefined;
  const csrf = 'synthetic-csrf-token',
    cookie = `continuum_access=fixture; continuum_csrf=${csrf}`;
  const model = {
    rewrite: jest.fn((input: AgentInput) =>
      Promise.resolve({
        result: parseAgentResult(
          prepareAgentRequest(input),
          JSON.stringify({
            status: 'SUGGESTION_READY',
            message: 'Proposal',
            suggestion: {
              replacementText: 'Chưa kiểm thử.',
              suggestedTitle: null,
              changeSummary: ['Sửa câu.'],
            },
            questions: [],
            uncertainties: [],
          }),
        ),
        provenance: {
          provider: 'fixture',
          model: 'fixture',
          promptVersion: 'fixture',
        },
      }),
    ),
  };
  beforeAll(async () => {
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
    await connection
      .db!.collection('work_report_versions')
      .createIndex({ reportId: 1, versionNumber: 1 }, { unique: true });
    await connection
      .db!.collection('project_document_editor_versions')
      .createIndex({ documentId: 1, versionNumber: 1 }, { unique: true });
    for (const name of ['work_note_agent_drafts', 'work_note_agent_operations'])
      await connection
        .db!.collection(name)
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    iam = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      const reply = (value: unknown, status = 200) => {
        res.statusCode = status;
        res.end(JSON.stringify(value));
      };
      if (!active || !req.headers.cookie?.includes('continuum_access=fixture'))
        return reply({ code: 'UNAUTHORIZED' }, 401);
      if (req.url === '/api/v1/auth/me')
        return reply({
          id: userId,
          organizationId,
          name: 'Synthetic member',
          roles: ['MEMBER'],
        });
      if (req.url === `/api/v1/iam/projects/${projectId}`)
        return reply({ id: projectId, organizationId, status: 'ACTIVE' });
      if (req.url === `/api/v1/iam/projects/${projectId}/settings-access`)
        return reply({ canUpdateProject: false });
      if (req.url?.startsWith(`/api/v1/iam/projects/${projectId}/memberships?`))
        return reply({
          data: [{ userId, joinedAt: '2026-10-01T00:00:00.000Z' }],
          pagination: { totalPages: 1 },
        });
      if (req.url === `/internal/tasks/projects/${projectId}/tasks/${taskId}`)
        return reply({
          id: taskId,
          projectId,
          title: 'Verify upload',
          description: 'Test failures before release.',
          status: 'DONE',
          steps: [],
        });
      return reply({ code: 'NOT_FOUND' }, 404);
    });
    await new Promise<void>((resolve) => iam.listen(0, '127.0.0.1', resolve));
    const authorityUrl = `http://127.0.0.1:${(iam.address() as AddressInfo).port}`;
    const config = new ConfigService({
      WORKNOTE_EDITOR_ENABLED: true,
      WORKNOTE_SHARED_EDITOR_ENABLED: true,
      IAM_SERVICE_URL: authorityUrl,
      TASK_SERVICE_URL: authorityUrl,
      BACKEND_TIMEOUT_MS: 2000,
    });
    const authority = new WorkNotesAuthorizationService(config);
    const notes = new WorkNotesService(authority, connection);
    const redisPort = process.env.WORKNOTE_AGENT_REDIS_TEST_PORT;
    if (redisPort) {
      const port = Number(redisPort);
      if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
        throw Error('An explicit disposable loopback Redis port is required');
      realRedis = new RedisService(
        new ConfigService({ REDIS_HOST: '127.0.0.1', REDIS_PORT: port }),
      );
    }
    const service = new WorkNoteAgentDraftsService(
      config,
      authority,
      notes,
      model as unknown as WorkNoteAgentModel,
      realRedis ??
        ({
          consumeRateLimit: () => Promise.resolve(true),
        } as unknown as RedisService),
      connection,
    );
    const c = await Test.createTestingModule({
      controllers: [WorkNoteAgentController, WorkNoteEditorController],
      providers: [
        { provide: WorkNoteAgentDraftsService, useValue: service },
        {
          provide: WorkNoteEditorService,
          useValue: new WorkNoteEditorService(
            config,
            authority,
            notes,
            model as unknown as WorkNoteAgentModel,
            realRedis ??
              ({
                consumeRateLimit: () => Promise.resolve(true),
              } as unknown as RedisService),
            connection,
          ),
        },
      ],
    }).compile();
    capture = c.createNestApplication();
    configureApplication(capture);
    capture.setGlobalPrefix('internal');
    await capture.listen(0, '127.0.0.1');
    const g = await Test.createTestingModule({
      controllers: [GatewayCaptureController],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({
            CAPTURE_SERVICE_URL: await capture.getUrl(),
            BACKEND_TIMEOUT_MS: 5000,
          }),
        },
      ],
    }).compile();
    gateway = g.createNestApplication();
    configureApplication(gateway);
    await gateway.init();
  });
  afterAll(async () => {
    realRedis?.onModuleDestroy();
    await gateway?.close();
    await capture?.close();
    if (iam)
      await new Promise<void>((resolve, reject) =>
        iam.close((error) => (error ? reject(error) : resolve())),
      );
    await connection?.close();
    await repl?.stop();
  });
  beforeEach(() => {
    active = true;
    model.rewrite.mockClear();
  });
  const http = () => request(gateway.getHttpServer());
  async function create() {
    const r = await http()
      .post(root)
      .set('cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({ taskId, operationId: randomUUID() })
      .expect(201);
    return r.body as AgentDraftView;
  }
  it('forwards a JSON null resume with private caching and request ID', async () => {
    const r = await http()
      .get(`${root}?taskId=${taskId}`)
      .set('cookie', cookie)
      .expect(200);
    expect(r.body).toBeNull();
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.headers['x-request-id']).toBeTruthy();
  });
  it('rejects missing session, wrong organization, cross-Project Task and CSRF before inference', async () => {
    await http()
      .post(root)
      .send({ taskId, operationId: randomUUID() })
      .expect(401);
    await http()
      .post(root)
      .set('cookie', cookie)
      .send({ taskId, operationId: randomUUID() })
      .expect(403);
    await http()
      .post(root)
      .set('cookie', cookie)
      .set('x-csrf-token', csrf)
      .set('x-organization-id', new Types.ObjectId().toHexString())
      .send({ taskId, operationId: randomUUID() })
      .expect(404);
    await http()
      .post(root)
      .set('cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({
        taskId: new Types.ObjectId().toHexString(),
        operationId: randomUUID(),
      })
      .expect(404);
    expect(model.rewrite).not.toHaveBeenCalled();
  });
  it('exposes the shared Document contract without Task fields and rejects invented context', async () => {
    const path = `/api/v1/capture/projects/${projectId}/editor-drafts`;
    await http()
      .post(path)
      .set('cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({
        operationId: randomUUID(),
        workflow: 'PROJECT_DOCUMENT',
        documentType: ['RESEARCH'],
      })
      .expect(422);
    await http()
      .post(path)
      .set('cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({
        operationId: randomUUID(),
        workflow: 'PROJECT_DOCUMENT',
        documentType: 'RESEARCH',
        taskId,
      })
      .expect(422);
    const created = await http()
      .post(path)
      .set('cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({
        operationId: randomUUID(),
        workflow: 'PROJECT_DOCUMENT',
        documentType: 'RESEARCH',
      })
      .expect(201);
    const d = created.body as {
      id: string;
      revision: number;
      workflow: string;
      taskId?: unknown;
    };
    expect(d.workflow).toBe('PROJECT_DOCUMENT');
    expect(d.taskId).toBeUndefined();
    await http().get(`${root}/${d.id}`).set('cookie', cookie).expect(404);
    const taskDraft = await create();
    await http()
      .get(`${path}/${taskDraft.id}`)
      .set('cookie', cookie)
      .expect(404);
    const edited = await http()
      .patch(`${path}/${d.id}`)
      .set('cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({
        operationId: randomUUID(),
        expectedRevision: d.revision,
        title: 'Research',
        contentMarkdown: 'Chưa test.',
      })
      .expect(200);
    await http()
      .post(`${path}/${d.id}/agent/messages`)
      .set('cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({
        operationId: randomUUID(),
        expectedRevision: (edited.body as { revision: number }).revision,
        operation: 'grammar',
        scope: 'whole_note',
        instruction: 'Sửa câu.',
        includeWholeNoteContext: false,
      })
      .expect(200);
    expect(model.rewrite.mock.lastCall?.[0]).toMatchObject({
      workflow: 'PROJECT_DOCUMENT',
      task: null,
    });
    await http()
      .post(`${path}/${d.id}/save`)
      .set('cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({
        operationId: randomUUID(),
        expectedRevision: (edited.body as { revision: number }).revision,
        discardOriginalConfirmed: false,
      })
      .expect(200);
  });
  it('passes only authorized Task context, binds proposals and saves once through the public Gateway', async () => {
    const d = await create();
    const edited = await http()
      .patch(`${root}/${d.id}`)
      .set('cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({
        operationId: randomUUID(),
        expectedRevision: d.revision,
        title: 'Upload limits',
        contentMarkdown: 'Chưa test.',
      })
      .expect(200);
    const revision = (edited.body as AgentDraftView).revision;
    const response = await http()
      .post(`${root}/${d.id}/agent/messages`)
      .set('cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({
        operationId: randomUUID(),
        expectedRevision: revision,
        operation: 'grammar',
        scope: 'whole_note',
        instruction: 'Sửa câu, giữ giới hạn.',
        includeWholeNoteContext: false,
      })
      .expect(200);
    expect(model.rewrite.mock.calls[0][0].task?.status).toBe('DONE');
    expect(model.rewrite.mock.calls[0][0].draft.body).toBe('Chưa test.');
    const proposal = response.body as { suggestion: { id: string } };
    const applied = await http()
      .post(`${root}/${d.id}/agent/suggestions/${proposal.suggestion.id}/apply`)
      .set('cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({
        operationId: randomUUID(),
        expectedRevision: revision,
        action: 'replace_body',
        applyTitle: false,
      })
      .expect(200);
    const payload = {
      operationId: randomUUID(),
      expectedRevision: (applied.body as AgentDraftView).revision,
      discardOriginalConfirmed: true,
    };
    const save = () =>
      http()
        .post(`${root}/${d.id}/save`)
        .set('cookie', cookie)
        .set('x-csrf-token', csrf)
        .send(payload);
    const first = await save().expect(200);
    const replay = await save().expect(200);
    expect(replay.body).toEqual(first.body);
    expect(
      await connection.db!.collection('work_note_versions').countDocuments(),
    ).toBe(1);
  });
  it('rejects drafts immediately after session membership is revoked', async () => {
    const d = await create();
    active = false;
    await http().get(`${root}/${d.id}`).set('cookie', cookie).expect(401);
    expect(model.rewrite).not.toHaveBeenCalled();
  });
  (process.env.WORKNOTE_AGENT_REDIS_TEST_PORT ? it : it.skip)(
    'enforces the real shared Redis quota while ordinary Save remains available',
    async () => {
      const d = await create();
      const update = await http()
        .patch(`${root}/${d.id}`)
        .set('cookie', cookie)
        .set('x-csrf-token', csrf)
        .send({
          operationId: randomUUID(),
          expectedRevision: d.revision,
          title: 'Save after quota',
          contentMarkdown: 'Chưa kiểm thử.',
        })
        .expect(200);
      const revision = (update.body as AgentDraftView).revision;
      await realRedis!.set(
        `rate:worknote-agent:${organizationId}:${userId}`,
        '10',
        60,
      );
      await http()
        .post(`${root}/${d.id}/agent/messages`)
        .set('cookie', cookie)
        .set('x-csrf-token', csrf)
        .send({
          operationId: randomUUID(),
          expectedRevision: revision,
          operation: 'grammar',
          scope: 'whole_note',
          instruction: 'Sửa câu.',
          includeWholeNoteContext: false,
        })
        .expect(429);
      expect(model.rewrite).not.toHaveBeenCalled();
      await http()
        .post(`${root}/${d.id}/save`)
        .set('cookie', cookie)
        .set('x-csrf-token', csrf)
        .send({
          operationId: randomUUID(),
          expectedRevision: revision,
          discardOriginalConfirmed: false,
        })
        .expect(200);
    },
  );
});
