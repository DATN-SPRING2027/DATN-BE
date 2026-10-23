import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  TaskWorkspaceService,
  type WorkspaceHttpResult,
} from './task-workspace.service';

@Controller(['tasks', 'internal/tasks'])
export class TaskWorkspaceController {
  constructor(private readonly service: TaskWorkspaceService) {}

  private applyHeadersAndStatus<T>(
    res: Response,
    result: WorkspaceHttpResult<T>,
  ): T {
    if (result.etag) {
      res.setHeader('ETag', result.etag);
    }
    if (result.location) {
      res.setHeader('Location', result.location);
    }
    if (result.replayed) {
      res.setHeader('Idempotency-Replayed', 'true');
    }
    res.status(result.statusCode);
    return result.body;
  }

  private header(req: Request, name: string): string | undefined {
    const val = req.headers[name.toLowerCase()];
    if (Array.isArray(val)) return val[0];
    return typeof val === 'string' ? val : undefined;
  }

  @Get('projects/:projectId/tasks')
  async listProjectTasks(
    @Param('projectId') projectId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.listProjectTasks({
      authorizationHeader: this.header(req, 'authorization'),
      cookieHeader: this.header(req, 'cookie'),
      headerOrgId: this.header(req, 'x-organization-id'),
      projectId,
      query,
    });
    return this.applyHeadersAndStatus(res, result);
  }

  @Post('projects/:projectId/tasks')
  async createProjectTask(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.createProjectTask({
      authorizationHeader: this.header(req, 'authorization'),
      cookieHeader: this.header(req, 'cookie'),
      csrfHeader: this.header(req, 'x-csrf-token'),
      idempotencyKeyHeader: this.header(req, 'idempotency-key'),
      headerOrgId: this.header(req, 'x-organization-id'),
      correlationId: this.header(req, 'x-request-id'),
      projectId,
      body,
    });
    return this.applyHeadersAndStatus(res, result);
  }

