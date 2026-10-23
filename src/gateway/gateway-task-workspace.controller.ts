import {
  Controller,
  GatewayTimeoutException,
  Get,
  Patch,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

const requestHeaders = [
  'accept',
  'authorization',
  'content-type',
  'cookie',
  'idempotency-key',
  'if-match',
  'x-csrf-token',
  'x-organization-id',
  'x-request-id',
] as const;

const responseHeaders = [
  'cache-control',
  'content-type',
  'etag',
  'idempotency-replayed',
  'location',
  'retry-after',
  'www-authenticate',
  'x-request-id',
] as const;

@Controller()
export class GatewayTaskWorkspaceController {
  constructor(private readonly config: ConfigService) {}

  @Get('tasks/projects/:projectId/tasks')
  listProjectTasks(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('tasks/projects/:projectId/tasks')
  createProjectTask(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('tasks/projects/:projectId/tasks/:taskId')
  getProjectTask(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Patch('tasks/projects/:projectId/tasks/:taskId')
  updateProjectTask(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('tasks/projects/:projectId/tasks/:taskId/transitions')
  transitionProjectTask(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('tasks/projects/:projectId/tasks/:taskId/history')
  listTaskHistory(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('tasks/projects/:projectId/tasks/:taskId/comments')
  listTaskComments(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('tasks/projects/:projectId/tasks/:taskId/comments')
  createTaskComment(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('tasks/projects/:projectId/tasks/:taskId/worklogs')
  listTaskWorklogs(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('tasks/projects/:projectId/tasks/:taskId/worklogs')
  createTaskWorklog(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('tasks/projects/:projectId/sprints')
  listProjectSprints(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('tasks/projects/:projectId/sprints')
  createProjectSprint(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Patch('tasks/projects/:projectId/sprints/:sprintId')
  updateProjectSprint(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('tasks/projects/:projectId/sprints/:sprintId/complete')
  completeProjectSprint(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('tasks/projects/:projectId/task-summary')
  getProjectTaskSummary(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('tasks/organization/tasks')
  listOrganizationTasks(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('tasks/organization/task-summary')
  getOrganizationTaskSummary(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return this.forward(request, response);
  }

  private async forward(request: Request, response: Response): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    const baseUrl =
      (typeof this.config.get === 'function'
        ? this.config.get<string>('TASK_SERVICE_URL')
        : undefined) ?? this.config.getOrThrow<string>('IAM_SERVICE_URL');
    const path = request.originalUrl.replace(/^\/api\/v1\//, '/internal/');
    const headers: Record<string, string> = {};
    for (const name of requestHeaders) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(new URL(path, baseUrl), {
        method: request.method,
        headers,
        ...(request.method === 'GET' || request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(
          this.config.getOrThrow<number>('BACKEND_TIMEOUT_MS'),
        ),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new GatewayTimeoutException('Task service timed out');
      }
      throw new ServiceUnavailableException('Task service unavailable');
    }

    for (const name of responseHeaders) {
      const value = upstream.headers.get(name);
      if (value) response.setHeader(name, value);
    }
    response
      .status(upstream.status)
      .send(Buffer.from(await upstream.arrayBuffer()));
  }
}
