export const EMAIL_REGISTRATION_MAILER = Symbol('EMAIL_REGISTRATION_MAILER');

export interface EmailRegistrationMailer {
  sendEmailRegistrationLink(
    this: void,
    recipientEmail: string,
    verificationUrl: string,
  ): Promise<void>;
}
