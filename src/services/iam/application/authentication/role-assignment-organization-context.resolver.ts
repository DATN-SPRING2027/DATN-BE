import { Inject, Injectable } from '@nestjs/common';
import {
  AUTHENTICATION_REPOSITORY,
  type AuthenticationRepositoryPort,
} from './authentication.repository';
import type {
  OrganizationContextResolution,
  OrganizationContextResolver,
} from './organization-context.resolver';

@Injectable()
export class RoleAssignmentOrganizationContextResolver implements OrganizationContextResolver {
  constructor(
    @Inject(AUTHENTICATION_REPOSITORY)
    private readonly repository: AuthenticationRepositoryPort,
  ) {}

  async resolveForUser(
    userId: string,
    requestedOrganizationId?: string,
  ): Promise<OrganizationContextResolution> {
    const assignments =
      await this.repository.findOrganizationRoleAssignments(userId);
    const rolesByOrganization = new Map<string, Set<string>>();

    for (const assignment of assignments) {
      const roles =
        rolesByOrganization.get(assignment.organizationId) ?? new Set();
      roles.add(assignment.roleCode);
      rolesByOrganization.set(assignment.organizationId, roles);
    }

    if (rolesByOrganization.size === 0) {
      return { outcome: 'NO_ELIGIBLE_ORGANIZATION' };
    }

    if (requestedOrganizationId) {
      const selectedRoles = rolesByOrganization.get(requestedOrganizationId);
      if (!selectedRoles) {
        return { outcome: 'INVALID_ORGANIZATION_SELECTION' };
      }
      return {
        outcome: 'RESOLVED',
        context: {
          orgId: requestedOrganizationId,
          roles: [...selectedRoles].sort(),
        },
      };
    }

    if (rolesByOrganization.size > 1) {
      return { outcome: 'ORGANIZATION_SELECTION_REQUIRED' };
    }

    const [orgId, roles] = rolesByOrganization.entries().next().value as [
      string,
      Set<string>,
    ];
    return {
      outcome: 'RESOLVED',
      context: { orgId, roles: [...roles].sort() },
    };
  }
}
