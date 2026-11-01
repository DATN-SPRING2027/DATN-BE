import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import { WorkReportReminderMailer } from './work-report-reminder.mailer';

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn() },
}));
describe('Work Report reminder SMTP delivery', () => {
  const sendMail = jest.fn();
  const close = jest.fn();
  const config = {
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: '587',
    SMTP_USER: 'test-user',
    SMTP_PASS: 'test-password',
    MAIL_FROM: 'Continuum <noreply@example.test>',
    SMTP_SECURE: 'false',
    CONTINUUM_WEB_BASE_URL: 'https://app.example.test',
  };
  beforeEach(() => {
    jest.clearAllMocks();
    sendMail.mockResolvedValue({
      accepted: ['member@example.test'],
      rejected: [],
    });
    jest
      .mocked(nodemailer.createTransport)
      .mockReturnValue({ sendMail, close } as never);
  });
  it('uses TLS and stable message IDs, and includes a report link and English deadline in Vietnam time and an escaped project name', async () => {
    const mailer = new WorkReportReminderMailer(new ConfigService(config));
    await mailer.send(
      'member@example.test',
      'project-1',
      new Date('2026-10-30T12:00:00Z'),
      'reminder-event-1',
      'Đồ án <Kỳ 8>',
    );
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        requireTLS: true,
        tls: { minVersion: 'TLSv1.2' },
      }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'member@example.test',
        messageId: `<work-report-reminder-${createHash('sha256').update('reminder-event-1').digest('hex')}@continuum.ai>`,
      }),
    );
    const calls = sendMail.mock.calls as unknown as Array<
      [{ text: string; html: string; subject: string }]
    >;
    const sent = calls[0][0];
    expect(sent.text).toContain(
      'https://app.example.test/projects/project-1/work-reports',
    );
    expect(sent.text).toContain('19:00');
    expect(sent.text).toContain('30 October 2026');
    expect(sent.text).toContain('UTC+7');
    expect(sent.text).not.toContain('2026-10-30T12:00:00.000Z');
    expect(sent.html).toContain('Đồ án &lt;Kỳ 8&gt;');
    expect(sent.html).not.toContain('Đồ án <Kỳ 8>');
    expect(sent.html).toContain('View Work Report');
    expect(sent.subject).toContain('Đồ án <Kỳ 8>');
    expect(close).toHaveBeenCalled();
  });
  it('rejects missing SMTP configuration without attempting delivery', async () => {
    const mailer = new WorkReportReminderMailer(new ConfigService({}));
    await expect(
      mailer.send('member@example.test', 'project-1', new Date(), 'event'),
    ).rejects.toThrow('SMTP_CONFIGURATION_INVALID');
    expect(sendMail).not.toHaveBeenCalled();
  });
  it('does not mark a rejected recipient as delivered and closes transport on error', async () => {
    sendMail.mockResolvedValue({
      accepted: [],
      rejected: ['member@example.test'],
    });
    const mailer = new WorkReportReminderMailer(new ConfigService(config));
    await expect(
      mailer.send('member@example.test', 'project-1', new Date(), 'event'),
    ).rejects.toThrow('SMTP_RECIPIENT_NOT_ACCEPTED');
    expect(close).toHaveBeenCalled();
  });
});
