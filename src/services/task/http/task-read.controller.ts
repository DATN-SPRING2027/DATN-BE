import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Req,
  UnprocessableEntityException,
  UseFilters,
  UseGuards,
  UsePipes,
  ValidationPipe,
  type ValidationError,
} from '@nestjs/common';
import {
  RequireTaskAuthorization,
  TaskAuthorizationHttpGuard,
  getTaskAuthorizedRequestContext,
} from '../runtime/task-authorization-http.guard';
import { taskAuthorizationUnavailableException } from '../runtime/task-authorization-http.errors';
import { ListTasksQueryDto } from './list-tasks-query.dto';
import { TaskHttpExceptionFilter } from './task-http-exception.filter';
import { TaskReadService } from './task-read.service';
import type { TaskPageResponse, TaskResponse } from './task-response';

/**
 * Only limit and afterId are validated, and only after authorization (guards
 * run before pipes). Unknown query parameters are ignored: the slice has no
 * filter, sort, page or total.
 */
const taskQueryValidationPipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  exceptionFactory: (errors: ValidationError[]) =>
    new UnprocessableEntityException({
      code: 'TASK_VALIDATION_FAILED',
      message: errors.flatMap((error) =>
        Object.values(error.constraints ?? {}),
      ),
    }),
});

function authorizedProjectId(request: unknown): string {
  const context = getTaskAuthorizedRequestContext(request);
  if (!context) throw taskAuthorizationUnavailableException();
  return context.projectId;
}

/**
 * DATN-97 seven-field slice, list and detail only. Registered by the isolated
 * Task module only when the explicit routes flag is on; every request passes
 * the default deny-by-default authorization boundary.
 */
@Controller('tasks/projects/:projectId/tasks')
@UseFilters(TaskHttpExceptionFilter)
@UseGuards(TaskAuthorizationHttpGuard)
export class TaskReadController {
  constructor(private readonly tasks: TaskReadService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @RequireTaskAuthorization({ operation: 'list', projectIdParam: 'projectId' })
  @UsePipes(taskQueryValidationPipe)
  list(
    @Req() request: unknown,
    @Query() query: ListTasksQueryDto,
  ): Promise<TaskPageResponse> {
    return this.tasks.list(authorizedProjectId(request), query);
  }

  @Get(':taskId')
  @Header('Cache-Control', 'no-store')
  @RequireTaskAuthorization({
    operation: 'detail',
    projectIdParam: 'projectId',
    resourceIdParam: 'taskId',
  })
  detail(
    @Req() request: unknown,
    @Param('taskId') taskId: string,
  ): Promise<TaskResponse> {
    return this.tasks.detail(authorizedProjectId(request), taskId);
  }
}
