import {
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import type { AuthenticatedIdentity } from '../application/authentication/authentication.application.service';
import { ProjectService } from '../application/projects/project.service';
import { ProjectCreateAuthorizationGuard } from '../application/authorization/project-create-authorization.guard';
import type {
  ProjectCreateInput,
  ProjectListQuery,
  ProjectStatus,
  ProjectVisibility,
} from '../application/projects/project.repository';

function invalid(): never {
  throw new UnprocessableEntityException({
    code: 'VALIDATION_FAILED',
    message: 'Request validation failed.',
  });
}

function positiveInteger(
  value: unknown,
  fallback: number,
  max?: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (max !== undefined && parsed > max))
    return invalid();
  return parsed;
}

function listQuery(query: Record<string, unknown>): ProjectListQuery {
  const page = positiveInteger(query.page, 1);
  const pageSize = positiveInteger(query.pageSize, 20, 100);
  if (
    query.status !== undefined &&
    (typeof query.status !== 'string' ||
      !['ACTIVE', 'ARCHIVED'].includes(query.status))
  )
    invalid();
  if (
    query.q !== undefined &&
    (typeof query.q !== 'string' ||
      query.q.trim().length < 2 ||
      query.q.trim().length > 80)
  )
    invalid();
  return {
    page,
    pageSize,
    ...(query.status === undefined
      ? {}
      : { status: query.status as ProjectStatus }),
    ...(typeof query.q === 'string' ? { q: query.q.trim() } : {}),
  };
}

function createInput(body: unknown): ProjectCreateInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    invalid();
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        ![
          'name',
          'code',
          'description',
          'visibility',
          'memberUserIds',
          'leaderUserIds',
        ].includes(key),
    )
  )
    invalid();
  if (
    typeof record.name !== 'string' ||
    record.name.trim().length < 1 ||
    record.name.trim().length > 200
  )
    invalid();
  if (
    typeof record.code !== 'string' ||
    !/^[A-Z][A-Z0-9_-]{1,31}$/.test(record.code)
  )
    invalid();
  if (
    record.description !== undefined &&
    (typeof record.description !== 'string' || record.description.length > 2000)
  )
    invalid();
  if (
    record.visibility !== undefined &&
    (typeof record.visibility !== 'string' ||
      !['PRIVATE', 'PUBLIC'].includes(record.visibility))
  )
    invalid();
  if (
    record.memberUserIds !== undefined &&
    (!Array.isArray(record.memberUserIds) ||
      record.memberUserIds.length > 50 ||
      record.memberUserIds.some(
        (id) => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id),
      ))
  )
    invalid();
  if (
    record.leaderUserIds !== undefined &&
    (!Array.isArray(record.leaderUserIds) ||
      record.leaderUserIds.length > 50 ||
      record.leaderUserIds.some(
        (id) => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id),
      ))
  )
    invalid();
  return {
    name: record.name.trim(),
    code: record.code,
    ...(record.description === undefined
      ? {}
      : { description: record.description }),
    ...(record.visibility === undefined
      ? {}
      : { visibility: record.visibility as ProjectVisibility }),
    ...(record.memberUserIds === undefined
      ? {}
      : {
          memberUserIds: [
            ...new Set(
              (record.memberUserIds as string[]).map((id) => id.toLowerCase()),
            ),
          ],
        }),
    ...(record.leaderUserIds === undefined
      ? {}
      : {
          leaderUserIds: [
            ...new Set(
              (record.leaderUserIds as string[]).map((id) => id.toLowerCase()),
            ),
          ],
        }),
  };
}

function assertTrustedOrganization(
  actor: AuthenticatedIdentity,
  headerOrganizationId: string | undefined,
  queryOrganizationId: unknown,
  detail: boolean,
): void {
  if (
    (headerOrganizationId !== undefined &&
      headerOrganizationId !== actor.organizationId) ||
    (queryOrganizationId !== undefined &&
      queryOrganizationId !== actor.organizationId)
  ) {
    if (detail)
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      });
    invalid();
  }
}

@Controller('iam/projects')
export class ProjectController {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly projects: ProjectService,
  ) {}

  @Post()
  @UseGuards(ProjectCreateAuthorizationGuard)
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    return this.projects.create(actor, createInput(body));
  }

  @Get()
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-organization-id') headerOrganizationId: string | undefined,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    assertTrustedOrganization(
      actor,
      headerOrganizationId,
      query.organizationId,
      false,
    );
    return this.projects.list(actor, listQuery(query));
  }

  @Get('member-candidates')
  @UseGuards(ProjectCreateAuthorizationGuard)
  async listMemberCandidates(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-organization-id') headerOrganizationId: string | undefined,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    assertTrustedOrganization(
      actor,
      headerOrganizationId,
      query.organizationId,
      false,
    );
    if (
      query.search !== undefined &&
      (typeof query.search !== 'string' || query.search.length > 200)
    )
      invalid();
    const search =
      typeof query.search === 'string' && query.search.trim().length > 0
        ? query.search.trim()
        : undefined;
    return this.projects.listMemberCandidates(actor, search);
  }

  @Get(':projectId')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-organization-id') headerOrganizationId: string | undefined,
    @Query('organizationId') queryOrganizationId: unknown,
    @Param('projectId') projectId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    assertTrustedOrganization(
      actor,
      headerOrganizationId,
      queryOrganizationId,
      true,
    );
    return this.projects.get(actor, projectId);
  }
}
