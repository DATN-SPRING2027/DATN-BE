import type { OrganizationMembershipStatus } from '../organizations/organization-membership-read.repository';
import type { OrganizationPlan } from '../organizations/organization-provisioning.repository';

export const PLATFORM_ADMINISTRATION_REPOSITORY = Symbol(
  'PLATFORM_ADMINISTRATION_REPOSITORY',
);

export interface PlatformOrganizationSummary {
  id: string;
  name: string;
  slug: string;
  plan: OrganizationPlan;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformUserLookupResult {
  id: string;
  email: string;
  fullName: string;
  status: 'ACTIVE';
}

export interface PlatformMembershipSummary {
  id: string;
  organizationId: string;
  userId: string;
  status: OrganizationMembershipStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    email: string;
    fullName: string;
    accountStatus: 'ACTIVE' | 'SUSPENDED' | 'PENDING_INVITE';
  } | null;
  organizationRoles: string[];
}

export interface PlatformOrganizationPage {
  data: PlatformOrganizationSummary[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

export interface PlatformMembershipPage {
  data: PlatformMembershipSummary[];
  pagination: PlatformOrganizationPage['pagination'];
}

export interface PlatformAdministrationRepository {
  listOrganizations(
    page: number,
    pageSize: number,
  ): Promise<PlatformOrganizationPage>;
  findOrganization(id: string): Promise<PlatformOrganizationSummary | null>;
  findActiveUserByExactEmail(
    email: string,
  ): Promise<PlatformUserLookupResult | null>;
  listOrganizationMemberships(input: {
    organizationId: string;
    page: number;
    pageSize: number;
    status?: OrganizationMembershipStatus;
  }): Promise<PlatformMembershipPage>;
}
