import {
  BadGatewayException,
  BadRequestException,
  Controller,
  Get,
  Headers,
  Inject,
  Query,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { AuthenticatedIdentity } from '../../services/iam/application/authentication/authentication.application.service';
import { AuthenticationApplicationService } from '../../services/iam/application/authentication/authentication.application.service';
import { ProjectService } from '../../services/iam/application/projects/project.service';
import { sanitizeContinuumActorHeaderName } from './ai-chat.types';
import { AI_ENGINE_CLIENT } from './ai-engine.port';
import type { AiEngineClient } from './ai-engine.port';

type SagLoginResponse = Readonly<{ access_token: string }>;
const SSO_STATE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller('ai-engine/auth')
export class AiEngineAuthController {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly projects: ProjectService,
    private readonly config: ConfigService,
    @Inject(AI_ENGINE_CLIENT) private readonly aiEngine: AiEngineClient,
  ) {}

  @Get('sag-login')
  async loginToSag(
    @Query('state') state: string,
    @Query('projectId') projectId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (!SSO_STATE_PATTERN.test(state)) {
      throw new BadRequestException({ code: 'SAG_SSO_STATE_INVALID' });
    }

    const continuumWebUrl = this.config.get<string>('CONTINUUM_WEB_BASE_URL');
    const sagWebUrl = this.config.get<string>('SAG_WEB_BASE_URL');
    if (!continuumWebUrl || !sagWebUrl) {
      throw new ServiceUnavailableException({
        code: 'SAG_SSO_NOT_CONFIGURED',
        message: 'SAG sign-in is not configured.',
      });
    }

    if (
      projectId !== undefined &&
      (typeof projectId !== 'string' ||
        !projectId.trim() ||
        projectId !== projectId.trim() ||
        projectId.length > 64)
    ) {
      throw new BadRequestException({ code: 'SAG_SSO_PROJECT_INVALID' });
    }

    let actor: AuthenticatedIdentity;
    try {
      actor = await this.auth.getCurrentIdentity(authorization, cookie);
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) throw error;
      const signIn = new URL('/signin', continuumWebUrl);
      response.redirect(302, signIn.toString());
      return;
    }

    if (projectId === undefined) {
      const pageSize = 100;
      const firstPage = await this.projects.list(actor, { page: 1, pageSize });
      const projects = firstPage.data.map(({ id, name }) => ({ id, name }));
      for (let page = 2; page <= firstPage.pagination.totalPages; page += 1) {
        const nextPage = await this.projects.list(actor, { page, pageSize });
        projects.push(...nextPage.data.map(({ id, name }) => ({ id, name })));
      }

      const callback = new URL('/sso', sagWebUrl);
      callback.searchParams.set('state', state);
      callback.hash = new URLSearchParams({
        projects: JSON.stringify(projects),
      }).toString();
      response.redirect(302, callback.toString());
      return;
    }

    const project = await this.projects.get(actor, projectId);
    // User profile text becomes an HTTP header, so normalize to printable ASCII.
    const name = sanitizeContinuumActorHeaderName(actor.name);
    const result = await this.aiEngine.request<SagLoginResponse>({
      path: '/api/v1/auth/continuum-login',
      method: 'POST',
      headers: {
        'X-Continuum-User-Id': actor.id,
        'X-Continuum-Name': name,
        'X-Continuum-Organization-Id': project.organizationId,
        'X-Continuum-Project-Id': project.id,
      },
      body: {},
    });
    const token = result.body?.access_token;
    if (
      typeof token !== 'string' ||
      token.length > 8192 ||
      token.split('.').length !== 3
    ) {
      throw new BadGatewayException(
        'AI Engine returned an invalid login response.',
      );
    }

    const callback = new URL('/sso', sagWebUrl);
    callback.searchParams.set('state', state);
    callback.hash = new URLSearchParams({ token }).toString();
    response.redirect(302, callback.toString());
  }
}
