import {
  BadRequestException,
  Body,
  Controller,
  INestApplication,
  Post,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { requestIdMiddleware } from '../../../common/http/request-id.middleware';
import { TaskHttpExceptionFilter } from './task-http-exception.filter';

@Controller('filter-test')
class FilterTestController {
  @Post('controlled-bad-request')
  controlledBadRequest(): never {
    throw new BadRequestException({
      code: 'TASK_INPUT_REJECTED',
      message: 'The supplied Task input is not accepted',
    });
  }

  @Post('json')
  json(@Body() body: unknown): unknown {
    return body;
  }
}

describe('TaskHttpExceptionFilter', () => {
  let app: INestApplication | undefined;
  let http: App;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FilterTestController],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.use(requestIdMiddleware);
    app.useGlobalFilters(new TaskHttpExceptionFilter());
    await app.init();
    http = app.getHttpServer() as App;
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('keeps an application BadRequestException as its original 400 response', async () => {
    const response = await request(http)
      .post('/filter-test/controlled-bad-request')
      .set('x-request-id', 'req-filter-test')
      .send({ title: 'Task' });

    expect(response.status).toBe(400);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      code: 'TASK_INPUT_REJECTED',
      message: 'The supplied Task input is not accepted',
      details: {},
      requestId: 'req-filter-test',
    });
  });

  it('maps malformed JSON from the Express parser to the Task validation response', async () => {
    const response = await request(http)
      .post('/filter-test/json')
      .set('Content-Type', 'application/json')
      .set('x-request-id', 'req-filter-test')
      .send('{"title": ');

    expect(response.status).toBe(422);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      code: 'TASK_VALIDATION_FAILED',
      message: 'Request validation failed',
      details: { messages: ['the body is not valid JSON'] },
      requestId: 'req-filter-test',
    });
    expect(JSON.stringify(response.body)).not.toContain('Unexpected token');
  });
});
