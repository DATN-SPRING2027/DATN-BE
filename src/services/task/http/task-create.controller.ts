import {
  Body,
  Controller,
  Header,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  RequireTaskAuthorization,
  TaskAuthorizationHttpGuard,
  getTaskAuthorizedRequestContext,
} from '../runtime/task-authorization-http.guard';
import { taskAuthorizationUnavailableException } from '../runtime/task-authorization-http.errors';
import { TaskHttpExceptionFilter } from './task-http-exception.filter';
import { TaskCreateService } from './task-create.service';
import type { TaskResponse } from './task-response';

/**
 * DATN-97 create (proposed contract task-v1-d05-create.openapi.json). Registered
 * by the isolated Task module only when both the routes flag and the create
 * flag are on; every request passes the deny-by-default authorization boundary
 * before the body is validated. There is no Idempotency-Key (DR7C-1).
 */
@Controller('tasks/projects/:projectId/tasks')
@UseFilters(TaskHttpExceptionFilter)
@UseGuards(TaskAuthorizationHttpGuard)
export class TaskCreateController {
  constructor(private readonly tasks: TaskCreateService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @RequireTaskAuthorization({
    operation: 'create',
    projectIdParam: 'projectId',
  })
  async create(
    @Req() request: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TaskResponse> {
    const context = getTaskAuthorizedRequestContext(request);
    if (!context) throw taskAuthorizationUnavailableException();

    const task = await this.tasks.create(
      {
        projectId: context.projectId,
        actorUserId: context.actorUserId,
        requestId: context.requestId,
      },
      body,
    );
    response.setHeader(
      'Location',
      `/internal/tasks/projects/${task.projectId}/tasks/${task.id}`,
    );
    return task;
  }
}
