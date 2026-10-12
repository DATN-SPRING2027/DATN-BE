export const ORGANIZATION_INVITATION_REPOSITORY = Symbol(
  'ORGANIZATION_INVITATION_REPOSITORY',
);

export type InvitationRoleCode = 'ADMIN' | 'TEAM_LEADER' | 'MEMBER';
export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export interface OrganizationInvitation {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  roleCode: InvitationRoleCode;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
}

export interface CreateOrganizationInvitationInput {
  organizationId: string;
  email: string;
  roleCode: InvitationRoleCode;
  invitedBy: string;
  expiresAt: Date;
}

export interface AcceptOrganizationInvitationInput {
  invitationId: string;
  userId: string;
  email: string;
  now: Date;
}

export interface OrganizationInvitationRepository {
  isOrganizationAdmin(
    this: void,
    organizationId: string,
    userId: string,
  ): Promise<boolean>;
  create(
    this: void,
    input: CreateOrganizationInvitationInput,
  ): Promise<OrganizationInvitation>;
  listForOrganization(
    this: void,
    organizationId: string,
    now: Date,
    limit: number,
  ): Promise<OrganizationInvitation[]>;
  listForRecipient(
    this: void,
    email: string,
    now: Date,
    limit: number,
  ): Promise<OrganizationInvitation[]>;
  revoke(
    this: void,
    input: {
      invitationId: string;
      organizationId: string;
      actorUserId: string;
      now: Date;
    },
  ): Promise<boolean>;
  accept(
    this: void,
    input: AcceptOrganizationInvitationInput,
  ): Promise<{ organizationId: string; organizationName: string } | null>;
}
