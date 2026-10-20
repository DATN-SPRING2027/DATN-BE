export const ORGANIZATION_MEMBERSHIP_COMMAND_REPOSITORY = Symbol(
  'ORGANIZATION_MEMBERSHIP_COMMAND_REPOSITORY',
);

export type MembershipReasonCode =
  | 'ACCESS_REQUEST'
  | 'ACCESS_REVIEW'
  | 'INVITATION_CANCELLED'
  | 'SECURITY_INCIDENT';

export type OrganizationMembershipCommand =
  | {
      command: 'INVITE';
      email: string;
      reasonCode: 'ACCESS_REQUEST' | 'ACCESS_REVIEW';
    }
  | {
      command: 'RESEND';
      invitationId: string;
      expectedMembershipVersion?: number;
      expectedInvitationVersion: number;
      reasonCode: 'ACCESS_REQUEST' | 'ACCESS_REVIEW';
    }
  | {
      command: 'CANCEL';
      invitationId: string;
      expectedMembershipVersion?: number;
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

export type PlatformInvitationCommand = Exclude<
  OrganizationMembershipCommand,
  { command: 'SUSPEND' }
>;

export interface PlatformInvitationCommandInput {
  actorUserId: string;
  organizationId: string;
  idempotencyKey: string;
  command: PlatformInvitationCommand;
  now: Date;
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

export interface OrganizationMembershipCommandRepository {
  hasPermission(
    this: void,
    organizationId: string,
    actorUserId: string,
    permission:
      'organization.memberships.read' | 'organization.memberships.manage',
  ): Promise<boolean>;
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
