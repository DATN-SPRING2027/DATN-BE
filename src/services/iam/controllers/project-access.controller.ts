import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import { ProjectAccessAuthorizationGuard } from '../application/authorization/project-access-authorization.guard';
import { RequireProjectAccessPermission } from '../application/authorization/project-access-permission.decorator';
import { ProjectAccessService } from '../application/projects/project-access.service';
import type {
  ProjectMembershipListQuery,
  ProjectSettingsUpdateInput,
} from '../application/projects/project-access.repository';

const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);

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

function membershipListQuery(
  query: Record<string, unknown>,
): ProjectMembershipListQuery {
  if (
    query.status !== undefined &&
    (typeof query.status !== 'string' ||
      !['ACTIVE', 'INACTIVE'].includes(query.status))
  )
    invalid();
  return {
    page: positiveInteger(query.page, 1),
    pageSize: positiveInteger(query.pageSize, 20, 100),
    ...(query.status === undefined
      ? {}
      : { status: query.status as 'ACTIVE' | 'INACTIVE' }),
  };
}

function userIdFromBody(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return invalid();
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== 'userId') ||
    !validId(record.userId)
  )
    return invalid();
  return record.userId;
}

function addMemberFromBody(body: unknown): {
  userId: string;
  role?: 'MEMBER' | 'TEAM_LEADER';
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return invalid();
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== 'userId' && key !== 'role' && key !== 'roleCode',
    ) ||
    !validId(record.userId)
  )
    return invalid();
  const roleValue = record.role ?? record.roleCode;
  if (
    roleValue !== undefined &&
    roleValue !== 'MEMBER' &&
    roleValue !== 'TEAM_LEADER'
  )
    return invalid();
  return {
    userId: record.userId,
    ...(roleValue ? { role: roleValue } : {}),
  };
}

function leaderChangeFromBody(body: unknown): {
  previousUserId: string;
  nextUserId: string;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return invalid();
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== 'previousUserId' && key !== 'nextUserId',
    ) ||
    !validId(record.previousUserId) ||
    !validId(record.nextUserId) ||
    record.previousUserId === record.nextUserId
  )
    return invalid();
  return {
    previousUserId: record.previousUserId,
    nextUserId: record.nextUserId,
  };
}

function projectSettingsUpdateFromBody(
  body: unknown,
): ProjectSettingsUpdateInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return invalid();
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length === 0 ||
    keys.some((key) => key !== 'name' && key !== 'description')
  )
    return invalid();

  const input: { name?: string; description?: string | null } = {};
  if ('name' in record) {
    if (
      typeof record.name !== 'string' ||
      record.name.trim().length < 1 ||
      record.name.trim().length > 200
    )
      return invalid();
    input.name = record.name.trim();
  }
  if ('description' in record) {
    if (
      record.description !== null &&
      (typeof record.description !== 'string' ||
        record.description.length > 2000)
    )
      return invalid();
    input.description = record.description;
  }
  return input;
}

function leaderCandidateSearch(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 254) return invalid();
  const search = value.trim();
  return search.length > 0 ? search : undefined;
}

@Controller('iam/projects/:projectId')
export class ProjectAccessController {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly access: ProjectAccessService,
  ) {}

  @Get('settings-access')
  @RequireProjectAccessPermission('project.update')
  @UseGuards(ProjectAccessAuthorizationGuard)
  getSettingsAccess(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return { canUpdateProject: true };
  }

  @Patch()
  @RequireProjectAccessPermission('project.update')
  @UseGuards(ProjectAccessAuthorizationGuard)
  async updateSettings(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    return this.access.updateSettings(
      actor,
      projectId,
      projectSettingsUpdateFromBody(body),
    );
  }

  @Get('visibility')
  @RequireProjectAccessPermission('project.visibility.manage')
  @UseGuards(ProjectAccessAuthorizationGuard)
  getVisibilityAccess(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return { canManageVisibility: true };
  }

  @Patch('visibility')
  @RequireProjectAccessPermission('project.visibility.manage')
  @UseGuards(ProjectAccessAuthorizationGuard)
  async changeVisibility(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
  ) {
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !['PRIVATE', 'PUBLIC'].includes(
        (body as Record<string, unknown>).visibility as string,
      )
    )
      invalid();
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    return this.access.changeVisibility(
      actor,
      projectId,
      (body as { visibility: 'PRIVATE' | 'PUBLIC' }).visibility,
    );
  }

  @Get('memberships')
  @RequireProjectAccessPermission('project.members.list')
  @UseGuards(ProjectAccessAuthorizationGuard)
  async listMembers(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    return this.access.listMembers(
      actor,
      projectId,
      membershipListQuery(query),
    );
  }

  @Get('leaders')
  @RequireProjectAccessPermission('project.leader.manage')
  @UseGuards(ProjectAccessAuthorizationGuard)
  async listLeaders(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    return this.access.listLeaders(actor, projectId);
  }

  @Get('leader-candidates')
  @RequireProjectAccessPermission('project.leader.manage')
  @UseGuards(ProjectAccessAuthorizationGuard)
  async listLeaderCandidates(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Query('email') emailQuery: unknown,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    return this.access.listLeaderCandidates(
      actor,
      projectId,
      leaderCandidateSearch(emailQuery),
    );
  }

  @Get('member-candidates')
  @RequireProjectAccessPermission('project.members.add')
  @UseGuards(ProjectAccessAuthorizationGuard)
  async listMemberCandidates(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Query('email') emailQuery: string | undefined,
    @Query('search') searchQuery: string | undefined,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    const search = emailQuery || searchQuery;
    return this.access.listMemberCandidates(
      actor,
      projectId,
      typeof search === 'string' ? search.trim() : undefined,
    );
  }

  @Post('memberships')
  @RequireProjectAccessPermission('project.members.add')
  @UseGuards(ProjectAccessAuthorizationGuard)
  async addMember(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    const input = addMemberFromBody(body);
    return input.role
      ? this.access.addMember(actor, projectId, input.userId, input.role)
      : this.access.addMember(actor, projectId, input.userId);
  }

  @Delete('memberships/:membershipId')
  @HttpCode(204)
  @RequireProjectAccessPermission('project.members.remove')
  @UseGuards(ProjectAccessAuthorizationGuard)
  async removeMember(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('projectId') projectId: string,
    @Param('membershipId') membershipId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    await this.access.removeMember(actor, projectId, membershipId);
  }

  @Post('leaders')
  @HttpCode(204)
  @RequireProjectAccessPermission('project.leader.manage')
  @UseGuards(ProjectAccessAuthorizationGuard)
  async assignLeader(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Body() body: unknown,
    @Param('projectId') projectId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    await this.access.assignLeader(actor, projectId, userIdFromBody(body));
  }

  @Put('leaders')
  @HttpCode(204)
  @RequireProjectAccessPermission('project.leader.manage')
  @UseGuards(ProjectAccessAuthorizationGuard)
  async changeLeader(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Body() body: unknown,
    @Param('projectId') projectId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    const input = leaderChangeFromBody(body);
    await this.access.changeLeader(
      actor,
      projectId,
      input.previousUserId,
      input.nextUserId,
    );
  }

  @Delete('leaders/:userId')
  @HttpCode(204)
  @RequireProjectAccessPermission('project.leader.manage')
  @UseGuards(ProjectAccessAuthorizationGuard)
  async revokeLeader(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    if (!validId(userId)) invalid();
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    await this.access.revokeLeader(actor, projectId, userId);
  }
}
