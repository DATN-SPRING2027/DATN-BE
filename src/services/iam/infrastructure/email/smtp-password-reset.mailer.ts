import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import type { PasswordResetMailer } from '../../application/authentication/password-reset.mailer';

@Injectable()
export class SmtpPasswordResetMailer implements PasswordResetMailer {
  constructor(private readonly config: ConfigService) {}

  async sendPasswordResetEmail(
    recipientEmail: string,
    resetUrl: string,
  ): Promise<void> {
    const host = this.config.get<string>('SMTP_HOST')?.trim();
    const port = Number(this.config.get<string>('SMTP_PORT'));
    const user = this.config.get<string>('SMTP_USER')?.trim();
    const password = this.config.get<string>('SMTP_PASS');
    const from = this.config.get<string>('MAIL_FROM')?.trim();
    const secureValue = this.config.get<string>('SMTP_SECURE')?.trim();
    if (
      !host ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !user ||
      !password ||
      !from ||
      !['true', 'false'].includes(secureValue ?? '')
    ) {
      throw new Error('SMTP_CONFIGURATION_INVALID');
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: secureValue === 'true',
      requireTLS: secureValue !== 'true',
      auth: { user, pass: password },
      tls: { minVersion: 'TLSv1.2' },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

    try {
      await transporter.sendMail({
        from,
        to: recipientEmail,
        subject: 'Reset your Continuum AI password',
        text: [
          'We received a request to reset your Continuum AI password.',
          `Use this link within 30 minutes: ${resetUrl}`,
          'If you did not request this, you can ignore this email.',
        ].join('\n\n'),
        html: [
          '<p>We received a request to reset your Continuum AI password.</p>',
          `<p><a href="${escapeHtml(resetUrl)}">Reset your password</a></p>`,
          '<p>This link expires in 30 minutes. If you did not request this, you can ignore this email.</p>',
        ].join(''),
      });
    } finally {
      transporter.close();
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&#39;');
}
