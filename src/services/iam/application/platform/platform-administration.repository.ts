import type { OrganizationMembershipStatus } from '../organizations/organization-membership-read.repository';
import type { OrganizationPlan } from '../organizations/organization-provisioning.repository';
import type { RoleCode, UserStatus } from '../users/user-directory.repository';

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
  hasPersistedVersion: boolean;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    email: string;
    fullName: string;
    accountStatus: 'ACTIVE' | 'SUSPENDED' | 'PENDING_INVITE';
  } | null;
  organizationRoles: string[];
  organization?: { id: string; name: string; slug: string } | null;
}

export interface PlatformMembershipListInput {
  page: number;
  pageSize: number;
  search?: string;
  status?: OrganizationMembershipStatus;
  organizationId?: string;
  roleCode?: RoleCode;
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

export interface PlatformUserMembershipSummary {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  status: OrganizationMembershipStatus;
  organizationRoles: string[];
}

export interface PlatformUserSummary {
  id: string;
  email: string;
  fullName: string;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  memberships: PlatformUserMembershipSummary[];
  membershipsTruncated: boolean;
}

export interface PlatformEffectivePermissionProjection {
  permission: string;
  scope: 'PLATFORM';
  status: 'ACTIVE' | 'REVOKED';
  source: 'PLATFORM_AUTHORITY_ASSIGNMENT';
  grantedAt: string;
  expiresAt: string | null;
  effective: boolean;
}

export interface PlatformUserDetail extends PlatformUserSummary {
  lastLoginAt: string | null;
  effectivePlatformPermissions: PlatformEffectivePermissionProjection[];
}

export interface PlatformUserListInput {
  page: number;
  pageSize: number;
  search?: string;
  status?: UserStatus;
  organizationId?: string;
  roleCode?: RoleCode;
}

export interface PlatformUserOrganizationsInput {
  userId: string;
  page: number;
  pageSize: number;
  status?: OrganizationMembershipStatus;
}

export interface PlatformUserStatusChangeInput {
  actorUserId: string;
  userId: string;
  status: 'ACTIVE' | 'SUSPENDED';
  expectedUpdatedAt: Date;
  reasonCode: 'SECURITY_INCIDENT' | 'ACCESS_REVIEW';
  correlationId?: string;
  now: Date;
}

export interface PlatformUserPage {
  data: PlatformUserSummary[];
  pagination: PlatformOrganizationPage['pagination'];
}

export interface PlatformUserOrganizationsPage {
  data: PlatformUserMembershipSummary[];
  pagination: PlatformOrganizationPage['pagination'];
}

export interface PlatformProjectSummary {
  id: string;
  organization: { id: string; name: string; slug: string };
  name: string;
  code: string;
  visibility: 'PRIVATE' | 'PUBLIC';
  status: 'ACTIVE' | 'ARCHIVED';
  memberCount: number;
  leaders: Array<{ id: string; email: string; fullName: string }>;
  leadersTruncated: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformProjectListInput {
  page: number;
  pageSize: number;
  search?: string;
  organizationId?: string;
  visibility?: 'PRIVATE' | 'PUBLIC';
  status?: 'ACTIVE' | 'ARCHIVED';
}

export interface PlatformProjectPage {
  data: PlatformProjectSummary[];
  pagination: PlatformOrganizationPage['pagination'];
}

export interface PlatformProjectMembershipListInput {
  projectId: string;
  organizationId: string;
  page: number;
  pageSize: number;
  search?: string;
  status?: 'ACTIVE' | 'INACTIVE';
}

export interface PlatformProjectMemberSummary {
  id: string;
  projectId: string;
  organizationId: string;
  userId: string;
  status: 'ACTIVE' | 'INACTIVE';
  joinedAt: string;
  user: {
    id: string;
    email: string;
    fullName: string;
    accountStatus: string;
  } | null;
}

export interface PlatformProjectMemberPage {
  data: PlatformProjectMemberSummary[];
  pagination: PlatformOrganizationPage['pagination'];
}

export interface PlatformProjectMetadataChangeInput {
  actorUserId: string;
  projectId: string;
  expectedUpdatedAt: Date;
  name?: string;
  code?: string;
  visibility?: 'PRIVATE' | 'PUBLIC';
  reasonCode: 'ACCESS_REVIEW' | 'SECURITY_INCIDENT';
  correlationId?: string;
  now: Date;
}

export interface PlatformOrganizationMetadataChangeInput {
  actorUserId: string;
  organizationId: string;
  expectedUpdatedAt: Date;
  name?: string;
  slug?: string;
  reasonCode: 'ACCESS_REVIEW' | 'SECURITY_INCIDENT';
  correlationId?: string;
  now: Date;
}

export interface PlatformDashboardSummary {
  organizations: { total: number };
  users: {
    total: number;
    active: number;
    suspended: number;
    pendingInvite: number;
  };
  projects: { total: number; active: number; archived: number };
  memberships: {
    total: number;
    active: number;
    suspended: number;
    pendingInvite: number;
    removed: number;
  };
  generatedAt: string;
}

export type PlatformSessionStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export interface PlatformSessionSummary {
  id: string;
  userId: string;
  context: 'ACCOUNT' | 'ORGANIZATION' | 'PLATFORM';
  organizationId: string | null;
  status: PlatformSessionStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface PlatformSessionPage {
  data: PlatformSessionSummary[];
  pagination: PlatformOrganizationPage['pagination'];
}

export interface PlatformSessionMutationResult {
  revokedCount: number;
  data: PlatformSessionSummary[];
}

export interface PlatformSessionListInput {
  userId: string;
  page: number;
  pageSize: number;
  status?: PlatformSessionStatus;
}

export interface PlatformSessionVersionInput {
  sessionId: string;
  expectedUpdatedAt: Date;
}

export interface PlatformSessionMutationInput {
  actorUserId: string;
  userId: string;
  reasonCode: 'SECURITY_INCIDENT' | 'ACCESS_REVIEW';
  correlationId?: string;
  now: Date;
}

export interface PlatformRevokeSessionsInput extends PlatformSessionMutationInput {
  sessions: PlatformSessionVersionInput[];
}

export interface PlatformAdministrationRepository {
  listUsers(input: PlatformUserListInput): Promise<PlatformUserPage>;
  findUser(id: string): Promise<PlatformUserDetail | null>;
  listUserOrganizations(
    input: PlatformUserOrganizationsInput,
  ): Promise<PlatformUserOrganizationsPage | null>;
  changeUserStatus(
    input: PlatformUserStatusChangeInput,
  ): Promise<PlatformUserDetail | null>;
  listProjects(input: PlatformProjectListInput): Promise<PlatformProjectPage>;
  findProject(id: string): Promise<PlatformProjectSummary | null>;
  listProjectMemberships(
    input: PlatformProjectMembershipListInput,
  ): Promise<PlatformProjectMemberPage>;
  changeProjectMetadata(
    input: PlatformProjectMetadataChangeInput,
  ): Promise<PlatformProjectSummary | null>;
  changeOrganizationMetadata(
    input: PlatformOrganizationMetadataChangeInput,
  ): Promise<PlatformOrganizationSummary | null>;
  getDashboardSummary(now: Date): Promise<PlatformDashboardSummary>;
  listUserSessions(
    input: PlatformSessionListInput,
  ): Promise<PlatformSessionPage | null>;
  findUserSession(
    userId: string,
    sessionId: string,
  ): Promise<PlatformSessionSummary | null>;
  revokeUserSession(
    input: PlatformSessionMutationInput & PlatformSessionVersionInput,
  ): Promise<PlatformSessionSummary | null>;
  revokeUserSessions(
    input: PlatformRevokeSessionsInput,
  ): Promise<PlatformSessionMutationResult | null>;
  revokeAllUserSessions(
    input: PlatformSessionMutationInput,
  ): Promise<number | null>;
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
  listPlatformMemberships(
    input: PlatformMembershipListInput,
  ): Promise<PlatformMembershipPage>;
  findPlatformMembership(id: string): Promise<PlatformMembershipSummary | null>;
}
