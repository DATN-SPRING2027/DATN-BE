export const ORGANIZATION_INVITATION_MAILER = Symbol(
  'ORGANIZATION_INVITATION_MAILER',
);

export interface OrganizationInvitationMailer {
  sendOrganizationInvitation(
    this: void,
    input: {
      recipientEmail: string;
      organizationName: string;
      invitationUrl: string;
      expiresAt: Date;
    },
  ): Promise<void>;
}
