export const PASSWORD_RESET_MAILER = Symbol('PASSWORD_RESET_MAILER');

export interface PasswordResetMailer {
  sendPasswordResetEmail(
    this: void,
    recipientEmail: string,
    resetUrl: string,
  ): Promise<void>;
}
