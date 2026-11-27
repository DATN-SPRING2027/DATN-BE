import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { resolveExpectedOrganizationHeader } from '../../../../common/http/organization-header';
import { AuthenticationApplicationService } from '../authentication/authentication.application.service';
import {
  AUTHORIZATION_EVIDENCE_PROVIDER,
  type AuthorizationEvidenceProvider,
} from './authorization-evidence.provider';
import { PROJECT_ACCESS_PERMISSION } from './project-access-permission.decorator';
import type { ProjectAccessPermission } from './authorization.policy';
import { AuthorizationPolicy } from './authorization.policy';

type ProjectAccessRequest = Request & {
  params: Record<string, string>;
  query: Record<string, unknown>;
};

@Injectable()
export class ProjectAccessAuthorizationGuard implements CanActivate {
  constructor(
    private readonly authentication: AuthenticationApplicationService,
    @Inject(AUTHORIZATION_EVIDENCE_PROVIDER)
    private readonly evidence: AuthorizationEvidenceProvider,
    private readonly policy: AuthorizationPolicy,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission =
      this.reflector.getAllAndOverride<ProjectAccessPermission>(
        PROJECT_ACCESS_PERMISSION,
        [context.getHandler(), context.getClass()],
      );
    if (!permission) throw new ForbiddenException();

    const request = context.switchToHttp().getRequest<ProjectAccessRequest>();
    const identity = await this.authentication.getCurrentIdentity(
      request.headers.authorization,
      request.headers.cookie,
    );
    const projectId = request.params?.projectId;
    const headerOrganizationId = resolveExpectedOrganizationHeader(
      request.headers,
    );
    const selectors: unknown[] = [
      headerOrganizationId,
      request.query?.organizationId,
    ];
    if (
      selectors.some(
        (value) => value !== undefined && value !== identity.organizationId,
      )
    )
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      });

    const facts = await this.evidence.loadProjectAccess(
      identity.id,
      identity.organizationId,
      projectId,
    );
    if (!facts?.project)
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      });
    const baseInput = {
      subject: {
        userId: identity.id,
        organizationId: identity.organizationId,
        status: 'ACTIVE' as const,
      },
      requestedOrganizationId: identity.organizationId,
      requestedProjectId: projectId,
      ...facts,
    };
    const requestedBodyRole =
      typeof (request as { body?: { role?: unknown } }).body?.role === 'string'
        ? (request as { body?: { role?: string } }).body?.role
        : undefined;
    const effectivePermission: ProjectAccessPermission =
      permission === 'project.members.add' &&
      requestedBodyRole === 'TEAM_LEADER'
        ? 'project.leader.manage'
        : permission;
    const decision = this.policy.evaluateProjectAccess({
      permission: effectivePermission,
      ...baseInput,
    });
    if (!decision.allowed) {
      // SEC-AUTH-004: listLeaders allows ADMIN (project.leader.manage) or an active
      // Project TEAM_LEADER with project.members.list — never a regular MEMBER.
      if (
        effectivePermission === 'project.leader.manage' &&
        context.getHandler().name === 'listLeaders' &&
        this.policy.evaluateProjectAccess({
          ...baseInput,
          permission: 'project.members.list',
          assignments: baseInput.assignments.filter(
            (assignment) => assignment.roleCode === 'TEAM_LEADER',
          ),
        }).allowed
      ) {
        return true;
      }
      throw new ForbiddenException();
    }
    return true;
  }
}
