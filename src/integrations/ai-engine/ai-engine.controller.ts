import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { resolveExpectedOrganizationHeader } from '../../common/http/organization-header';
import { AuthenticationApplicationService } from '../../services/iam/application/authentication/authentication.application.service';
import { IamActorContextService } from '../../services/iam/application/projects/iam-actor-context.service';
import { ProjectService } from '../../services/iam/application/projects/project.service';
import { AI_ENGINE_CLIENT } from './ai-engine.port';
import type { AiEngineClient } from './ai-engine.port';

@Controller('ai-engine/projects/:projectId/documents')
export class AiEngineController {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly projects: ProjectService,
    @Inject(AI_ENGINE_CLIENT) private readonly aiEngine: AiEngineClient,
    @Optional() private readonly actorContext?: IamActorContextService,
  ) {}

  @Get(':documentId/versions/:versionNo/status')
  async getDocumentStatus(
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
    @Param('versionNo') versionNo: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (
      !/^[1-9]\d*$/.test(versionNo) ||
      !Number.isSafeInteger(Number(versionNo))
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Version number must be a positive integer.',
      });
    }
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    if (!this.actorContext) {
      throw new ServiceUnavailableException({
        code: 'IAM_SCOPE_UNAVAILABLE',
        message: 'Project membership verification is temporarily unavailable.',
      });
    }
    // SEC-AUTH-001: Require explicit ACTIVE project membership instead of metadata-only projects.get().
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
    const result = await this.aiEngine.request({
      path: `/api/v1/projects/${encodeURIComponent(scope.project.id)}/documents/${encodeURIComponent(documentId)}/versions/${versionNo}/status`,
      method: 'GET',
      headers: this.scopeHeaders(
        actor.id,
        scope.project.organizationId,
        scope.project.id,
      ),
    });
    response.status(result.status);
    return result.body;
  }

  private scopeHeaders(
    actorId: string,
    organizationId: string,
    projectId: string,
  ): Record<string, string> {
    return {
      'X-Continuum-User-Id': actorId,
      'X-Continuum-Organization-Id': organizationId,
      'X-Continuum-Tenant-Id': organizationId,
      'X-Continuum-Project-Id': projectId,
      'X-Continuum-Security-Partition': projectId,
    };
  }
}
