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
    const selectors: unknown[] = [
      request.headers['x-organization-id'],
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
    const decision = this.policy.evaluateProjectAccess({
      permission,
      ...baseInput,
    });
    if (!decision.allowed) {
      const isLeaderListRead =
        permission === 'project.leader.manage' &&
        context.getHandler()?.name === 'listLeaders';
      if (isLeaderListRead) {
        const fallbackDecision = this.policy.evaluateProjectAccess({
          permission: 'project.members.list',
          ...baseInput,
        });
        if (fallbackDecision.allowed) return true;
      }
      throw new ForbiddenException();
    }
    return true;
  }
}
