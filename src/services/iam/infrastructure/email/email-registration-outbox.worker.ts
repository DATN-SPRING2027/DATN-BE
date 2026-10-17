import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  EMAIL_REGISTRATION_OUTBOX,
  type EmailRegistrationOutboxStore,
} from '../../application/authentication/email-registration.store';
import {
  EMAIL_REGISTRATION_MAILER,
  type EmailRegistrationMailer,
} from '../../application/authentication/email-registration.mailer';

const POLL_INTERVAL_MS = 1000;
const EMAIL_LEASE_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const MAX_POLL_RETRY_DELAY_MS = 30_000;

@Injectable()
export class EmailRegistrationOutboxWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(EmailRegistrationOutboxWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private pollRetryDelayMs = 1000;
  private retryPollAt = 0;

  constructor(
    @Inject(EMAIL_REGISTRATION_OUTBOX)
    private readonly outbox: EmailRegistrationOutboxStore,
    @Inject(EMAIL_REGISTRATION_MAILER)
    private readonly mailer: EmailRegistrationMailer,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.timer.unref();
    void this.poll();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    if (this.running || Date.now() < this.retryPollAt) return;
    this.running = true;
    try {
      const now = new Date();
      const leaseId = randomBytes(24).toString('base64url');
      await this.outbox.assertReady();
      await this.outbox.failExhaustedEmailRegistrationEmails(
        now,
        MAX_DELIVERY_ATTEMPTS,
        'DELIVERY_FAILED',
      );
      const job = await this.outbox.claimNextEmailRegistrationEmail(
        now,
        leaseId,
        new Date(now.getTime() + EMAIL_LEASE_MS),
      );
      this.pollRetryDelayMs = 1000;
      this.retryPollAt = 0;
      if (!job) return;

      try {
        const payload = this.outbox.decryptEmailRegistrationPayload(
          job.encryptedPayload,
          { normalizedEmail: job.normalizedEmail, tokenHash: job.tokenHash },
        );
        await this.mailer.sendEmailRegistrationLink(
          payload.recipientEmail,
          payload.verificationUrl,
        );
        const recorded = await this.outbox.markEmailRegistrationEmailSent(
          job.tokenHash,
          job.leaseId,
          new Date(),
        );
        if (!recorded) this.logger.warn('email_registration_sent_unrecorded');
      } catch {
        const delay = Math.min(
          INITIAL_RETRY_DELAY_MS * 2 ** Math.max(0, job.attemptCount - 1),
          MAX_RETRY_DELAY_MS,
        );
        const outcome = await this.outbox.retryEmailRegistrationEmail(
          job.tokenHash,
          job.leaseId,
          new Date(Date.now() + delay),
          MAX_DELIVERY_ATTEMPTS,
          'DELIVERY_FAILED',
        );
        this.logger.warn(
          outcome === 'FAILED'
            ? 'email_registration_delivery_exhausted'
            : 'email_registration_delivery_retry_scheduled',
        );
      }
    } catch {
      this.retryPollAt = Date.now() + this.pollRetryDelayMs;
      this.pollRetryDelayMs = Math.min(
        this.pollRetryDelayMs * 2,
        MAX_POLL_RETRY_DELAY_MS,
      );
      this.logger.warn('email_registration_outbox_poll_failed');
    } finally {
      this.running = false;
    }
  }
}
