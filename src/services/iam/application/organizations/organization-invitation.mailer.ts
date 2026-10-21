export const ORGANIZATION_INVITATION_MAILER = Symbol(
  'ORGANIZATION_INVITATION_MAILER',
);

export const ORGANIZATION_INVITATION_DELIVERY_FAILURE_REASONS = [
  'SMTP_CONFIGURATION_INVALID',
  'SMTP_RECIPIENT_REJECTED',
  'SMTP_ACCEPTANCE_UNCONFIRMED',
  'SMTP_TEMPORARY_FAILURE',
  'SMTP_PERMANENT_FAILURE',
  'SMTP_TRANSPORT_FAILURE',
  'SMTP_PROVIDER_ERROR',
  'DELIVERY_INPUT_UNAVAILABLE',
  'DELIVERY_RESULT_INVALID',
] as const;

export type OrganizationInvitationDeliveryFailureReason =
  (typeof ORGANIZATION_INVITATION_DELIVERY_FAILURE_REASONS)[number];

export type OrganizationInvitationDeliveryResult =
  | Readonly<{
      accepted: true;
      provider: 'SMTP';
      providerMessageId: string | null;
      acceptedAt: Date;
    }>
  | Readonly<{
      accepted: false;
      provider: 'SMTP';
      providerMessageId: null;
      acceptedAt: null;
      failureReason: OrganizationInvitationDeliveryFailureReason;
      retryable: boolean;
    }>;

export interface OrganizationInvitationMailer {
  sendOrganizationInvitation(
    this: void,
    input: {
      recipientEmail: string;
      organizationName: string;
      invitationUrl: string;
      expiresAt: Date;
    },
  ): Promise<OrganizationInvitationDeliveryResult>;
}
