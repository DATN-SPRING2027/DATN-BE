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

    const sortedMembershipIds = [...new Set(activeMembershipIds)].sort();
    if (
      requestedOrganizationId &&
      !sortedMembershipIds.includes(requestedOrganizationId)
    ) {
      return { outcome: 'INVALID_ORGANIZATION_SELECTION' };
    }

    if (requestedOrganizationId) {
      const [organizations, assignments] = await Promise.all([
        this.repository.findOrganizationOptions(sortedMembershipIds),
        this.repository.findOrganizationRoleAssignments(userId),
      ]);
      if (organizations.length === 0) {
        return { outcome: 'NO_ELIGIBLE_ORGANIZATION' };
      }
      if (
        !organizations.some((entry) => entry.id === requestedOrganizationId)
      ) {
        return { outcome: 'INVALID_ORGANIZATION_SELECTION' };
      }
      return {
        outcome: 'RESOLVED',
        context: {
          orgId: requestedOrganizationId,
          roles: this.extractOrganizationRoles(
            assignments,
            requestedOrganizationId,
          ),
        },
      };
    }

    const organizations =
      await this.repository.findOrganizationOptions(sortedMembershipIds);
    if (organizations.length === 0) {
      return { outcome: 'NO_ELIGIBLE_ORGANIZATION' };
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
    return {
      outcome: 'RESOLVED',
      context: {
        orgId,
        roles: this.extractOrganizationRoles(assignments, orgId),
      },
    };
  }

  private extractOrganizationRoles(
    assignments: Awaited<
      ReturnType<
        AuthenticationRepositoryPort['findOrganizationRoleAssignments']
      >
    >,
    orgId: string,
  ): string[] {
    return [
      ...new Set(
        assignments
          .filter(
            (assignment) =>
              assignment.organizationId === orgId &&
              (assignment.roleCode === 'ADMIN' ||
                assignment.roleCode === 'MEMBER'),
          )
          .map((assignment) => assignment.roleCode),
      ),
    ].sort();
  }
}
