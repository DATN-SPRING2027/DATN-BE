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
  'if-match',
  'idempotency-key',
  'x-csrf-token',
  'x-organization-id',
  'x-request-id',
] as const;
const forwardedResponseHeaders = [
  'cache-control',
  'content-type',
  'etag',
  'location',
  'idempotency-replayed',
  'x-idempotent-replay',
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

  @Post('auth/platform/login')
  loginPlatform(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('auth/refresh')
  refreshSession(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('auth/platform/me')
  getPlatformSession(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('auth/registrations')
  requestEmailRegistration(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('auth/registrations/verify')
  verifyEmailRegistration(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
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

  @Get('auth/invitations/:invitationId')
  getMyInvitation(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('auth/invitations/resolve')
  resolveInvitationLink(
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

  @Get('iam/platform/dashboard')
  getPlatformDashboard(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/platform/organizations')
  createPlatformOrganization(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/organizations')
  listPlatformOrganizations(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/organizations/:organizationId')
  getPlatformOrganization(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/incidents')
  listPlatformIncidents(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/diagnostics/traces/:requestId')
  getPlatformRequestTrace(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/incidents/:incidentId')
  getPlatformIncident(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/incidents/:incidentId/history')
  listPlatformIncidentHistory(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/platform/incidents')
  createPlatformIncident(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/platform/incidents/:incidentId/acknowledge')
  acknowledgePlatformIncident(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/platform/incidents/:incidentId/resolve')
  resolvePlatformIncident(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/platform/incidents/:incidentId/notes')
  addPlatformIncidentNote(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/services')
  listPlatformServices(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/services/:serviceId')
  getPlatformService(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/queues')
  listPlatformQueues(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/queues/:queueId')
  getPlatformQueue(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/jobs')
  listPlatformJobs(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/jobs/:queueId/:jobId')
  getPlatformJob(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/platform/jobs/:queueId/:jobId/retry')
  retryPlatformJob(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/platform/jobs/:queueId/:jobId/cancel')
  cancelPlatformJob(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/ai/operations')
  getPlatformAiOperations(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/integrations')
  listPlatformIntegrations(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/integrations/:integrationId')
  getPlatformIntegration(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/platform/integrations/:integrationId/test')
  testPlatformIntegration(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/platform/integrations/:integrationId/reconnect')
  reconnectPlatformIntegration(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/projects')
  listPlatformProjects(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/projects/:projectId')
  getPlatformProject(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/projects/:projectId/memberships')
  listPlatformProjectMemberships(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Patch('iam/platform/projects/:projectId')
  updatePlatformProject(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Patch('iam/platform/organizations/:organizationId')
  updatePlatformOrganization(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/users')
  listPlatformUsers(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/platform/users/lookup')
  lookupPlatformUser(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/users/:userId')
  getPlatformUser(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Patch('iam/platform/users/:userId')
  updatePlatformUserProfile(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/platform/users/:userId/archive')
  archivePlatformUser(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/platform/users/:userId/restore')
  restorePlatformUser(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Patch('iam/platform/users/:userId/status')
  updatePlatformUserStatus(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/users/:userId/organizations')
  listPlatformUserOrganizations(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/memberships')
  listPlatformMemberships(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/memberships/:membershipId')
  getPlatformMembership(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/organizations/:organizationId/memberships')
  listPlatformOrganizationMemberships(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/organizations/:organizationId/invitations')
  listPlatformOrganizationInvitations(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/platform/organizations/:organizationId/invitations')
  createPlatformOrganizationInvitation(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post(
    'iam/platform/organizations/:organizationId/invitations/:invitationId/resend',
  )
  resendPlatformOrganizationInvitation(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post(
    'iam/platform/organizations/:organizationId/invitations/:invitationId/cancel',
  )
  cancelPlatformOrganizationInvitation(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post(
    'iam/platform/organizations/:organizationId/memberships/:membershipId/suspend',
  )
  suspendPlatformMembership(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/health')
  getPlatformHealth(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/audit')
  listPlatformAudit(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/users/:userId/sessions')
  listPlatformUserSessions(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/users/:userId/sessions/:sessionId')
  getPlatformUserSession(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/platform/users/:userId/sessions/:sessionId/revoke')
  revokePlatformUserSession(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/platform/users/:userId/sessions/revoke-bulk')
  revokePlatformUserSessions(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/platform/users/:userId/sessions/revoke-all')
  revokeAllPlatformUserSessions(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/audit/events')
  listPlatformAuditEvents(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/audit/events/:eventId')
  getPlatformAuditEvent(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/platform/audit/resources/:resourceType/:resourceId/history')
  listPlatformResourceAuditHistory(
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

  @Post('iam/organizations/:organizationId/invitations/:invitationId/resend')
  resendOrganizationInvitation(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/organizations/:organizationId/invitations/:invitationId/cancel')
  cancelOrganizationInvitation(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/organizations/:organizationId/memberships/:membershipId/suspend')
  suspendOrganizationMembership(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Post('iam/organizations/:organizationId/memberships/:membershipId/role')
  setOrganizationMembershipRole(
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

  @Patch('iam/projects/:projectId')
  updateProject(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/projects/:projectId/settings-access')
  getProjectSettingsAccess(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/projects/:projectId/visibility')
  getProjectVisibilityAccess(
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

  @Get('iam/projects/:projectId/member-candidates')
  listProjectMemberCandidates(
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

  @Get('iam/projects/:projectId/leaders')
  listProjectLeaders(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.forward(request, response);
  }

  @Get('iam/projects/:projectId/leader-candidates')
  listProjectLeaderCandidates(
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
    const isTeamRoute =
      /^\/api\/v1\/iam\/(?:projects\/[^/]+\/teams|teams\/[^/]+(?:\/(?:archive|restore))?)$/.test(
        request.path,
      );
    if (isTeamRoute) response.setHeader('cache-control', 'no-store');
    const baseUrl = this.config.getOrThrow<string>('IAM_SERVICE_URL');
    const path = request.originalUrl.replace(/^\/api\/v1\//, '/internal/');
    const url = new URL(path, baseUrl).toString();
    const headers: Record<string, string> = {};
    for (const name of forwardedRequestHeaders) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    if (
      /^\/api\/v1\/auth\/(?:(?:platform\/)?login|password-reset\/(?:request|confirm)|registrations(?:\/verify)?)$/.test(
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
    if (isTeamRoute) response.setHeader('cache-control', 'no-store');
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length > 0) response.setHeader('set-cookie', cookies);

    response
      .status(upstream.status)
      .send(Buffer.from(await upstream.arrayBuffer()));
  }
}
