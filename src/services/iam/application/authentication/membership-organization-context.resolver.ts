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
export class MembershipOrganizationContextResolver implements OrganizationContextResolver {
  constructor(
    @Inject(AUTHENTICATION_REPOSITORY)
    private readonly repository: AuthenticationRepositoryPort,
  ) {}

  async resolveForUser(
    userId: string,
    requestedOrganizationId?: string,
  ): Promise<OrganizationContextResolution> {
    const activeMembershipIds =
      await this.repository.findActiveOrganizationMembershipIds(userId);
    if (activeMembershipIds.length === 0) {
      return { outcome: 'NO_ELIGIBLE_ORGANIZATION' };
    }

    const organizations = await this.repository.findOrganizationOptions(
      [...new Set(activeMembershipIds)].sort(),
    );
    if (organizations.length === 0) {
      return { outcome: 'NO_ELIGIBLE_ORGANIZATION' };
    }

    if (requestedOrganizationId) {
      if (
        !organizations.some((entry) => entry.id === requestedOrganizationId)
      ) {
        return { outcome: 'INVALID_ORGANIZATION_SELECTION' };
      }
      return this.resolveSelected(userId, requestedOrganizationId);
    }

    if (organizations.length > 1) {
      return {
        outcome: 'ORGANIZATION_SELECTION_REQUIRED',
        organizations,
      };
    }

    return this.resolveSelected(userId, organizations[0].id);
  }

  private async resolveSelected(
    userId: string,
    orgId: string,
  ): Promise<OrganizationContextResolution> {
    const assignments =
      await this.repository.findOrganizationRoleAssignments(userId);
    const roles = [
      ...new Set(
        assignments
          .filter((assignment) => assignment.organizationId === orgId)
          .map((assignment) => assignment.roleCode),
      ),
    ].sort();
    return { outcome: 'RESOLVED', context: { orgId, roles } };
  }
}
