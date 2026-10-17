import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthenticationApplicationService } from '../../services/iam/application/authentication/authentication.application.service';
import { ProjectService } from '../../services/iam/application/projects/project.service';
import { AI_ENGINE_CLIENT } from './ai-engine.port';
import type { AiEngineClient } from './ai-engine.port';

@Controller('ai-engine/projects/:projectId/documents')
export class AiEngineController {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly projects: ProjectService,
    @Inject(AI_ENGINE_CLIENT) private readonly aiEngine: AiEngineClient,
  ) {}

  @Get(':documentId/versions/:versionNo/status')
  async getDocumentStatus(
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
    @Param('versionNo') versionNo: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
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
    const project = await this.projects.get(actor, projectId);
    const result = await this.aiEngine.request({
      path: `/api/v1/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/versions/${versionNo}/status`,
      method: 'GET',
      headers: this.scopeHeaders(actor.id, project.organizationId, projectId),
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
