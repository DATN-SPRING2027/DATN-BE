import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import type { EmailRegistrationMailer } from '../../application/authentication/email-registration.mailer';
import type {
  OrganizationInvitationDeliveryFailureReason,
  OrganizationInvitationDeliveryResult,
  OrganizationInvitationMailer,
} from '../../application/organizations/organization-invitation.mailer';

@Injectable()
export class SmtpEmailRegistrationMailer
  implements EmailRegistrationMailer, OrganizationInvitationMailer
{
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

  async sendOrganizationInvitation(input: {
    recipientEmail: string;
    organizationName: string;
    invitationUrl: string;
    expiresAt: Date;
  }): Promise<OrganizationInvitationDeliveryResult> {
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
      return deliveryFailure('SMTP_CONFIGURATION_INVALID', false);
    }

    let transporter: ReturnType<typeof nodemailer.createTransport> | undefined;
    const safeOrganizationName = escapeHtml(input.organizationName);
    const subjectOrganizationName =
      Array.from(input.organizationName, (character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f ||
          (codePoint >= 0x7f && codePoint <= 0x9f) ||
          codePoint === 0x2028 ||
          codePoint === 0x2029
          ? ' '
          : character;
      })
        .join('')
        .replace(/\s+/g, ' ')
        .trim() || 'your organization';
    const safeUrl = escapeHtml(input.invitationUrl);
    const expiry = input.expiresAt.toISOString();
    try {
      transporter = nodemailer.createTransport({
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
      const info: unknown = await transporter.sendMail({
        from,
        to: input.recipientEmail,
        subject: `Invitation to join ${subjectOrganizationName} on Continuum AI`,
        text: [
          `You have been invited to join ${subjectOrganizationName} on Continuum AI.`,
          `Review and accept this email-bound invitation before ${expiry}: ${input.invitationUrl}`,
          'Sign in with the existing eligible account that matches the invited email address to accept it.',
          'If you were not expecting this invitation, you can ignore this email.',
        ].join('\n\n'),
        html: [
          `<p>You have been invited to join <strong>${safeOrganizationName}</strong> on Continuum AI.</p>`,
          `<p><a href="${safeUrl}">Review invitation</a></p>`,
          `<p>This invitation expires at ${escapeHtml(expiry)}. Sign in with the existing eligible account that matches the invited email address to accept it.</p>`,
          '<p>If you were not expecting this invitation, you can ignore this email.</p>',
        ].join(''),
      });
      if (
        hasRecipient(readSmtpRecipients(info, 'accepted'), input.recipientEmail)
      ) {
        return {
          accepted: true,
          provider: 'SMTP',
          providerMessageId: safeMessageId(readSmtpMessageId(info)),
          acceptedAt: new Date(),
        };
      }
      if (
        hasRecipient(readSmtpRecipients(info, 'rejected'), input.recipientEmail)
      ) {
        return deliveryFailure(
          'SMTP_RECIPIENT_REJECTED',
          !isPermanentResponseCode(readFirstRejectedResponseCode(info)),
        );
      }
      return deliveryFailure('SMTP_ACCEPTANCE_UNCONFIRMED', true);
    } catch (error) {
      const failure = classifySmtpFailure(error);
      return deliveryFailure(failure.reason, failure.retryable);
    } finally {
      try {
        transporter?.close();
      } catch {
        // Cleanup must not override the provider's delivery result.
      }
    }
  }
}

function deliveryFailure(
  failureReason: OrganizationInvitationDeliveryFailureReason,
  retryable: boolean,
): OrganizationInvitationDeliveryResult {
  return {
    accepted: false,
    provider: 'SMTP',
    providerMessageId: null,
    acceptedAt: null,
    failureReason,
    retryable,
  };
}

function hasRecipient(
  recipients: Array<string | { address: string }>,
  email: string,
): boolean {
  const normalizedEmail = email.trim().toLowerCase();
  return recipients.some((recipient) => {
    const address =
      typeof recipient === 'string' ? recipient : recipient.address;
    return address.trim().toLowerCase() === normalizedEmail;
  });
}

function readSmtpRecipients(
  info: unknown,
  key: 'accepted' | 'rejected',
): Array<string | { address: string }> {
  if (!isRecord(info) || !Array.isArray(info[key])) return [];
  const values: unknown[] = info[key];
  const recipients: Array<string | { address: string }> = [];
  for (const recipient of values) {
    if (typeof recipient === 'string') {
      recipients.push(recipient);
      continue;
    }
    if (isRecord(recipient) && typeof recipient.address === 'string') {
      recipients.push({ address: recipient.address });
    }
  }
  return recipients;
}

function readSmtpMessageId(info: unknown): string {
  return isRecord(info) && typeof info.messageId === 'string'
    ? info.messageId
    : '';
}

function readFirstRejectedResponseCode(info: unknown): unknown {
  if (!isRecord(info) || !Array.isArray(info.rejectedErrors)) return undefined;
  const errors: unknown[] = info.rejectedErrors;
  const firstError = errors[0];
  return isRecord(firstError) ? firstError.responseCode : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safeMessageId(value: string): string | null {
  const messageId = value.trim();
  if (
    messageId.length === 0 ||
    messageId.length > 254 ||
    /\p{Cc}/u.test(messageId)
  )
    return null;
  return messageId;
}

function isPermanentResponseCode(value: unknown): boolean {
  return typeof value === 'number' && value >= 500;
}

function classifySmtpFailure(error: unknown): {
  reason: OrganizationInvitationDeliveryFailureReason;
  retryable: boolean;
} {
  const responseCode = readErrorNumber(error, 'responseCode');
  if (responseCode !== undefined && responseCode >= 500)
    return { reason: 'SMTP_PERMANENT_FAILURE', retryable: false };
  if (responseCode !== undefined && responseCode >= 400)
    return { reason: 'SMTP_TEMPORARY_FAILURE', retryable: true };

  const errorCode = readErrorString(error, 'code');
  if (errorCode === 'EAUTH' || errorCode === 'EENVELOPE')
    return { reason: 'SMTP_PERMANENT_FAILURE', retryable: false };
  return { reason: 'SMTP_TRANSPORT_FAILURE', retryable: true };
}

function readErrorNumber(error: unknown, key: string): number | undefined {
  if (typeof error !== 'object' || error === null || !(key in error))
    return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function readErrorString(error: unknown, key: string): string | undefined {
  if (typeof error !== 'object' || error === null || !(key in error))
    return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&#39;');
}
