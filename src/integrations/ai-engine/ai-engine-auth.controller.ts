import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Optional,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { resolveExpectedOrganizationHeader } from '../../common/http/organization-header';
import { CsrfGuard } from '../../common/security/csrf';
import {
  AUTH_SECURITY_STORE,
  type AuthSecurityStore,
} from '../../services/iam/application/authentication/auth-security.store';
import type { AuthenticatedIdentity } from '../../services/iam/application/authentication/authentication.application.service';
import { AuthenticationApplicationService } from '../../services/iam/application/authentication/authentication.application.service';
import { IamActorContextService } from '../../services/iam/application/projects/iam-actor-context.service';
import { ProjectService } from '../../services/iam/application/projects/project.service';
import {
  sanitizeContinuumActorDisplayName,
  sanitizeContinuumActorHeaderName,
} from './ai-chat.types';
import { AI_ENGINE_CLIENT } from './ai-engine.port';
import type { AiEngineClient } from './ai-engine.port';

type SagLoginResponse = Readonly<{ access_token: string }>;
const SSO_STATE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SSO_CODE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const SSO_CODE_TTL_SECONDS = 30;
const MAX_FALLBACK_CODES = 500;

interface StoredSagExchange {
  readonly accessToken: string;
  readonly state: string;
  readonly projectId: string;
  readonly userId: string;
  readonly expiresAt: number;
}

