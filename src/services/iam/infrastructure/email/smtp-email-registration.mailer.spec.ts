import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import { SmtpEmailRegistrationMailer } from './smtp-email-registration.mailer';

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn() },
}));

describe('SmtpEmailRegistrationMailer organization invitations', () => {
  const sendMail = jest.fn().mockResolvedValue(undefined);
  const close = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (nodemailer.createTransport as unknown as jest.Mock).mockReturnValue({
      sendMail,
      close,
    });
  });

  it('removes header control characters from organization names in the subject', async () => {
    const mailer = new SmtpEmailRegistrationMailer(
      new ConfigService({
        SMTP_HOST: 'smtp.example.test',
        SMTP_PORT: '587',
        SMTP_USER: 'mailer',
        SMTP_PASS: 'test-password',
        MAIL_FROM: 'Continuum <mail@example.test>',
        SMTP_SECURE: 'false',
      }),
    );

    await mailer.sendOrganizationInvitation({
      recipientEmail: 'invitee@example.test',
      organizationName: 'Alpha\r\nBcc: attacker@example.test\u2028Newsletter',
      invitationUrl:
        'https://continuum.example.test/organization/invitations#opaque',
      expiresAt: new Date('2026-10-28T00:00:00.000Z'),
    });

    const mailCalls = sendMail.mock.calls as unknown as Array<
      [{ subject: string; text: string }]
    >;
    const message = mailCalls[0]?.[0];
    expect(message.subject).toBe(
      'Invitation to join Alpha Bcc: attacker@example.test Newsletter on Continuum AI',
    );
    expect(
      Array.from(message.subject).every((character) => {
        const code = character.charCodeAt(0);
        return !(
          code <= 0x1f ||
          (code >= 0x7f && code <= 0x9f) ||
          code === 0x2028 ||
          code === 0x2029
        );
      }),
    ).toBe(true);
    expect(message.text).toContain(
      'You have been invited to join Alpha Bcc: attacker@example.test Newsletter on Continuum AI.',
    );
    expect(message.text).not.toContain(
      'attacker@example.test\nNewsletter on Continuum AI',
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});
