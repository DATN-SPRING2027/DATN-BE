export const ORGANIZATION_INVITATION_REPOSITORY = Symbol(
  'ORGANIZATION_INVITATION_REPOSITORY',
);

export type RecipientInvitationStatus =
  'PENDING' | 'ACCEPTED' | 'CANCELLED' | 'EXPIRED' | 'SUPERSEDED';

export interface RecipientInvitation {
  id: string;
  organizationId: string;
  status: RecipientInvitationStatus;
  version: number;
  expiresAt: string;
  createdAt: string;
  invitedEmail: string;
  organizationName: string;
}

export interface RecipientInvitationPage {
  data: RecipientInvitation[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

export interface RecipientInvitationDetail {
  invitation: RecipientInvitation;
}

export type InvitationResolution = RecipientInvitationDetail;

export interface AcceptInvitationAcknowledgement {
  operationId: string;
  membership: {
    id: string;
    organizationId: string;
    userId: string;
    status: 'ACTIVE' | 'SUSPENDED';
    version: number;
  };
  invitation: {
    id: string;
    status: 'ACCEPTED';
    version: number;
    expiresAt: string;
  };
}

export interface AcceptInvitationResult {
  acknowledgement: AcceptInvitationAcknowledgement;
  replayed: boolean;
}

export interface OrganizationInvitationRepository {
  listForRecipient(
    this: void,
    userId: string,
    email: string,
    now: Date,
    page: number,
    pageSize: number,
  ): Promise<RecipientInvitationPage>;
  getForRecipient(
    this: void,
    invitationId: string,
    userId: string,
    email: string,
    now: Date,
  ): Promise<RecipientInvitationDetail | null>;
  resolveByTokenHash(
    this: void,
    tokenHash: string,
    now: Date,
  ): Promise<InvitationResolution | null>;
  acceptForRecipient(
    this: void,
    input: {
      invitationId: string;
      actorUserId: string;
      authenticatedEmail: string;
      expectedMembershipVersion: number;
      expectedInvitationVersion: number;
      readinessReady: boolean;
      idempotencyKey: string;
      now: Date;
    },
  ): Promise<AcceptInvitationResult>;
}
