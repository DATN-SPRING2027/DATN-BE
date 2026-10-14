import type { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import { SmtpPasswordResetMailer } from './smtp-password-reset.mailer';

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn() },
}));

describe('SmtpPasswordResetMailer', () => {
  const sendMail = jest.fn();
  const close = jest.fn();
  const createTransport = jest.mocked(nodemailer.createTransport);

  beforeEach(() => {
    jest.clearAllMocks();
    sendMail.mockResolvedValue({ messageId: 'fixture' });
    close.mockReturnValue(undefined);
    createTransport.mockReturnValue({ sendMail, close } as never);
  });

  it('sends through authenticated SMTP with TLS and the configured sender', async () => {
    const config = configFor({
      SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: '587',
      SMTP_USER: 'mailbox@example.test',
      SMTP_PASS: 'fixture-value',
      SMTP_SECURE: 'false',
      MAIL_FROM: 'Continuum AI <mailbox@example.test>',
    });
    const mailer = new SmtpPasswordResetMailer(config);

    await mailer.sendPasswordResetEmail(
      'person@example.test',
      'https://app.example.test/reset-password#token=opaque-token',
    );

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.test',
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: 'mailbox@example.test', pass: 'fixture-value' },
        tls: { minVersion: 'TLSv1.2' },
      }),
    );
    expect(sendMail).toHaveBeenCalledTimes(1);
    const calls = sendMail.mock.calls as unknown as unknown[][];
    const [firstCall] = calls;
    const [rawMessage] = firstCall;
    const message = rawMessage as {
      from: string;
      to: string;
      subject: string;
      text: string;
      html: string;
    };
    expect(message).toMatchObject({
      from: 'Continuum AI <mailbox@example.test>',
      to: 'person@example.test',
      subject: 'Reset your Continuum AI password',
    });
    expect(message.text).toContain('opaque-token');
    expect(message.html).toContain('opaque-token');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not create a transport when SMTP configuration is incomplete', async () => {
    const mailer = new SmtpPasswordResetMailer(configFor({ SMTP_PASS: '' }));

    await expect(
      mailer.sendPasswordResetEmail(
        'person@example.test',
        'https://app.example.test/reset-password#token=opaque-token',
      ),
    ).rejects.toThrow('SMTP_CONFIGURATION_INVALID');
    expect(createTransport).not.toHaveBeenCalled();
  });
});

function configFor(values: Record<string, string>): ConfigService {
  return {
    get: (name: string) => values[name],
  } as unknown as ConfigService;
}
