import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import type { OrganizationInvitationMailer } from '../../application/organizations/organization-invitation.mailer';
import { OrganizationInvitationPayloadCipher } from './organization-invitation-payload.cipher';
import { OrganizationInvitationOutboxWorker } from './organization-invitation-outbox.worker';

const invitationId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d1f');
const organizationId = new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d1f');
const eventId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d1f');
const token = 'a'.repeat(43);
const recipientEmail = 'invitee@example.test';
const tokenHash = createHash('sha256').update(token).digest('hex');
const binding = {
  invitationId: invitationId.toHexString(),
  organizationId: organizationId.toHexString(),
  recipientEmail,
  tokenHash,
};
type MailMessage = Parameters<
  OrganizationInvitationMailer['sendOrganizationInvitation']
>[0];

function workerFor(deliver: (message: MailMessage) => Promise<void>) {
  const event = {
    _id: eventId,
    aggregateId: invitationId.toHexString(),
    payload: {
      ...binding,
      encryptedToken: new OrganizationInvitationPayloadCipher(
        new ConfigService({ JWT_SECRET: 'test-secret-'.repeat(4) }),
      ).encryptToken(token, binding),
      delivery: { attemptCount: 1 },
    },
  };
  const updates: Array<Record<string, unknown>> = [];
  const invitationQueries: Array<Record<string, unknown>> = [];
  const sentMessages: MailMessage[] = [];
  const outbox = {
    findOneAndUpdate: jest.fn().mockResolvedValue(event),
    updateOne: jest.fn((_filter: unknown, update: Record<string, unknown>) => {
      updates.push(update);
      return Promise.resolve({ matchedCount: 1 });
    }),
  };
  const invitations = {
    findOne: jest.fn((filter: Record<string, unknown>) => {
      invitationQueries.push(filter);
      return Promise.resolve({
        expiresAt: new Date('2026-10-21T00:00:00.000Z'),
      });
    }),
  };
  const organizations = {
    findOne: jest.fn().mockResolvedValue({ name: 'Continuum' }),
  };
  const collections: Record<string, unknown> = {
    outbox_events: outbox,
    organization_invitations: invitations,
    organizations,
  };
  const connection = {
    collection: jest.fn((name: string) => collections[name]),
  } as unknown as Connection;
  const config = new ConfigService({
    JWT_SECRET: 'test-secret-'.repeat(4),
    WEB_APP_URL: 'https://continuum.example.test',
  });
  const cipher = new OrganizationInvitationPayloadCipher(config);
  const mailer: OrganizationInvitationMailer = {
    async sendOrganizationInvitation(message) {
      sentMessages.push(message);
      await deliver(message);
    },
  };
  return {
    worker: new OrganizationInvitationOutboxWorker(
      connection,
      config,
      cipher,
      mailer,
    ),
    updates,
    invitationQueries,
    sentMessages,
    event,
  };
}

describe('OrganizationInvitationOutboxWorker', () => {
  it('keeps delivery retryable when the email provider is unavailable', async () => {
    const { worker, updates } = workerFor(() =>
      Promise.reject(new Error('smtp')),
    );

    await expect(worker.runOnce()).resolves.toBe('RETRY');

    const update = updates[0];
    const set = update?.$set as Record<string, unknown> | undefined;
    const unset = update?.$unset as Record<string, unknown> | undefined;
    expect(set?.lastError).toBe('DELIVERY_FAILED');
    expect(set?.['payload.delivery.nextAttemptAt']).toBeInstanceOf(Date);
    expect(set?.status).toBeUndefined();
    expect(unset).toEqual({
      'payload.delivery.leaseId': '',
      'payload.delivery.leaseUntil': '',
    });
    expect(JSON.stringify(update)).not.toContain(token);
  });

  it('sends the fragment-link email then clears the encrypted token from the outbox', async () => {
    const { worker, updates, invitationQueries, sentMessages } = workerFor(() =>
      Promise.resolve(),
    );

    await expect(worker.runOnce()).resolves.toBe('SENT');

    expect(invitationQueries[0]).toMatchObject({
      _id: invitationId,
      organizationId,
      contractVersion: 3,
      tokenHash,
      status: 'PENDING',
    });
    const expiry = invitationQueries[0]?.expiresAt as
      Record<string, unknown> | undefined;
    expect(expiry?.$gt).toBeInstanceOf(Date);
    expect(sentMessages).toEqual([
      {
        recipientEmail,
        organizationName: 'Continuum',
        invitationUrl: `https://continuum.example.test/organization/invitations#${token}`,
        expiresAt: new Date('2026-10-21T00:00:00.000Z'),
      },
    ]);
    const update = updates[0];
    const set = update?.$set as Record<string, unknown> | undefined;
    const unset = update?.$unset as Record<string, unknown> | undefined;
    expect(set?.status).toBe('PUBLISHED');
    expect(set?.publishedAt).toBeInstanceOf(Date);
    expect(unset?.['payload.encryptedToken']).toBe('');
    expect(JSON.stringify(update)).not.toContain(token);
  });

  it('clears the encrypted token when delivery retries are exhausted', async () => {
    const { worker, updates, event } = workerFor(() =>
      Promise.reject(new Error('smtp')),
    );
    event.payload.delivery.attemptCount = 5;

    await expect(worker.runOnce()).resolves.toBe('FAILED');

    const update = updates[0];
    const set = update?.$set as Record<string, unknown> | undefined;
    const unset = update?.$unset as Record<string, unknown> | undefined;
    expect(set).toEqual({ status: 'FAILED', lastError: 'DELIVERY_FAILED' });
    expect(unset).toEqual({
      'payload.encryptedToken': '',
      'payload.delivery.leaseId': '',
      'payload.delivery.leaseUntil': '',
    });
    expect(JSON.stringify(update)).not.toContain(token);
  });
});
