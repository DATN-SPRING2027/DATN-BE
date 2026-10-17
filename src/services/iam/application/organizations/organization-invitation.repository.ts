export const ORGANIZATION_INVITATION_REPOSITORY = Symbol(
  'ORGANIZATION_INVITATION_REPOSITORY',
);

export type RecipientInvitationStatus =
  'PENDING' | 'ACCEPTED' | 'CANCELLED' | 'EXPIRED' | 'SUPERSEDED';

export interface RecipientInvitation {
  id: string;
  membershipId: string;
  organizationId: string;
  status: RecipientInvitationStatus;
  version: number;
  expiresAt: string;
  createdAt: string;
  membershipVersion: number;
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
  membership: {
    id: string;
    status: 'PENDING_INVITE' | 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
    version: number;
  };
  invitation: RecipientInvitation;
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
}
