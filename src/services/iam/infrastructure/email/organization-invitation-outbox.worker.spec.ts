import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import type {
  OrganizationInvitationDeliveryResult,
  OrganizationInvitationMailer,
} from '../../application/organizations/organization-invitation.mailer';
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
const acceptedAt = new Date('2026-10-20T10:00:00.000Z');

function acceptedResult(): OrganizationInvitationDeliveryResult {
  return {
    accepted: true,
    provider: 'SMTP',
    providerMessageId: '<invitation-1@example.test>',
    acceptedAt,
    rawProviderResponse: '250 accepted invitee@example.test AUTH=secret',
  } as OrganizationInvitationDeliveryResult;
}

function workerFor(
  deliver: (
    message: MailMessage,
  ) => Promise<OrganizationInvitationDeliveryResult>,
) {
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
      return deliver(message);
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
    outbox,
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
    expect(set?.lastError).toBe('SMTP_PROVIDER_ERROR');
    expect(set?.['payload.delivery.nextAttemptAt']).toBeInstanceOf(Date);
    expect(set?.status).toBeUndefined();
    expect(set?.['payload.delivery.receipt']).toBeUndefined();
    expect(unset).toEqual({
      'payload.delivery.leaseId': '',
      'payload.delivery.leaseUntil': '',
    });
    expect(JSON.stringify(update)).not.toContain(token);
  });

  it('sends the fragment-link email then clears the encrypted token from the outbox', async () => {
    const { worker, updates, invitationQueries, sentMessages, outbox } =
      workerFor(() => Promise.resolve(acceptedResult()));

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
    expect(set?.['payload.delivery.receipt']).toEqual({
      accepted: true,
      provider: 'SMTP',
      providerMessageId: '<invitation-1@example.test>',
      acceptedAt,
    });
    expect(unset?.['payload.encryptedToken']).toBe('');
    expect(JSON.stringify(update)).not.toContain(token);
    expect(JSON.stringify(update)).not.toContain('rawProviderResponse');
    expect(JSON.stringify(update)).not.toContain('AUTH=secret');
    expect(outbox.updateOne).toHaveBeenCalledTimes(1);
  });

  it('does not mark a permanently rejected recipient as published', async () => {
    const failureReason = 'SMTP_RECIPIENT_REJECTED';
    const { worker, updates } = workerFor(() =>
      Promise.resolve({
        accepted: false,
        provider: 'SMTP',
        providerMessageId: null,
        acceptedAt: null,
        failureReason,
        retryable: false,
      }),
    );

    await expect(worker.runOnce()).resolves.toBe('FAILED');

    const set = updates[0]?.$set as Record<string, unknown> | undefined;
    const unset = updates[0]?.$unset as Record<string, unknown> | undefined;
    expect(set).toEqual({ status: 'FAILED', lastError: failureReason });
    expect(set?.['payload.delivery.receipt']).toBeUndefined();
    expect(unset).toEqual({
      'payload.encryptedToken': '',
      'payload.delivery.leaseId': '',
      'payload.delivery.leaseUntil': '',
    });
  });

  it('retries a provider rejection only when the provider marks it retryable', async () => {
    const failureReason = 'SMTP_TEMPORARY_FAILURE';
    const { worker, updates } = workerFor(() =>
      Promise.resolve({
        accepted: false,
        provider: 'SMTP',
        providerMessageId: null,
        acceptedAt: null,
        failureReason,
        retryable: true,
      }),
    );

    await expect(worker.runOnce()).resolves.toBe('RETRY');

    const set = updates[0]?.$set as Record<string, unknown> | undefined;
    expect(set?.status).toBeUndefined();
    expect(set?.lastError).toBe(failureReason);
    expect(set?.['payload.delivery.nextAttemptAt']).toBeInstanceOf(Date);
    expect(set?.['payload.delivery.receipt']).toBeUndefined();
  });

  it('fails closed when the mailer returns an invalid delivery result', async () => {
    const { worker, updates } = workerFor(() =>
      Promise.resolve(
        undefined as unknown as OrganizationInvitationDeliveryResult,
      ),
    );

    await expect(worker.runOnce()).resolves.toBe('FAILED');

    const set = updates[0]?.$set as Record<string, unknown> | undefined;
    expect(set).toEqual({
      status: 'FAILED',
      lastError: 'DELIVERY_RESULT_INVALID',
    });
    expect(set?.['payload.delivery.receipt']).toBeUndefined();
  });

  it('does not create another receipt when the published event is replayed', async () => {
    const { worker, updates, sentMessages, outbox } = workerFor(() =>
      Promise.resolve(acceptedResult()),
    );

    await expect(worker.runOnce()).resolves.toBe('SENT');
    outbox.findOneAndUpdate.mockResolvedValueOnce(null);

    await expect(worker.runOnce()).resolves.toBe('IDLE');

    expect(outbox.updateOne).toHaveBeenCalledTimes(1);
    expect(sentMessages).toHaveLength(1);
    expect(
      (updates[0]?.$set as Record<string, unknown>)['payload.delivery.receipt'],
    ).toEqual({
      accepted: true,
      provider: 'SMTP',
      providerMessageId: '<invitation-1@example.test>',
      acceptedAt,
    });
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
    expect(set).toEqual({ status: 'FAILED', lastError: 'SMTP_PROVIDER_ERROR' });
    expect(unset).toEqual({
      'payload.encryptedToken': '',
      'payload.delivery.leaseId': '',
      'payload.delivery.leaseUntil': '',
    });
    expect(JSON.stringify(update)).not.toContain(token);
  });
});