@Controller('ai-engine/auth')
export class AiEngineAuthController {
  private readonly fallbackExchangeCodes = new Map<string, StoredSagExchange>();

  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly projects: ProjectService,
    private readonly config: ConfigService,
    @Inject(AI_ENGINE_CLIENT) private readonly aiEngine: AiEngineClient,
    @Optional() private readonly actorContext?: IamActorContextService,
    @Optional()
    @Inject(AUTH_SECURITY_STORE)
    private readonly securityStore?: AuthSecurityStore,
  ) {}

  private async issueOneTimeExchangeCode(
    payload: Omit<StoredSagExchange, 'expiresAt'>,
  ): Promise<string> {
    const code = randomBytes(32).toString('base64url');
    const record: StoredSagExchange = {
      ...payload,
      expiresAt: Date.now() + SSO_CODE_TTL_SECONDS * 1000,
    };
    if (this.securityStore?.storeOneTimeToken) {
      await this.securityStore.storeOneTimeToken(
        `sag-sso:${code}`,
        JSON.stringify(record),
        SSO_CODE_TTL_SECONDS,
      );
      return code;
    }
    const now = Date.now();
    if (this.fallbackExchangeCodes.size >= MAX_FALLBACK_CODES) {
      for (const [k, v] of this.fallbackExchangeCodes) {
        if (v.expiresAt <= now) this.fallbackExchangeCodes.delete(k);
      }
      if (this.fallbackExchangeCodes.size >= MAX_FALLBACK_CODES) {
        for (const firstKey of this.fallbackExchangeCodes.keys()) {
          this.fallbackExchangeCodes.delete(firstKey);
          break;
        }
      }
    }
    this.fallbackExchangeCodes.set(code, record);
    return code;
  }

  private async consumeOneTimeExchangeCode(
    code: string,
  ): Promise<StoredSagExchange | null> {
    if (this.securityStore?.consumeOneTimeToken) {
      const raw = await this.securityStore.consumeOneTimeToken(
        `sag-sso:${code}`,
      );
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as StoredSagExchange;
        return parsed.expiresAt > Date.now() ? parsed : null;
      } catch {
        return null;
      }
    }
    const record = this.fallbackExchangeCodes.get(code) ?? null;
    this.fallbackExchangeCodes.delete(code);
    if (!record || record.expiresAt <= Date.now()) {
      return null;
    }
    return record;
  }

  private async mintActiveMemberSagToken(
    actor: AuthenticatedIdentity,
    projectId: string,
    organizationHeader: string | undefined,
  ): Promise<{ token: string; projectId: string }> {
    if (!this.actorContext) {
      throw new ServiceUnavailableException({
        code: 'IAM_SCOPE_UNAVAILABLE',
        message: 'Project membership verification is temporarily unavailable.',
      });
    }
    // SEC-AUTH-001: Strictly require ACTIVE project membership — never metadata-only projects.get().
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

    const name = sanitizeContinuumActorHeaderName(actor.name);
    const displayName = sanitizeContinuumActorDisplayName(actor.name);
    const result = await this.aiEngine.request<SagLoginResponse>({
      path: '/api/v1/auth/continuum-login',
      method: 'POST',
      headers: {
        'X-Continuum-User-Id': actor.id,
        'X-Continuum-Name': name,
        'X-Continuum-Organization-Id': scope.project.organizationId,
        'X-Continuum-Project-Id': scope.project.id,
      },
      body: { displayName },
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
    return { token, projectId: scope.project.id };
  }

  /**
   * SEC-BE-001: CSRF-protected POST SSO initiation returning a short-lived
   * one-time opaque exchange code (never exposing raw JWTs in URL fragments).
   */
  @Post('sag-login')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  async initiateSagLoginPost(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{
    code?: string;
    state: string;
    projectId?: string;
    projects?: Array<{ id: string; name: string }>;
    redirectUrl: string;
  }> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    }
    const record = body as Record<string, unknown>;
    const state = typeof record.state === 'string' ? record.state : '';
    if (!SSO_STATE_PATTERN.test(state)) {
      throw new BadRequestException({ code: 'SAG_SSO_STATE_INVALID' });
    }
    const sagWebUrl = this.config.get<string>('SAG_WEB_BASE_URL');
    if (!sagWebUrl) {
      throw new ServiceUnavailableException({
        code: 'SAG_SSO_NOT_CONFIGURED',
        message: 'SAG sign-in is not configured.',
      });
    }
    const rawProjectId = record.projectId;
    if (
      rawProjectId !== undefined &&
      (typeof rawProjectId !== 'string' ||
        !rawProjectId.trim() ||
        rawProjectId !== rawProjectId.trim() ||
        rawProjectId.length > 64)
    ) {
      throw new BadRequestException({ code: 'SAG_SSO_PROJECT_INVALID' });
    }

    const authorization =
      typeof request.headers.authorization === 'string'
        ? request.headers.authorization
        : undefined;
    const cookie =
      typeof request.headers.cookie === 'string'
        ? request.headers.cookie
        : undefined;
    const organizationHeader = resolveExpectedOrganizationHeader(
      request.headers,
    );
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);

    if (rawProjectId === undefined) {
      if (!this.actorContext) {
        throw new ServiceUnavailableException({
          code: 'IAM_SCOPE_UNAVAILABLE',
          message:
            'Project membership verification is temporarily unavailable.',
        });
      }
      const memberProjects =
        await this.actorContext.listActiveMemberProjects(actor);
      const projects = memberProjects.map(({ id, name }) => ({ id, name }));
      const callback = new URL('/sso', sagWebUrl);
      callback.searchParams.set('state', state);
      return { state, projects, redirectUrl: callback.toString() };
    }

    const { token, projectId } = await this.mintActiveMemberSagToken(
      actor,
      rawProjectId,
      organizationHeader,
    );
    const code = await this.issueOneTimeExchangeCode({
      accessToken: token,
      state,
      projectId,
      userId: actor.id,
    });
    const callback = new URL('/sso', sagWebUrl);
    callback.searchParams.set('state', state);
    callback.searchParams.set('code', code);
    return {
      code,
      state,
      projectId,
      redirectUrl: callback.toString(),
    };
  }

  /**
   * SEC-BE-001: Single-use exchange endpoint converting a 30s opaque SSO code
   * (bound to `state`) into the SAG access token over POST JSON body.
   */
  @Post('sag-exchange')
  @HttpCode(200)
  async exchangeSagCode(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ accessToken: string; projectId: string }> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    }
    const record = body as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code.trim() : '';
    const state = typeof record.state === 'string' ? record.state.trim() : '';
    if (!SSO_CODE_PATTERN.test(code) || !SSO_STATE_PATTERN.test(state)) {
      throw new UnauthorizedException({ code: 'SAG_SSO_CODE_INVALID' });
    }
    const stored = await this.consumeOneTimeExchangeCode(code);
    if (!stored || stored.state !== state) {
      throw new UnauthorizedException({ code: 'SAG_SSO_CODE_INVALID' });
    }
    return {
      accessToken: stored.accessToken,
      projectId: stored.projectId,
    };
  }

  @Get('sag-login')
  async loginToSag(
    @Query('state') state: string,
    @Query('projectId') projectId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('sec-fetch-site') secFetchSite: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (!SSO_STATE_PATTERN.test(state)) {
      throw new BadRequestException({ code: 'SAG_SSO_STATE_INVALID' });
    }

    // SEC-BE-001: Block cross-site GET Login CSRF navigations.
    if (
      typeof secFetchSite === 'string' &&
      secFetchSite.trim().toLowerCase() === 'cross-site'
    ) {
      throw new ForbiddenException({
        code: 'SAG_SSO_CSRF_REJECTED',
        message: 'Cross-site SAG SSO initiation is not allowed.',
      });
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
      if (!this.actorContext) {
        throw new ServiceUnavailableException({
          code: 'IAM_SCOPE_UNAVAILABLE',
          message:
            'Project membership verification is temporarily unavailable.',
        });
      }
      // SEC-AUTH-001: List ONLY active joined projects for SSO project picker.
      const memberProjects =
        await this.actorContext.listActiveMemberProjects(actor);
      const projects = memberProjects.map(({ id, name }) => ({ id, name }));

      const callback = new URL('/sso', sagWebUrl);
      callback.searchParams.set('state', state);
      callback.hash = new URLSearchParams({
        projects: JSON.stringify(projects),
      }).toString();
      response.redirect(302, callback.toString());
      return;
    }

    const organizationHeader = resolveExpectedOrganizationHeader(
      request?.headers ?? {},
    );
    const { token, projectId: resolvedProjectId } =
      await this.mintActiveMemberSagToken(actor, projectId, organizationHeader);
    const code = await this.issueOneTimeExchangeCode({
      accessToken: token,
      state,
      projectId: resolvedProjectId,
      userId: actor.id,
    });

    // SEC-BE-001: Redirect with short-lived single-use opaque code instead of #token=<jwt>.
    const callback = new URL('/sso', sagWebUrl);
    callback.searchParams.set('state', state);
    callback.searchParams.set('code', code);
    response.redirect(302, callback.toString());
  }
}
