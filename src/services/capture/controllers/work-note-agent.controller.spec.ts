import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { WorkNoteAgentController } from './work-note-agent.controller';
import { WorkNoteAgentDraftsService } from '../application/work-note-agent/work-note-agent-drafts.service';
describe('Agent controller HTTP boundary', () => {
  let app: INestApplication;
  const create = jest.fn(() => Promise.resolve({ id: randomUUID() }));
  const project = '651a2b3c4d5e6f7a8b9c0d21',
    task = '851a2b3c4d5e6f7a8b9c0d21';
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WorkNoteAgentController],
      providers: [
        {
          provide: WorkNoteAgentDraftsService,
          useValue: { create, resume: () => Promise.resolve(null) },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('internal');
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => create.mockClear());
  it('uses the existing internal Capture prefix and rejects caller-supplied authority', async () => {
    await request(app.getHttpServer())
      .post(`/internal/capture/projects/${project}/work-note-drafts`)
      .set('authorization', 'Bearer synthetic-session')
      .send({
        operationId: randomUUID(),
        taskId: task,
        model: 'untrusted/model',
      })
      .expect(422);
    expect(create).not.toHaveBeenCalled();
    const response = await request(app.getHttpServer())
      .post(`/internal/capture/projects/${project}/work-note-drafts`)
      .set('authorization', 'Bearer synthetic-session')
      .send({ operationId: randomUUID(), taskId: task })
      .expect(201);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('enforces existing cookie CSRF before a mutation reaches application code', async () => {
    await request(app.getHttpServer())
      .post(`/internal/capture/projects/${project}/work-note-drafts`)
      .set('Cookie', '__Host-session=synthetic-session')
      .send({ operationId: randomUUID(), taskId: task })
      .expect(403);
    expect(create).not.toHaveBeenCalled();
  });
  it('serializes a missing resumable draft as JSON null, allowing the client to create one', async () => {
    await request(app.getHttpServer())
      .get(
        `/internal/capture/projects/${project}/work-note-drafts?taskId=${task}`,
      )
      .set('authorization', 'Bearer synthetic-session')
      .expect(200)
      .expect('Content-Type', /json/)
      .expect('null');
  });
});
