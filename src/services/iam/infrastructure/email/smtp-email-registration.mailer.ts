import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import type { EmailRegistrationMailer } from '../../application/authentication/email-registration.mailer';

@Injectable()
export class SmtpEmailRegistrationMailer implements EmailRegistrationMailer {
  constructor(private readonly config: ConfigService) {}

  async sendEmailRegistrationLink(
    recipientEmail: string,
    verificationUrl: string,
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
        subject: 'Verify your Continuum AI email',
        text: [
          'We received a request to create a Continuum AI account with this email address.',
          `Choose a password using this link within 30 minutes: ${verificationUrl}`,
          'If you did not make this request, you can ignore this email.',
        ].join('\n\n'),
        html: [
          '<p>We received a request to create a Continuum AI account with this email address.</p>',
          `<p><a href="${escapeHtml(verificationUrl)}">Verify your email and choose a password</a></p>`,
          '<p>This link expires in 30 minutes. If you did not make this request, you can ignore this email.</p>',
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
