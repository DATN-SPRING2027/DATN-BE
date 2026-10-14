import {
  Controller,
  Delete,
  Get,
  GatewayTimeoutException,
  Patch,
  Post,
  Put,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { signGatewaySource } from '../common/http/gateway-source';

const forwardedRequestHeaders = [
  'accept',
  'authorization',
  'content-type',
  'cookie',
  'x-csrf-token',
  'x-organization-id',
  'x-request-id',
] as const;
const forwardedResponseHeaders = [
  'cache-control',
  'content-type',
  'location',
  'retry-after',
  'www-authenticate',
  'referrer-policy',
] as const;

@Controller()
export class GatewayIamController {
  private readonly sourceSecret: string;

  constructor(private readonly config: ConfigService) {
    this.sourceSecret = config.getOrThrow<string>('IAM_GATEWAY_SECRET');
    if (this.sourceSecret.length < 32) {
      throw new Error('IAM_GATEWAY_SECRET must contain at least 32 characters');
    }
  }

  @Get('auth/google')
  beginGoogleLogin(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('auth/google/callback')
  finishGoogleLogin(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('auth/login')
  login(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.forward(request, response);
  }

  @Post('auth/password-reset/request')
  requestPasswordReset(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('auth/password-reset/confirm')
  confirmPasswordReset(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('auth/select-organization')
  selectOrganization(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('auth/organizations')
  listAccountOrganizations(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('auth/invitations')
  listMyInvitations(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('auth/invitations/:invitationId/accept')
  acceptInvitation(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('auth/me')
  me(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.forward(request, response);
  }

  @Post('auth/logout')
  logout(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/users')
  listUsers(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/projects')
  listProjects(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/projects')
  createProject(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/organizations')
  createOwnOrganization(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/organizations/:organizationId/memberships')
  listOrganizationMemberships(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/organizations/:organizationId/memberships/:membershipId')
  getOrganizationMembership(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/organizations/:organizationId/invitations')
  listOrganizationInvitations(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/organizations/:organizationId/invitations')
  createOrganizationInvitation(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Delete('iam/organizations/:organizationId/invitations/:invitationId')
  revokeOrganizationInvitation(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/projects/:projectId')
  getProject(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Patch('iam/projects/:projectId/visibility')
  makeProjectPublic(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/projects/:projectId/memberships')
  listProjectMemberships(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/projects/:projectId/memberships')
  addProjectMember(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Delete('iam/projects/:projectId/memberships/:membershipId')
  removeProjectMember(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/projects/:projectId/leaders')
  assignProjectLeader(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Put('iam/projects/:projectId/leaders')
  changeProjectLeader(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Delete('iam/projects/:projectId/leaders/:userId')
  revokeProjectLeader(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/users/:userId')
  getUser(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.forward(request, response);
  }

  @Patch('iam/users/:userId')
  updateUser(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  private async forward(request: Request, response: Response): Promise<void> {
    const baseUrl = this.config.getOrThrow<string>('IAM_SERVICE_URL');
    const path = request.originalUrl.replace(/^\/api\/v1\//, '/internal/');
    const url = new URL(path, baseUrl).toString();
    const headers: Record<string, string> = {};
    for (const name of forwardedRequestHeaders) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    if (
      /^\/api\/v1\/auth\/(?:login|password-reset\/(?:request|confirm))$/.test(
        request.path,
      )
    ) {
      Object.assign(
        headers,
        signGatewaySource(
          request.ip ?? request.socket.remoteAddress ?? '',
          this.sourceSecret,
        ),
      );
    }

    let upstream: globalThis.Response;
    try {
      const isGoogleOAuthRoute =
        request.path === '/api/v1/auth/google' ||
        request.path === '/api/v1/auth/google/callback';
      upstream = await fetch(url, {
        method: request.method,
        headers,
        ...(request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
        ...(isGoogleOAuthRoute ? { redirect: 'manual' as const } : {}),
        signal: AbortSignal.timeout(
          this.config.getOrThrow<number>('BACKEND_TIMEOUT_MS'),
        ),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new GatewayTimeoutException('IAM service timed out');
      }
      throw new ServiceUnavailableException('IAM service unavailable');
    }

    for (const name of forwardedResponseHeaders) {
      const value = upstream.headers.get(name);
      if (value) response.setHeader(name, value);
    }
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length > 0) response.setHeader('set-cookie', cookies);

    response
      .status(upstream.status)
      .send(Buffer.from(await upstream.arrayBuffer()));
  }
}
