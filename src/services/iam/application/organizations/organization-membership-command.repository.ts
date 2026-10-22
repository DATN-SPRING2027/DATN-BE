export const ORGANIZATION_MEMBERSHIP_COMMAND_REPOSITORY = Symbol(
  'ORGANIZATION_MEMBERSHIP_COMMAND_REPOSITORY',
);

export type MembershipReasonCode =
  | 'ACCESS_REQUEST'
  | 'ACCESS_REVIEW'
  | 'INVITATION_CANCELLED'
  | 'SECURITY_INCIDENT';

export type OrganizationInvitationAccessScope =
  'ORGANIZATION' | 'SPECIFIC_PROJECTS';

export type OrganizationInvitationExpiryDays = 7 | 14 | 30;

export type OrganizationMembershipCommand =
  | {
      command: 'INVITE';
      email: string;
      reasonCode: 'ACCESS_REQUEST' | 'ACCESS_REVIEW';
      roleCode?: 'ADMIN' | 'MEMBER';
      projectRoleCode?: 'TEAM_LEADER' | 'MEMBER';
      accessScope?: OrganizationInvitationAccessScope;
      projectIds?: readonly string[];
      message?: string;
      expiresInDays?: OrganizationInvitationExpiryDays;
      requireApproval?: boolean;
    }
  | {
      command: 'RESEND';
      invitationId: string;
      expectedMembershipVersion: number;
      expectedInvitationVersion: number;
      reasonCode: 'ACCESS_REQUEST' | 'ACCESS_REVIEW';
    }
  | {
      command: 'CANCEL';
      invitationId: string;
      expectedMembershipVersion: number;
      expectedInvitationVersion: number;
      reasonCode: 'INVITATION_CANCELLED';
    }
  | {
      command: 'SUSPEND';
      membershipId: string;
      expectedMembershipVersion: number;
      reasonCode: 'SECURITY_INCIDENT' | 'ACCESS_REVIEW';
    }
  | {
      command: 'RESUME';
      membershipId: string;
      expectedMembershipVersion: number;
      reasonCode: 'SECURITY_INCIDENT' | 'ACCESS_REVIEW' | 'ACCESS_REQUEST';
    }
  | {
      command: 'REMOVE';
      membershipId: string;
      expectedMembershipVersion: number;
      reasonCode: 'SECURITY_INCIDENT' | 'ACCESS_REVIEW' | 'ACCESS_REQUEST';
    }
  | {
      command: 'SET_ORGANIZATION_ROLE';
      membershipId: string;
      expectedMembershipVersion: number;
      expectedRoleVersion: number;
      roleCode: 'ADMIN' | 'MEMBER';
      reason: string;
    };

export interface InvitationMutationAcknowledgement {
  operationId: string;
  invitation: {
    id: string;
    status: 'PENDING' | 'ACCEPTED' | 'CANCELLED' | 'EXPIRED' | 'SUPERSEDED';
    version: number;
    expiresAt: string;
  };
}

export interface MembershipMutationAcknowledgement {
  operationId: string;
  membership: {
    id: string;
    organizationId: string;
    userId: string;
    status: 'PENDING_INVITE' | 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
    version: number;
  };
  invitation?: {
    id: string;
    status: 'PENDING' | 'ACCEPTED' | 'CANCELLED' | 'EXPIRED' | 'SUPERSEDED';
    version: number;
    expiresAt: string;
  };
  role?: { roleCode: 'ADMIN' | 'MEMBER'; version: number };
}

export type PlatformInvitationCommand = Extract<
  OrganizationMembershipCommand,
  { command: 'INVITE' | 'RESEND' | 'CANCEL' }
>;

export interface PlatformInvitationCommandInput {
  actorUserId: string;
  organizationId: string;
  idempotencyKey: string;
  command: PlatformInvitationCommand;
  now: Date;
  invitationReadinessReady: boolean;
  correlationId?: string;
}

