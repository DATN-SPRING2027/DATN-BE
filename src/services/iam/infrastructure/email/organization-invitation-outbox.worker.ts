import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import {
  ORGANIZATION_INVITATION_MAILER,
  type OrganizationInvitationMailer,
} from '../../application/organizations/organization-invitation.mailer';
import { IAM_PERSISTENCE } from '../persistence';
import { OrganizationInvitationPayloadCipher } from './organization-invitation-payload.cipher';

const EVENT_NAME = 'ORGANIZATION_INVITATION_EMAIL_REQUESTED';
const POLL_INTERVAL_MS = 1_000;
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 5;
const INITIAL_RETRY_MS = 30_000;
const MAX_RETRY_MS = 5 * 60_000;

interface InvitationDeliveryPayload {
  invitationId: string;
  organizationId: string;
  recipientEmail: string;
  tokenHash: string;
  encryptedToken: string;
  delivery?: {
    attemptCount?: number;
    leaseId?: string;
    leaseUntil?: Date;
    nextAttemptAt?: Date;
  };
}

interface InvitationDeliveryEvent {
  _id: Types.ObjectId;
  aggregateId: string;
  payload: InvitationDeliveryPayload;
}

interface InvitationForDelivery {
  expiresAt: Date;
}

@Injectable()
export class OrganizationInvitationOutboxWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(OrganizationInvitationOutboxWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection: Connection,
    private readonly config: ConfigService,
    private readonly cipher: OrganizationInvitationPayloadCipher,
    @Inject(ORGANIZATION_INVITATION_MAILER)
    private readonly mailer: OrganizationInvitationMailer,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.timer.unref();
    void this.poll();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<'IDLE' | 'SENT' | 'RETRY' | 'FAILED'> {
    const now = new Date();
    const leaseId = randomBytes(24).toString('base64url');
    const event = await this.connection
      .collection<InvitationDeliveryEvent>('outbox_events')
      .findOneAndUpdate(
        {
          eventName: EVENT_NAME,
          status: 'PENDING',
          occurredAt: { $lte: now },
          $or: [
            { 'payload.delivery.nextAttemptAt': { $exists: false } },
            { 'payload.delivery.nextAttemptAt': { $lte: now } },
          ],
          $and: [
            {
              $or: [
                { 'payload.delivery.leaseUntil': { $exists: false } },
                { 'payload.delivery.leaseUntil': { $lte: now } },
              ],
            },
          ],
        },
        {
          $set: {
            'payload.delivery.leaseId': leaseId,
            'payload.delivery.leaseUntil': new Date(now.getTime() + LEASE_MS),
          },
          $inc: { 'payload.delivery.attemptCount': 1 },
        },
        { returnDocument: 'after', sort: { occurredAt: 1, _id: 1 } },
      );
    if (!event) return 'IDLE';

    const payload = event.payload;
    if (!isDeliveryPayload(payload)) {
      await this.finishFailed(event._id, leaseId, 'DELIVERY_PAYLOAD_INVALID');
      return 'FAILED';
    }

    const invitation = await this.connection
      .collection<InvitationForDelivery>('organization_invitations')
      .findOne({
        _id: new Types.ObjectId(payload.invitationId),
        organizationId: new Types.ObjectId(payload.organizationId),
        contractVersion: 3,
        tokenHash: payload.tokenHash,
        status: 'PENDING',
        expiresAt: { $gt: now },
      });
    if (!invitation) {
      await this.finishFailed(event._id, leaseId, 'INVITATION_NOT_DELIVERABLE');
      return 'FAILED';
    }

    const organization = await this.connection
      .collection<{ name?: string }>('organizations')
      .findOne(
        { _id: new Types.ObjectId(payload.organizationId) },
        { projection: { name: 1 } },
      );
    if (typeof organization?.name !== 'string' || !organization.name.trim()) {
      await this.scheduleRetry(
        event._id,
        leaseId,
        payload.delivery?.attemptCount ?? 1,
      );
      return 'RETRY';
    }

    try {
      const token = this.cipher.decryptToken(payload.encryptedToken, {
        invitationId: payload.invitationId,
        organizationId: payload.organizationId,
        recipientEmail: payload.recipientEmail,
        tokenHash: payload.tokenHash,
      });
      const invitationUrl = this.createInvitationUrl(token);
      await this.mailer.sendOrganizationInvitation({
        recipientEmail: payload.recipientEmail,
        organizationName: organization.name,
        invitationUrl,
        expiresAt: invitation.expiresAt,
      });
      await this.connection.collection('outbox_events').updateOne(
        {
          _id: event._id,
          eventName: EVENT_NAME,
          status: 'PENDING',
          'payload.delivery.leaseId': leaseId,
        },
        {
          $set: { status: 'PUBLISHED', publishedAt: new Date() },
          $unset: {
            'payload.encryptedToken': '',
            'payload.delivery.leaseId': '',
            'payload.delivery.leaseUntil': '',
            'payload.delivery.nextAttemptAt': '',
          },
        },
      );
      return 'SENT';
    } catch {
      await this.scheduleRetry(
        event._id,
        leaseId,
        payload.delivery?.attemptCount ?? 1,
      );
      return (payload.delivery?.attemptCount ?? 1) >= MAX_ATTEMPTS
        ? 'FAILED'
        : 'RETRY';
    }
  }

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch {
      this.logger.warn('organization_invitation_outbox_poll_failed');
    } finally {
      this.running = false;
    }
  }

  private async scheduleRetry(
    eventId: Types.ObjectId,
    leaseId: string,
    attemptCount: number,
  ): Promise<void> {
    const terminal = attemptCount >= MAX_ATTEMPTS;
    const delay = Math.min(
      INITIAL_RETRY_MS * 2 ** Math.max(0, attemptCount - 1),
      MAX_RETRY_MS,
    );
    await this.connection.collection('outbox_events').updateOne(
      {
        _id: eventId,
        eventName: EVENT_NAME,
        status: 'PENDING',
        'payload.delivery.leaseId': leaseId,
      },
      {
        ...(terminal
          ? { $set: { status: 'FAILED', lastError: 'DELIVERY_FAILED' } }
          : {
              $set: {
                lastError: 'DELIVERY_FAILED',
                'payload.delivery.nextAttemptAt': new Date(Date.now() + delay),
              },
            }),
        $unset: {
          ...(terminal ? { 'payload.encryptedToken': '' } : {}),
          'payload.delivery.leaseId': '',
          'payload.delivery.leaseUntil': '',
        },
      },
    );
    this.logger.warn(
      terminal
        ? 'organization_invitation_delivery_exhausted'
        : 'organization_invitation_delivery_retry_scheduled',
    );
  }

  private async finishFailed(
    eventId: Types.ObjectId,
    leaseId: string,
    errorCode: string,
  ): Promise<void> {
    await this.connection.collection('outbox_events').updateOne(
      {
        _id: eventId,
        eventName: EVENT_NAME,
        status: 'PENDING',
        'payload.delivery.leaseId': leaseId,
      },
      {
        $set: { status: 'FAILED', lastError: errorCode },
        $unset: {
          'payload.encryptedToken': '',
          'payload.delivery.leaseId': '',
          'payload.delivery.leaseUntil': '',
        },
      },
    );
  }

  private createInvitationUrl(token: string): string {
    const configured = this.config.get<string>('WEB_APP_URL')?.trim();
    if (!configured) throw new Error('WEB_APP_URL_UNAVAILABLE');
    const url = new URL('/organization/invitations', configured);
    if (
      url.protocol !== 'https:' &&
      url.hostname !== 'localhost' &&
      url.hostname !== '127.0.0.1'
    )
      throw new Error('WEB_APP_URL_INVALID');
    url.hash = token;
    return url.toString();
  }
}

function isDeliveryPayload(value: unknown): value is InvitationDeliveryPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Partial<InvitationDeliveryPayload>;
  return (
    typeof payload.invitationId === 'string' &&
    /^[a-f\d]{24}$/i.test(payload.invitationId) &&
    typeof payload.organizationId === 'string' &&
    /^[a-f\d]{24}$/i.test(payload.organizationId) &&
    typeof payload.recipientEmail === 'string' &&
    payload.recipientEmail.length <= 254 &&
    typeof payload.tokenHash === 'string' &&
    /^[a-f\d]{64}$/.test(payload.tokenHash) &&
    typeof payload.encryptedToken === 'string' &&
    payload.encryptedToken.length <= 4096
  );
}
