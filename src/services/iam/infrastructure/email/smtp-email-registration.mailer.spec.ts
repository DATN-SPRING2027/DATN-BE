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
      organizationName: 'Alpha\r\nBcc: attacker@example.test',
      invitationUrl: 'https://continuum.example.test/organization/invitations#opaque',
      expiresAt: new Date('2026-10-28T00:00:00.000Z'),
    });

    const message = sendMail.mock.calls[0]?.[0] as { subject: string };
    expect(message.subject).toBe(
      'Invitation to join Alpha Bcc: attacker@example.test on Continuum AI',
    );
    expect(message.subject).not.toMatch(/[\r\n\u0000-\u001f\u007f-\u009f]/);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
