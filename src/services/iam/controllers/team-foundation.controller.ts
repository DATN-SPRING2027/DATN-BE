import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import {
  readCookie,
  validCsrfPair,
} from '../application/authentication/authentication.application.service';
import { isTeamId } from '../application/teams/team-contract';
import {
  parseTeamCreateInput,
  parseTeamLifecycleInput,
  parseTeamListQuery,
  parseTeamUpdateInput,
} from '../application/teams/team-contract';
import { TeamService } from '../application/teams/team.service';
import type {
  TeamCommandResult,
  TeamRecord,
} from '../application/teams/team.repository';

function projectNotFound(): never {
  throw new NotFoundException({
    code: 'PROJECT_NOT_FOUND',
    message: 'Project not found.',
  });
}

function teamNotFound(): never {
  throw new NotFoundException({
    code: 'TEAM_NOT_FOUND',
    message: 'Team not found.',
  });
}

function assertTrustedOrganization(
  trustedOrganizationId: string,
  headerOrganizationId: string | undefined,
  resource: 'PROJECT' | 'TEAM',
): void {
  if (
    headerOrganizationId !== undefined &&
    headerOrganizationId.toLowerCase() !== trustedOrganizationId.toLowerCase()
  ) {
    if (resource === 'PROJECT') projectNotFound();
    teamNotFound();
  }
}

function rejectQuery(query: Record<string, unknown>): void {
  if (Object.keys(query).length > 0)
    throw new UnprocessableEntityException({
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed.',
    });
}

function setCommandResponse(
  response: Response,
  result: TeamCommandResult,
): TeamRecord {
  response.status(result.statusCode);
  response.setHeader('ETag', result.etag);
  if (result.location) response.setHeader('Location', result.location);
  if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
  return result.team;
}

@Controller('iam')
export class TeamFoundationController {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly teams: TeamService,
  ) {}

  @Post('projects/:projectId/teams')
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('x-organization-id') headerOrganizationId: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TeamRecord> {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    this.requireCsrf(cookie, csrfHeader);
    if (!isTeamId(projectId)) projectNotFound();
    assertTrustedOrganization(
      actor.organizationId,
      headerOrganizationId,
      'PROJECT',
    );
    const input = parseTeamCreateInput(body);
    return setCommandResponse(
      response,
      await this.teams.create(actor, projectId, input, idempotencyKey),
    );
  }

  @Patch('teams/:teamId')
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('x-organization-id') headerOrganizationId: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Param('teamId') teamId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TeamRecord> {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    this.requireCsrf(cookie, csrfHeader);
    if (!isTeamId(teamId)) teamNotFound();
    assertTrustedOrganization(
      actor.organizationId,
      headerOrganizationId,
      'TEAM',
    );
    const input = parseTeamUpdateInput(body);
    return setCommandResponse(
      response,
      await this.teams.update(actor, teamId, input, idempotencyKey, ifMatch),
    );
  }

  @Get('projects/:projectId/teams')
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-organization-id') headerOrganizationId: string | undefined,
    @Param('projectId') projectId: string,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    if (!isTeamId(projectId)) projectNotFound();
    assertTrustedOrganization(
      actor.organizationId,
      headerOrganizationId,
      'PROJECT',
    );
    const result = await this.teams.list(
      actor,
      projectId,
      parseTeamListQuery(query),
    );
    response.status(200);
    response.type('application/json');
    response.end(JSON.stringify(result));
  }

  @Get('teams/:teamId')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-organization-id') headerOrganizationId: string | undefined,
    @Param('teamId') teamId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TeamRecord> {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    if (!isTeamId(teamId)) teamNotFound();
    assertTrustedOrganization(
      actor.organizationId,
      headerOrganizationId,
      'TEAM',
    );
    rejectQuery(query);
    const team = await this.teams.get(actor, teamId);
    response.setHeader('ETag', `"team:${team.id}:${team.version}"`);
    return team;
  }

  @Post('teams/:teamId/archive')
  async archive(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('x-organization-id') headerOrganizationId: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Param('teamId') teamId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TeamRecord> {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    this.requireCsrf(cookie, csrfHeader);
    if (!isTeamId(teamId)) teamNotFound();
    assertTrustedOrganization(
      actor.organizationId,
      headerOrganizationId,
      'TEAM',
    );
    const input = parseTeamLifecycleInput(body);
    return setCommandResponse(
      response,
      await this.teams.archive(actor, teamId, input, idempotencyKey, ifMatch),
    );
  }

  @Post('teams/:teamId/restore')
  async restore(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('x-organization-id') headerOrganizationId: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Param('teamId') teamId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TeamRecord> {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    this.requireCsrf(cookie, csrfHeader);
    if (!isTeamId(teamId)) teamNotFound();
    assertTrustedOrganization(
      actor.organizationId,
      headerOrganizationId,
      'TEAM',
    );
    const input = parseTeamLifecycleInput(body);
    return setCommandResponse(
      response,
      await this.teams.restore(actor, teamId, input, idempotencyKey, ifMatch),
    );
  }

  private requireCsrf(
    cookie: string | undefined,
    header: string | undefined,
  ): void {
    if (!validCsrfPair(readCookie(cookie, '__Host-csrf'), header))
      throw new ForbiddenException({
        code: 'AUTH_CSRF_INVALID',
        message: 'CSRF validation failed.',
      });
  }
}
