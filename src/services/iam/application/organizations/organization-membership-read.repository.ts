import type { UserStatus } from '../users/user-directory.repository';

export const ORGANIZATION_MEMBERSHIP_READ_REPOSITORY = Symbol(
  'ORGANIZATION_MEMBERSHIP_READ_REPOSITORY',
);
export const ORGANIZATION_MEMBERSHIP_STATUSES = [
  'PENDING_INVITE',
  'ACTIVE',
  'SUSPENDED',
  'REMOVED',
] as const;
export type OrganizationMembershipStatus =
  (typeof ORGANIZATION_MEMBERSHIP_STATUSES)[number];
export interface OrganizationMembershipSummary {
  id: string;
  organizationId: string;
  userId: string;
  status: OrganizationMembershipStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    fullName: string;
    email: string;
    accountStatus: UserStatus;
  } | null;
}
export interface OrganizationMembershipListQuery {
  page: number;
  pageSize: number;
  status?: OrganizationMembershipStatus;
}
export interface OrganizationMembershipReadRepository {
  hasReadAccess(organizationId: string, actorId: string): Promise<boolean>;
  list(
    organizationId: string,
    query: OrganizationMembershipListQuery,
  ): Promise<{ data: OrganizationMembershipSummary[]; totalItems: number }>;
  find(
    organizationId: string,
    membershipId: string,
  ): Promise<OrganizationMembershipSummary | null>;
}