export interface MembershipMutationResult {
  httpStatus: 200 | 201;
  body: MembershipMutationAcknowledgement | InvitationMutationAcknowledgement;
  replayed: boolean;
}

export interface PlatformMembershipSuspendInput {
  actorUserId: string;
  organizationId: string;
  membershipId: string;
  idempotencyKey: string;
  expectedMembershipVersion: number;
  reasonCode: 'SECURITY_INCIDENT' | 'ACCESS_REVIEW';
  now: Date;
  correlationId?: string;
}

export interface AdminInvitationSummary {
  id: string;
  organizationId: string;
  status: 'PENDING' | 'ACCEPTED' | 'CANCELLED' | 'EXPIRED' | 'SUPERSEDED';
  version: number;
  expiresAt: string;
  createdAt: string;
  invitedEmail: string;
}

export interface AdminInvitationPage {
  data: AdminInvitationSummary[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

export interface OrganizationLeaderlessProjectItem {
  id: string;
  name: string;
  code: string;
  visibility: 'PRIVATE' | 'PUBLIC';
  status: 'ACTIVE' | 'ARCHIVED';
  activeMemberCount: number;
  effectiveLeaderCount: number;
  updatedAt: string;
}

export interface OrganizationManagerSummary {
  userId: string;
  fullName: string;
  email: string;
  accountStatus: string;
}

export interface OrganizationOverviewSummary {
  organization: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    plan: 'FREE' | 'ENTERPRISE';
    status: 'ACTIVE';
    createdAt: string;
    updatedAt: string;
  };
  metrics: {
    activeMembers: number;
    suspendedMembers: number;
    pendingInvitations: number;
    totalProjects: number;
    activeProjects: number;
    archivedProjects: number;
    leaderlessProjectsCount: number;
  };
  leaderlessProjects: OrganizationLeaderlessProjectItem[];
  managers: OrganizationManagerSummary[];
}

export interface OrganizationSettingsSummary {
  organization: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    plan: 'FREE' | 'ENTERPRISE';
    status: 'ACTIVE';
    createdAt: string;
    updatedAt: string;
  };
  editableFields: readonly ('name' | 'description')[];
  managers: OrganizationManagerSummary[];
  availablePermissions: string[];
}

export interface OrganizationSettingsUpdateInput {
  actorUserId: string;
  organizationId: string;
  expectedUpdatedAt: Date;
  name?: string;
  description?: string | null;
  now: Date;
  correlationId?: string;
}

export interface OrganizationMembershipCommandRepository {
  hasPermission(
    this: void,
    organizationId: string,
    actorUserId: string,
    permission:
      'organization.memberships.read' | 'organization.memberships.manage',
  ): Promise<boolean>;
  getOrganizationOverview?(
    this: void,
    organizationId: string,
    now: Date,
  ): Promise<OrganizationOverviewSummary>;
  getOrganizationSettings?(
    this: void,
    organizationId: string,
  ): Promise<OrganizationSettingsSummary>;
  updateOrganizationSettings?(
    this: void,
    input: OrganizationSettingsUpdateInput,
  ): Promise<OrganizationSettingsSummary>;
  listInvitations(
    this: void,
    organizationId: string,
    page: number,
    pageSize: number,
    now: Date,
  ): Promise<AdminInvitationPage>;
  execute(
    this: void,
    input: {
      actorUserId: string;
      organizationId: string;
      idempotencyKey: string;
      command: OrganizationMembershipCommand;
      now: Date;
      invitationReadinessReady?: boolean;
      correlationId?: string;
    },
  ): Promise<MembershipMutationResult>;
  executePlatformSuspend(
    input: PlatformMembershipSuspendInput,
  ): Promise<MembershipMutationResult>;
  executePlatformInvitationCommand(
    input: PlatformInvitationCommandInput,
  ): Promise<MembershipMutationResult>;
}
