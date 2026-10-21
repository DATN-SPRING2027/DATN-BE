import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import { SmtpEmailRegistrationMailer } from './smtp-email-registration.mailer';

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn() },
}));

describe('SmtpEmailRegistrationMailer organization invitations', () => {
  const sendMail = jest.fn().mockResolvedValue({
    accepted: ['invitee@example.test'],
    rejected: [],
    messageId: '<invitation-1@example.test>',
    response: '250 2.0.0 accepted invitee@example.test',
  });
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

    const result = await mailer.sendOrganizationInvitation({
      recipientEmail: 'invitee@example.test',
      organizationName: 'Alpha\r\nBcc: attacker@example.test\u2028Newsletter',
      invitationUrl:
        'https://continuum.example.test/organization/invitations#opaque',
      expiresAt: new Date('2026-10-28T00:00:00.000Z'),
    });

    const mailCalls = sendMail.mock.calls as unknown as Array<
      [{ subject: string; text: string; html: string }]
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
    expect(message.text).toContain(
      'Sign in with the existing eligible account that matches the invited email address',
    );
    expect(message.html).toContain(
      'Sign in with the existing eligible account that matches the invited email address',
    );
    expect(message.html).not.toMatch(/register|create an account/i);
    expect(result).toMatchObject({
      accepted: true,
      provider: 'SMTP',
      providerMessageId: '<invitation-1@example.test>',
    });
    expect(result.acceptedAt).toBeInstanceOf(Date);
    expect(Object.keys(result).sort()).toEqual(
      ['accepted', 'acceptedAt', 'provider', 'providerMessageId'].sort(),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('classifies permanent SMTP recipient rejection without exposing provider text', async () => {
    sendMail.mockResolvedValue({
      accepted: [],
      rejected: ['invitee@example.test'],
      rejectedErrors: [
        Object.assign(new Error('550 invitee@example.test; AUTH=secret'), {
          responseCode: 550,
          response: '550 invitee@example.test; AUTH=secret',
        }),
      ],
      messageId: '<invitation-1@example.test>',
      response: '550 invitee@example.test; AUTH=secret',
    });
    const mailer = createMailer();

    const result = await mailer.sendOrganizationInvitation(invitationInput());

    expect(result).toEqual({
      accepted: false,
      provider: 'SMTP',
      providerMessageId: null,
      acceptedAt: null,
      failureReason: 'SMTP_RECIPIENT_REJECTED',
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain('invitee@example.test');
    expect(JSON.stringify(result)).not.toContain('AUTH=secret');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('preserves SMTP acceptance if transporter cleanup throws', async () => {
    sendMail.mockResolvedValue({
      accepted: ['invitee@example.test'],
      rejected: [],
      messageId: '<invitation-1@example.test>',
    });
    close.mockImplementationOnce(() => {
      throw new Error('cleanup failure AUTH=secret');
    });
    const mailer = createMailer();

    await expect(
      mailer.sendOrganizationInvitation(invitationInput()),
    ).resolves.toMatchObject({
      accepted: true,
      provider: 'SMTP',
      providerMessageId: '<invitation-1@example.test>',
    });
  });

  it('classifies temporary SMTP recipient rejection as retryable', async () => {
    sendMail.mockResolvedValue({
      accepted: [],
      rejected: ['invitee@example.test'],
      rejectedErrors: [
        Object.assign(new Error('451 temporary failure'), {
          responseCode: 451,
        }),
      ],
      messageId: '<invitation-1@example.test>',
      response: '451 temporary failure',
    });
    const mailer = createMailer();

    await expect(
      mailer.sendOrganizationInvitation(invitationInput()),
    ).resolves.toMatchObject({
      accepted: false,
      provider: 'SMTP',
      failureReason: 'SMTP_RECIPIENT_REJECTED',
      retryable: true,
    });
  });

  it('returns a safe retryable result when SMTP throws', async () => {
    sendMail.mockRejectedValue(
      Object.assign(new Error('connection details containing AUTH=secret'), {
        code: 'ECONNECTION',
      }),
    );
    const mailer = createMailer();

    const result = await mailer.sendOrganizationInvitation(invitationInput());

    expect(result).toEqual({
      accepted: false,
      provider: 'SMTP',
      providerMessageId: null,
      acceptedAt: null,
      failureReason: 'SMTP_TRANSPORT_FAILURE',
      retryable: true,
    });
    expect(JSON.stringify(result)).not.toContain('AUTH=secret');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reports missing SMTP configuration as a permanent safe failure', async () => {
    const mailer = new SmtpEmailRegistrationMailer(new ConfigService({}));

    await expect(
      mailer.sendOrganizationInvitation(invitationInput()),
    ).resolves.toEqual({
      accepted: false,
      provider: 'SMTP',
      providerMessageId: null,
      acceptedAt: null,
      failureReason: 'SMTP_CONFIGURATION_INVALID',
      retryable: false,
    });
    expect(sendMail).not.toHaveBeenCalled();
  });
});

function createMailer(): SmtpEmailRegistrationMailer {
  return new SmtpEmailRegistrationMailer(
    new ConfigService({
      SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: '587',
      SMTP_USER: 'mailer',
      SMTP_PASS: 'test-password',
      MAIL_FROM: 'Continuum <mail@example.test>',
      SMTP_SECURE: 'false',
    }),
  );
}

function invitationInput() {
  return {
    recipientEmail: 'invitee@example.test',
    organizationName: 'Continuum',
    invitationUrl:
      'https://continuum.example.test/organization/invitations#opaque',
    expiresAt: new Date('2026-10-28T00:00:00.000Z'),
  };
}
