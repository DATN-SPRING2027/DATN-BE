import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { resolveExpectedOrganizationHeader } from '../../common/http/organization-header';
import { CsrfGuard } from '../../common/security/csrf';
import { AuthenticationApplicationService } from '../../services/iam/application/authentication/authentication.application.service';
import {
  IamActorContextService,
  type IamProjectActorContext,
} from '../../services/iam/application/projects/iam-actor-context.service';
import { AI_ENGINE_CLIENT } from './ai-engine.port';
import type { AiEngineClient } from './ai-engine.port';

const SAFE_RESOLUTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ALLOWED_CONFLICT_LIST_QUERY_KEYS = new Set([
  'status',
  'conflict_subtype',
  'document_id',
  'include_inactive',
  'limit',
  'offset',
]);

@Controller('ai-engine/projects/:projectId/conflicts')
export class AiConflictsController {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    @Inject(AI_ENGINE_CLIENT) private readonly aiEngine: AiEngineClient,
    @Optional() private readonly actorContext?: IamActorContextService,
  ) {}

  private async resolveActiveProjectScope(
    authorization: string | undefined,
    cookie: string | undefined,
    request: Request,
    projectId: string,
  ): Promise<IamProjectActorContext> {
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    if (!this.actorContext) {
      throw new ServiceUnavailableException({
        code: 'IAM_SCOPE_UNAVAILABLE',
        message: 'Project membership verification is temporarily unavailable.',
      });
    }
    const organizationHeader = resolveExpectedOrganizationHeader(
      request?.headers ?? {},
    );
    const scope = await this.actorContext.resolveProjectActorContext({
      actor,
      projectId,
      organizationHeader,
      requireActiveProject: true,
    });
    if (!scope.isProjectMember || scope.project.status !== 'ACTIVE') {
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      });
    }
    return scope;
  }

  private assertResolutionId(resolutionId: string): void {
    if (!SAFE_RESOLUTION_ID_RE.test(resolutionId)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Invalid resolutionId format.',
      });
    }
  }

  private buildScopeHeaders(
    scope: IamProjectActorContext,
    includeReviewerAuthority: boolean,
  ): Record<string, string> {
    const base: Record<string, string> = {
      'X-Continuum-User-Id': scope.actor.id,
      'X-Continuum-Organization-Id': scope.project.organizationId,
      'X-Continuum-Tenant-Id': scope.project.organizationId,
      'X-Continuum-Project-Id': scope.project.id,
      'X-Continuum-Security-Partition': scope.project.id,
    };
    if (includeReviewerAuthority) {
      base['X-Continuum-Role'] = scope.isLeader ? 'LEADER' : 'ADMIN';
      base['X-Continuum-Capabilities'] = 'conflict.resolve,knowledge.verify';
    }
    return base;
  }

  private assertReviewerAuthority(scope: IamProjectActorContext): void {
    if (!scope.canReview) {
      throw new ForbiddenException({
        code: 'CONFLICT_REVIEW_FORBIDDEN',
        message:
          'Only an active Project Leader or Organization Manager can resolve or reopen knowledge conflicts.',
      });
    }
  }

  @Get()
  async listConflicts(
    @Param('projectId') projectId: string,
    @Query() query: Record<string, unknown>,
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const scope = await this.resolveActiveProjectScope(
      authorization,
      cookie,
      request,
      projectId,
    );
    const params = new URLSearchParams();
    for (const [key, rawValue] of Object.entries(query ?? {})) {
      if (!ALLOWED_CONFLICT_LIST_QUERY_KEYS.has(key)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: `Unsupported query parameter: ${key}`,
        });
      }
      if (Array.isArray(rawValue)) {
        for (const item of rawValue) {
          if (typeof item === 'string' && item.trim()) {
            params.append(key, item.trim());
          }
        }
      } else if (typeof rawValue === 'string' && rawValue.trim()) {
        params.append(key, rawValue.trim());
      }
    }
    const qs = params.toString() ? `?${params.toString()}` : '';
    const result = await this.aiEngine.request({
      path: `/api/v1/projects/${encodeURIComponent(scope.project.id)}/conflicts${qs}`,
      method: 'GET',
      headers: this.buildScopeHeaders(scope, false),
    });
    response.status(result.status);
    return result.body;
  }

  @Post(':resolutionId/resolve')
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  async resolveConflict(
    @Param('projectId') projectId: string,
    @Param('resolutionId') resolutionId: string,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.assertResolutionId(resolutionId);
    const scope = await this.resolveActiveProjectScope(
      authorization,
      cookie,
      request,
      projectId,
    );
    this.assertReviewerAuthority(scope);
    const result = await this.aiEngine.request({
      path: `/api/v1/projects/${encodeURIComponent(scope.project.id)}/conflicts/${encodeURIComponent(resolutionId)}/resolve`,
      method: 'POST',
      headers: this.buildScopeHeaders(scope, true),
      body: body ?? {},
    });
    response.status(result.status);
    return result.body;
  }

  @Post(':resolutionId/reopen')
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  async reopenConflict(
    @Param('projectId') projectId: string,
    @Param('resolutionId') resolutionId: string,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.assertResolutionId(resolutionId);
    const scope = await this.resolveActiveProjectScope(
      authorization,
      cookie,
      request,
      projectId,
    );
    this.assertReviewerAuthority(scope);
    const result = await this.aiEngine.request({
      path: `/api/v1/projects/${encodeURIComponent(scope.project.id)}/conflicts/${encodeURIComponent(resolutionId)}/reopen`,
      method: 'POST',
      headers: this.buildScopeHeaders(scope, true),
      body: body ?? {},
    });
    response.status(result.status);
    return result.body;
  }
}
