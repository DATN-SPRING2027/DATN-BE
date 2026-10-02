import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticationApplicationService } from '../authentication/authentication.application.service';
import {
  type AuthorizationEvidenceProvider,
  type ProjectAccessEvidence,
} from './authorization-evidence.provider';
import { AuthorizationPolicy } from './authorization.policy';
import { ProjectAccessAuthorizationGuard } from './project-access-authorization.guard';
import { PROJECT_ACCESS_PERMISSION } from './project-access-permission.decorator';

const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const organizationId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const projectId = 'cccccccccccccccccccccccc';
const otherOrganizationId = 'dddddddddddddddddddddddd';

const leaderIdentity = {
  id: userId,
  organizationId,
  status: 'ACTIVE',
  email: 'leader@example.test',
  name: 'Leader',
  roles: ['TEAM_LEADER'],
};

function evidence(permission: string): ProjectAccessEvidence {
  return {
    project: {
      id: projectId,
      organizationId,
      status: 'ACTIVE',
      visibility: 'PRIVATE',
    },
    membership: { userId, organizationId, status: 'ACTIVE' },
    projectMembership: { userId, organizationId, projectId, status: 'ACTIVE' },
    assignments: [
      {
        userId,
        organizationId,
        projectId,
        roleCode: 'TEAM_LEADER',
        resolvedRoleCode: 'TEAM_LEADER',
        permissions: [permission],
      },
    ],
    explicitDeny: 'CLEAR',
  };
}

function fixture(permission: string, facts = evidence(permission)) {
  const handler = () => undefined;
  Reflect.defineMetadata(PROJECT_ACCESS_PERMISSION, permission, handler);
  const request = {
    headers: { authorization: 'Bearer valid', cookie: undefined },
    params: { projectId },
    query: {} as Record<string, unknown>,
  };
  const context = {
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const authentication = {
    getCurrentIdentity: jest.fn().mockResolvedValue(leaderIdentity),
  };
  const evidenceProvider = {
    loadProjectAccess: jest.fn().mockResolvedValue(facts),
  };
  const guard = new ProjectAccessAuthorizationGuard(
    authentication as unknown as AuthenticationApplicationService,
    evidenceProvider as unknown as AuthorizationEvidenceProvider,
    new AuthorizationPolicy(),
    new Reflector(),
  );
  return { guard, request, evidenceProvider, context };
}

describe('ProjectAccessAuthorizationGuard', () => {
  it.each([
    'project.members.list',
    'project.members.add',
    'project.members.remove',
  ])(
    'allows an active Project Leader with the exact %s permission',
    async (permission) => {
      const { guard, context } = fixture(permission);
      await expect(guard.canActivate(context)).resolves.toBe(true);
    },
  );

  it('does not turn an authorized already-PUBLIC request into an authorization denial', async () => {
    const facts = evidence('project.visibility.manage');
    facts.project!.visibility = 'PUBLIC';
    facts.projectMembership = null;
    facts.assignments = [
      {
        userId,
        organizationId,
        projectId: null,
        roleCode: 'ADMIN',
        resolvedRoleCode: 'ADMIN',
        permissions: ['project.visibility.manage'],
      },
    ];
    const { guard, context } = fixture('project.visibility.manage', facts);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('still denies unauthorized requests for an already-PUBLIC Project', async () => {
    const facts = evidence('project.visibility.manage');
    facts.project!.visibility = 'PUBLIC';
    facts.projectMembership = null;
    const { guard, context } = fixture('project.visibility.manage', facts);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('denies membership administration to an organization ADMIN without an active Project Leader assignment', async () => {
    const facts = evidence('project.members.add');
    facts.projectMembership = null;
    facts.assignments = [
      {
        userId,
        organizationId,
        projectId: null,
        roleCode: 'ADMIN',
        resolvedRoleCode: 'ADMIN',
        permissions: ['project.members.add'],
      },
    ];
    const { guard, context } = fixture('project.members.add', facts);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('denies a Project Leader without ACTIVE OrganizationMembership', async () => {
    const facts = evidence('project.members.list');
    facts.membership!.status = 'SUSPENDED';
    const { guard, context } = fixture('project.members.list', facts);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects client-selected cross-organization context before loading authorization facts', async () => {
    const { guard, request, evidenceProvider, context } = fixture(
      'project.members.list',
    );
    request.query.organizationId = otherOrganizationId;
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(evidenceProvider.loadProjectAccess).not.toHaveBeenCalled();
  });

  it('fails closed when the selected Project is outside the trusted Organization', async () => {
    const facts = evidence('project.members.list');
    facts.project = {
      id: projectId,
      organizationId: otherOrganizationId,
      status: 'ACTIVE',
    };
    const { guard, context } = fixture('project.members.list', facts);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
