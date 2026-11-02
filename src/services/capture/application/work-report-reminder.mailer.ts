import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import { createHash } from 'node:crypto';
import { buildWorkReportReminderEmail } from './work-report-reminder.email';

@Injectable()
export class WorkReportReminderMailer {
  constructor(private readonly config: ConfigService) {}

  async send(
    to: string,
    projectId: string,
    dueAt: Date,
    eventKey: string,
    projectName?: string,
  ): Promise<void> {
    const host = this.config.get<string>('SMTP_HOST')?.trim();
    const port = Number(this.config.get<string>('SMTP_PORT'));
    const user = this.config.get<string>('SMTP_USER')?.trim();
    const pass = this.config.get<string>('SMTP_PASS');
    const from = this.config.get<string>('MAIL_FROM')?.trim();
    const secure = this.config.get<string>('SMTP_SECURE')?.trim();
    if (
      !host ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !user ||
      !pass ||
      !from ||
      !['true', 'false'].includes(secure ?? '')
    ) {
      throw new Error('SMTP_CONFIGURATION_INVALID');
    }
    const baseUrl = new URL(
      this.config.get<string>('CONTINUUM_WEB_BASE_URL') ??
        'http://localhost:3000',
    );
    if (!['http:', 'https:'].includes(baseUrl.protocol))
      throw new Error('WEB_URL_INVALID');
    const url = new URL(
      `/projects/${encodeURIComponent(projectId)}/work-reports`,
      baseUrl,
    ).href;
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: secure === 'true',
      requireTLS: secure !== 'true',
      auth: { user, pass },
      tls: { minVersion: 'TLSv1.2' },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    try {
      const info: unknown = await transporter.sendMail({
        from,
        to,
        messageId: `<work-report-reminder-${createHash('sha256').update(eventKey).digest('hex')}@continuum.ai>`,
        ...buildWorkReportReminderEmail(dueAt, url, projectName),
      });
      const receipt = info as { accepted?: unknown[]; rejected?: unknown[] };
      if (!receipt.accepted?.length || receipt.rejected?.length)
        throw new Error('SMTP_RECIPIENT_NOT_ACCEPTED');
    } finally {
      transporter.close();
    }
  }
}
