import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  type INestApplication,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { WorkNoteAssessmentController } from './work-note-assessment.controller';
import { WorkNoteAssessmentService } from '../application/work-note-agent/work-note-assessment.service';
import { GatewayCaptureController } from '../../../gateway/gateway-capture.controller';
import type { CaptureRequestHeaders } from '../application/work-notes.types';

describe('Assessment Gateway → Capture HTTP boundary (explicit application authority fixture)', () => {
  let capture: INestApplication<Server>, gateway: INestApplication<Server>;
  const project = '651a2b3c4d5e6f7a8b9c0d21',
    organization = '651a2b3c4d5e6f7a8b9c0d22',
    draft = randomUUID(),
    assessment = randomUUID();
  const prefix = `/api/v1/capture/projects/${project}/work-note-drafts/${draft}/agent/assessments`;
  const mutation = () => ({
    operationId: randomUUID(),
    expectedRevision: 2,
    expectedAssessmentRevision: 3,
  });
  const bodies = {
    assess: () => ({
      operationId: randomUUID(),
      expectedRevision: 2,
      purpose: 'PROGRESS',
    }),
    reply: () => ({
      ...mutation(),
      gapId: 'gap-result',
      questionId: randomUUID(),
      disposition: 'answered',
      answer: 'Not tested.',
    }),
    rewrite: mutation,
    correct: () => ({
      ...mutation(),
      targetClaimOrGapId: 'claim-result',
      correctionText: 'Not deployed.',
    }),
    reset: () => ({ ...mutation(), newPurpose: 'QA', carryAnswerIds: [] }),
    validate: mutation,
    feedback: () => ({ ...mutation(), category: 'FALSE_SUFFICIENT' }),
  };
  const routes = [
    { key: 'assess', path: '', method: 'assess' },
    { key: 'reply', path: '/replies', method: 'reply' },
    { key: 'rewrite', path: '/rewrite', method: 'rewriteAssessment' },
    { key: 'correct', path: '/corrections', method: 'correct' },
    { key: 'reset', path: '/reset', method: 'resetAssessment' },
    { key: 'validate', path: '/validate-author', method: 'validateAuthor' },
    { key: 'feedback', path: '/feedback', method: 'feedback' },
  ] as const;
  // This fixture makes transport-visible auth decisions explicit. Real IAM and
  // persisted ownership are covered by the application integration suites.
  const service = Object.fromEntries(
    routes.map((route) => [
      route.method,
      jest.fn((headers: CaptureRequestHeaders, p: string) => {
        if (
          headers.authorization !== 'Bearer synthetic-session' &&
          !headers.cookie?.includes('__Host-session=synthetic-session')
        )
          throw new UnauthorizedException({ code: 'UNAUTHORIZED' });
        if (headers.organizationId && headers.organizationId !== organization)
          throw new ForbiddenException({ code: 'PROJECT_ACCESS_DENIED' });
        if (p !== project)
          throw new NotFoundException({ code: 'PROJECT_NOT_FOUND' });
        return Promise.resolve({
          id: assessment,
          route: route.key,
          authorValidated: route.key === 'validate',
          reviewerSemanticAssessment: 'NOT_ESTABLISHED',
        });
      }),
    ]),
  ) as Record<(typeof routes)[number]['method'], jest.Mock>;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WorkNoteAssessmentController],
      providers: [{ provide: WorkNoteAssessmentService, useValue: service }],
    }).compile();
    capture = module.createNestApplication<INestApplication<Server>>();
    capture.setGlobalPrefix('internal');
    await capture.listen(0, '127.0.0.1');
    const gatewayModule = await Test.createTestingModule({
      controllers: [GatewayCaptureController],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({
            CAPTURE_SERVICE_URL: await capture.getUrl(),
            BACKEND_TIMEOUT_MS: 1000,
            CAPTURE_FILE_TIMEOUT_MS: 1000,
          }),
        },
      ],
    }).compile();
    gateway = gatewayModule.createNestApplication<INestApplication<Server>>();
    gateway.setGlobalPrefix('api/v1');
    await gateway.init();
  });
  afterAll(async () => {
    await gateway?.close();
    await capture?.close();
  });
  beforeEach(() => {
    for (const fn of Object.values(service)) fn.mockClear();
  });

  it.each(routes)(
    'forwards $key with private caching and owned mutation metadata',
    async (route) => {
      const body = bodies[route.key]();
      const response = await request(gateway.getHttpServer())
        .post(prefix + (route.path ? `/${assessment}${route.path}` : ''))
        .set('Authorization', 'Bearer synthetic-session')
        .set('X-Organization-Id', organization)
        .set('X-Request-Id', 'synthetic-request-id')
        .send(body)
        .expect(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).toEqual(
        expect.objectContaining({
          route: route.key,
          reviewerSemanticAssessment: 'NOT_ESTABLISHED',
        }),
      );
      expect(service[route.method]).toHaveBeenCalledTimes(1);
      const called = service[route.method].mock.calls[0] as unknown[];
      expect(called[0]).toMatchObject({
        authorization: 'Bearer synthetic-session',
        organizationId: organization,
        requestId: 'synthetic-request-id',
      });
      expect(called.slice(1)).toEqual([
        project,
        draft,
        ...(route.path ? [assessment] : []),
        body,
      ]);
    },
  );

  it.each(routes)(
    'rejects cookie CSRF for $key before application code',
    async (route) => {
      await request(gateway.getHttpServer())
        .post(prefix + (route.path ? `/${assessment}${route.path}` : ''))
        .set('Cookie', '__Host-session=synthetic-session')
        .send(bodies[route.key]())
        .expect(403)
        .expect('Cache-Control', 'private, no-store');
      expect(service[route.method]).not.toHaveBeenCalled();
    },
  );

  it('accepts the matching cookie CSRF pair and forwards the session without making it body authority', async () => {
    await request(gateway.getHttpServer())
      .post(prefix)
      .set(
        'Cookie',
        '__Host-session=synthetic-session; __Host-csrf=synthetic-csrf',
      )
      .set('X-CSRF-Token', 'synthetic-csrf')
      .send(bodies.assess())
      .expect(200);
    expect(service.assess).toHaveBeenCalledWith(
      expect.objectContaining({
        cookie: '__Host-session=synthetic-session; __Host-csrf=synthetic-csrf',
        csrfToken: 'synthetic-csrf',
      }),
      project,
      draft,
      expect.any(Object),
    );
  });

  it('relays unauthorized, organization-denied and cross-Project errors with private caching', async () => {
    await request(gateway.getHttpServer())
      .post(prefix)
      .send(bodies.assess())
      .expect(401)
      .expect('Cache-Control', 'private, no-store');
    await request(gateway.getHttpServer())
      .post(prefix)
      .set('Authorization', 'Bearer synthetic-session')
      .set('X-Organization-Id', '651a2b3c4d5e6f7a8b9c0d99')
      .send(bodies.assess())
      .expect(403);
    await request(gateway.getHttpServer())
      .post(prefix.replace(project, '651a2b3c4d5e6f7a8b9c0d88'))
      .set('Authorization', 'Bearer synthetic-session')
      .send(bodies.assess())
      .expect(404);
  });

  it('rejects forged model/Task authority, malformed path IDs and unsupported actions', async () => {
    await request(gateway.getHttpServer())
      .post(prefix)
      .set('Authorization', 'Bearer synthetic-session')
      .send({
        ...bodies.assess(),
        task: { title: 'forged' },
        model: 'untrusted/model',
      })
      .expect(422);
    await request(gateway.getHttpServer())
      .post(prefix.replace(draft, 'not-a-uuid'))
      .set('Authorization', 'Bearer synthetic-session')
      .send(bodies.assess())
      .expect(422);
    await request(gateway.getHttpServer())
      .post(`${prefix}/not-a-uuid/rewrite`)
      .set('Authorization', 'Bearer synthetic-session')
      .send(mutation())
      .expect(422);
    await request(gateway.getHttpServer())
      .post(`${prefix}/${assessment}/delete-everything`)
      .set('Authorization', 'Bearer synthetic-session')
      .send(mutation())
      .expect(404);
    expect(
      Object.values(service).every((fn) => fn.mock.calls.length === 0),
    ).toBe(true);
  });

  it('returns 422 rather than 500 for non-string enum objects in JSON', async () => {
    await request(gateway.getHttpServer())
      .post(`${prefix}/${assessment}/replies`)
      .set('Authorization', 'Bearer synthetic-session')
      .send({ ...bodies.reply(), disposition: { toString: 'answered' } })
      .expect(422);
    await request(gateway.getHttpServer())
      .post(`${prefix}/${assessment}/feedback`)
      .set('Authorization', 'Bearer synthetic-session')
      .send({
        ...bodies.feedback(),
        category: { toString: 'FALSE_SUFFICIENT' },
      })
      .expect(422);
    expect(service.reply).not.toHaveBeenCalled();
    expect(service.feedback).not.toHaveBeenCalled();
  });
});