  @Get('projects/:projectId/tasks/:taskId')
  async getProjectTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.getProjectTask({
      authorizationHeader: this.header(req, 'authorization'),
      cookieHeader: this.header(req, 'cookie'),
      headerOrgId: this.header(req, 'x-organization-id'),
      projectId,
      taskId,
    });
    return this.applyHeadersAndStatus(res, result);
  }

  @Patch('projects/:projectId/tasks/:taskId')
  async updateProjectTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.updateProjectTask({
      authorizationHeader: this.header(req, 'authorization'),
      cookieHeader: this.header(req, 'cookie'),
      csrfHeader: this.header(req, 'x-csrf-token'),
      ifMatchHeader: this.header(req, 'if-match'),
      headerOrgId: this.header(req, 'x-organization-id'),
      correlationId: this.header(req, 'x-request-id'),
      projectId,
      taskId,
      body,
    });
    return this.applyHeadersAndStatus(res, result);
  }

  @Post('projects/:projectId/tasks/:taskId/transitions')
  async transitionProjectTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.transitionProjectTask({
      authorizationHeader: this.header(req, 'authorization'),
      cookieHeader: this.header(req, 'cookie'),
      csrfHeader: this.header(req, 'x-csrf-token'),
      ifMatchHeader: this.header(req, 'if-match'),
      idempotencyKeyHeader: this.header(req, 'idempotency-key'),
      headerOrgId: this.header(req, 'x-organization-id'),
      correlationId: this.header(req, 'x-request-id'),
      projectId,
      taskId,
      body,
    });
    return this.applyHeadersAndStatus(res, result);
  }

  @Get('projects/:projectId/tasks/:taskId/history')
  async listTaskHistory(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.listTaskHistory({
      authorizationHeader: this.header(req, 'authorization'),
      cookieHeader: this.header(req, 'cookie'),
      headerOrgId: this.header(req, 'x-organization-id'),
      projectId,
      taskId,
      query,
    });
    return this.applyHeadersAndStatus(res, result);
  }

  @Get('projects/:projectId/tasks/:taskId/comments')
  async listTaskComments(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.listTaskComments({
      authorizationHeader: this.header(req, 'authorization'),
      cookieHeader: this.header(req, 'cookie'),
      headerOrgId: this.header(req, 'x-organization-id'),
      projectId,
      taskId,
      query,
    });
    return this.applyHeadersAndStatus(res, result);
  }

  @Post('projects/:projectId/tasks/:taskId/comments')
  async createTaskComment(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.createTaskComment({
      authorizationHeader: this.header(req, 'authorization'),
      cookieHeader: this.header(req, 'cookie'),
      csrfHeader: this.header(req, 'x-csrf-token'),
      idempotencyKeyHeader: this.header(req, 'idempotency-key'),
      headerOrgId: this.header(req, 'x-organization-id'),
      correlationId: this.header(req, 'x-request-id'),
      projectId,
      taskId,
      body,
    });
    return this.applyHeadersAndStatus(res, result);
  }

  @Get('projects/:projectId/tasks/:taskId/worklogs')
  async listTaskWorklogs(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.listTaskWorklogs({
      authorizationHeader: this.header(req, 'authorization'),
      cookieHeader: this.header(req, 'cookie'),
      headerOrgId: this.header(req, 'x-organization-id'),
      projectId,
      taskId,
      query,
    });
    return this.applyHeadersAndStatus(res, result);
  }

  @Post('projects/:projectId/tasks/:taskId/worklogs')
  async createTaskWorklog(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.createTaskWorklog({
      authorizationHeader: this.header(req, 'authorization'),
      cookieHeader: this.header(req, 'cookie'),
      csrfHeader: this.header(req, 'x-csrf-token'),
      idempotencyKeyHeader: this.header(req, 'idempotency-key'),
      headerOrgId: this.header(req, 'x-organization-id'),
      correlationId: this.header(req, 'x-request-id'),
      projectId,
      taskId,
      body,
    });
    return this.applyHeadersAndStatus(res, result);
  }

  @Get('projects/:projectId/sprints')
  async listProjectSprints(
    @Param('projectId') projectId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.listProjectSprints({
      authorizationHeader: this.header(req, 'authorization'),
      cookieHeader: this.header(req, 'cookie'),
      headerOrgId: this.header(req, 'x-organization-id'),
      projectId,
      query,
    });
    return this.applyHeadersAndStatus(res, result);
  }

  @Post('projects/:projectId/sprints')
  async createProjectSprint(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.createProjectSprint({
      authorizationHeader: this.header(req, 'authorization'),
      cookieHeader: this.header(req, 'cookie'),
      csrfHeader: this.header(req, 'x-csrf-token'),
      idempotencyKeyHeader: this.header(req, 'idempotency-key'),
      headerOrgId: this.header(req, 'x-organization-id'),
      projectId,
      body,
    });
    return this.applyHeadersAndStatus(res, result);
  }

  @Patch('projects/:projectId/sprints/:sprintId')
  async updateProjectSprint(
    @Param('projectId') projectId: string,
    @Param('sprintId') sprintId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.updateProjectSprint({
      authorizationHeader: this.header(req, 'authorization'),
      cookieHeader: this.header(req, 'cookie'),
      csrfHeader: this.header(req, 'x-csrf-token'),
      ifMatchHeader: this.header(req, 'if-match'),
      headerOrgId: this.header(req, 'x-organization-id'),
      projectId,
      sprintId,
      body,
    });
    return this.applyHeadersAndStatus(res, result);
  }

  @Post('projects/:projectId/sprints/:sprintId/complete')
  async completeProjectSprint(
    @Param('projectId') projectId: string,
    @Param('sprintId') sprintId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.completeProjectSprint({
      authorizationHeader: this.header(req, 'authorization'),
      cookieHeader: this.header(req, 'cookie'),
      csrfHeader: this.header(req, 'x-csrf-token'),
      ifMatchHeader: this.header(req, 'if-match'),
      idempotencyKeyHeader: this.header(req, 'idempotency-key'),
      headerOrgId: this.header(req, 'x-organization-id'),
      correlationId: this.header(req, 'x-request-id'),
      projectId,
      sprintId,
      body,
    });
    return this.applyHeadersAndStatus(res, result);
  }

  @Get('projects/:projectId/task-summary')
  async getProjectTaskSummary(
    @Param('projectId') projectId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.getProjectTaskSummary({
      authorizationHeader: this.header(req, 'authorization'),
      cookieHeader: this.header(req, 'cookie'),
      headerOrgId: this.header(req, 'x-organization-id'),
      projectId,
    });
    return this.applyHeadersAndStatus(res, result);
  }

  @Get('organization/tasks')
  async listOrganizationTasks(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.listOrganizationTasks({
      authorizationHeader: this.header(req, 'authorization'),
      cookieHeader: this.header(req, 'cookie'),
      query,
    });
    return this.applyHeadersAndStatus(res, result);
  }

  @Get('organization/task-summary')
  async getOrganizationTaskSummary(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.getOrganizationTaskSummary({
      authorizationHeader: this.header(req, 'authorization'),
      cookieHeader: this.header(req, 'cookie'),
      query,
    });
    return this.applyHeadersAndStatus(res, result);
  }
}
