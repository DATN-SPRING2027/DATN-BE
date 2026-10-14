import type { Connection } from 'mongoose';
import { PasswordResetPayloadCipher } from '../email/password-reset-payload.cipher';
import { IAM_PERSISTENCE } from '../persistence';
import { MongoPasswordResetOutboxStore } from './password-reset-outbox.store';

describe('MongoPasswordResetOutboxStore', () => {
  type Query = Record<string, unknown>;
  type Update = {
    $set?: Record<string, unknown>;
    $setOnInsert?: Record<string, unknown>;
    $unset?: Record<string, string>;
    $inc?: Record<string, number>;
  };
  const findOneAndUpdate = jest.fn<
    Promise<unknown>,
    [Query, Update, Record<string, unknown>?]
  >();
  const updateOne = jest.fn<
    Promise<{ modifiedCount: number }>,
    [Query, Update]
  >();
  const updateMany = jest.fn<
    Promise<{ modifiedCount: number }>,
    [Query, Update]
  >();
  const deleteOne = jest.fn<Promise<{ deletedCount: number }>, [Query]>();
  const findOne = jest.fn<
    Promise<Record<string, unknown> | null>,
    [Query, Record<string, unknown>?]
  >();
  const indexes = jest.fn();
  const collection = {
    findOneAndUpdate,
    updateOne,
    updateMany,
    deleteOne,
    findOne,
    indexes,
  };
  const db = { collection: jest.fn(() => collection) };
  const cipher = {
    assertReady: jest.fn(),
    encrypt: jest.fn().mockReturnValue('v1.encrypted'),
    decrypt: jest.fn(),
  };
  let store: MongoPasswordResetOutboxStore;

  beforeEach(() => {
    jest.clearAllMocks();
    findOneAndUpdate.mockResolvedValue(null);
    updateOne.mockResolvedValue({ modifiedCount: 1 });
    updateMany.mockResolvedValue({ modifiedCount: 1 });
    deleteOne.mockResolvedValue({ deletedCount: 1 });
    findOne.mockResolvedValue(null);
    const indexDefinitions = IAM_PERSISTENCE.collections.find(
      (item) => item.name === 'password_reset_outbox',
    )?.indexes;
    indexes.mockResolvedValue(
      (indexDefinitions ?? []).map((index) => ({
        name: index.options?.name,
        key: index.fields,
        ...(index.options ?? {}),
      })),
    );
    store = new MongoPasswordResetOutboxStore(
      { db } as unknown as Connection,
      cipher as unknown as PasswordResetPayloadCipher,
    );
  });

  it('requires exact persisted indexes before accepting reset work and caches successful verification', async () => {
    await expect(store.assertReady()).resolves.toBeUndefined();
    await expect(store.assertReady()).resolves.toBeUndefined();
    expect(indexes).toHaveBeenCalledTimes(1);
    expect(cipher.assertReady).toHaveBeenCalledTimes(2);
  });

  it('fails closed without migration indexes and retries readiness checks', async () => {
    indexes.mockResolvedValueOnce([{ name: '_id_', key: { _id: 1 } }]);

    await expect(store.assertReady()).rejects.toThrow(
      'PASSWORD_RESET_OUTBOX_INDEXES_UNAVAILABLE',
    );

    await expect(store.assertReady()).resolves.toBeUndefined();
    expect(indexes).toHaveBeenCalledTimes(2);
  });

  it('does not accept a compound index with its fields in the wrong order', async () => {
    const definitions = IAM_PERSISTENCE.collections.find(
      (item) => item.name === 'password_reset_outbox',
    )?.indexes;
    indexes.mockResolvedValueOnce(
      (definitions ?? []).map((definition) => ({
        name: definition.options?.name,
        key:
          definition.options?.name === 'password_reset_pending_jobs'
            ? Object.fromEntries(Object.entries(definition.fields).reverse())
            : definition.fields,
        ...(definition.options ?? {}),
      })),
    );

    await expect(store.assertReady()).rejects.toThrow(
      'PASSWORD_RESET_OUTBOX_INDEXES_UNAVAILABLE',
    );
  });

  it('does not accept a hidden required index', async () => {
    const definitions = IAM_PERSISTENCE.collections.find(
      (item) => item.name === 'password_reset_outbox',
    )?.indexes;
    indexes.mockResolvedValueOnce(
      (definitions ?? []).map((definition) => ({
        name: definition.options?.name,
        key: definition.fields,
        ...(definition.options ?? {}),
        ...(definition.options?.name === 'password_reset_token_hash'
          ? { hidden: true }
          : {}),
      })),
    );

    await expect(store.assertReady()).rejects.toThrow(
      'PASSWORD_RESET_OUTBOX_INDEXES_UNAVAILABLE',
    );
  });

  it('stores the token digest and encrypted email payload in one atomic document update', async () => {
    const input = {
      userScopeHash: 'a'.repeat(64),
      tokenHash: 'b'.repeat(64),
      userId: '651a2b3c4d5e6f7a8b9c0d1e',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      payload: {
        recipientEmail: 'person@example.com',
        resetUrl: 'https://app.example.test/reset-password#token=secret',
      },
    };
    findOneAndUpdate.mockResolvedValue({ ...input, deliveryStatus: 'PENDING' });

    await expect(store.savePasswordResetRequest(input)).resolves.toBe('SAVED');

    expect(cipher.encrypt).toHaveBeenCalledWith(input.payload, {
      userScopeHash: input.userScopeHash,
      userId: input.userId,
      tokenHash: input.tokenHash,
    });
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, options] = findOneAndUpdate.mock.calls[0];
    expect(filter.userScopeHash).toBe(input.userScopeHash);
    const alternatives = filter.$or as Array<Record<string, unknown>>;
    expect(alternatives[0]).toEqual({
      tokenClaimId: { $exists: false },
      leaseId: { $exists: false },
    });
    expect(alternatives[1].tokenClaimId).toEqual({ $exists: false });
    expect(
      (alternatives[1].leaseUntil as Record<string, unknown>).$lte,
    ).toBeInstanceOf(Date);
    expect(
      (alternatives[2].expiresAt as Record<string, unknown>).$lte,
    ).toBeInstanceOf(Date);
    expect(update.$set).toEqual(
      expect.objectContaining({
        tokenHash: input.tokenHash,
        userId: input.userId,
        expiresAt: input.expiresAt,
        deliveryStatus: 'PENDING',
        encryptedPayload: 'v1.encrypted',
      }),
    );
    expect(options).toEqual({ upsert: true, returnDocument: 'after' });
    expect(db.collection).toHaveBeenCalledWith('password_reset_outbox');
  });

  it('does not replace a token while its confirmation claim is active', async () => {
    findOneAndUpdate.mockRejectedValue({ code: 11000 });
    findOne.mockResolvedValue({ _id: 'active-reset' });

    await expect(
      store.savePasswordResetRequest({
        userScopeHash: 'a'.repeat(64),
        tokenHash: 'b'.repeat(64),
        userId: '651a2b3c4d5e6f7a8b9c0d1e',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        payload: {
          recipientEmail: 'person@example.com',
          resetUrl: 'https://app.example.test/reset-password#token=secret',
        },
      }),
    ).resolves.toBe('COALESCED');
    const [query, options] = findOne.mock.calls[0];
    const expiry = query.expiresAt as { $gt?: unknown };
    expect(query.userScopeHash).toBe('a'.repeat(64));
    expect(expiry.$gt).toBeInstanceOf(Date);
    expect(query.deliveryStatus).toEqual({
      $in: ['PENDING', 'SENDING', 'SENT'],
    });
    expect(options).toEqual({ projection: { _id: 1 } });
  });

  it('does not coalesce a duplicate-key failure without a current reset for the same account', async () => {
    findOneAndUpdate.mockRejectedValue({ code: 11000 });

    await expect(
      store.savePasswordResetRequest({
        userScopeHash: 'a'.repeat(64),
        tokenHash: 'b'.repeat(64),
        userId: '651a2b3c4d5e6f7a8b9c0d1e',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        payload: {
          recipientEmail: 'person@example.com',
          resetUrl: 'https://app.example.test/reset-password#token=secret',
        },
      }),
    ).resolves.toBe('NOT_SAVED');
  });

  it('persists a non-delivery marker for inactive or unknown accounts without storing email data', async () => {
    findOneAndUpdate.mockResolvedValue({ deliveryStatus: 'IGNORED' });

    await expect(
      store.savePasswordResetRequest({
        userScopeHash: 'c'.repeat(64),
        tokenHash: 'd'.repeat(64),
        userId: '000000000000000000000000',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      }),
    ).resolves.toBe('SAVED');

    const update = findOneAndUpdate.mock.calls[0][1];
    expect(cipher.encrypt).not.toHaveBeenCalled();
    expect(update.$set?.deliveryStatus).toBe('IGNORED');
    expect(update.$set?.encryptedPayload).toBeNull();
  });

  it('atomically leases a due message and returns the encrypted payload only to the lease owner', async () => {
    findOneAndUpdate.mockResolvedValue({
      userScopeHash: 'a'.repeat(64),
      userId: '651a2b3c4d5e6f7a8b9c0d1e',
      tokenHash: 'b'.repeat(64),
      attemptCount: 1,
      encryptedPayload: 'v1.encrypted',
    });
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 60_000);

    await expect(
      store.claimNextPasswordResetEmail(now, 'lease-id', leaseUntil),
    ).resolves.toEqual({
      userScopeHash: 'a'.repeat(64),
      userId: '651a2b3c4d5e6f7a8b9c0d1e',
      tokenHash: 'b'.repeat(64),
      leaseId: 'lease-id',
      attemptCount: 1,
      encryptedPayload: 'v1.encrypted',
    });
    const query = findOneAndUpdate.mock.calls[0][0];
    const options = findOneAndUpdate.mock.calls[0][2];
    expect(query.$or).toEqual([
      { deliveryStatus: 'PENDING', nextAttemptAt: { $lte: now } },
      { deliveryStatus: 'SENDING', leaseUntil: { $lte: now } },
    ]);
    expect(options?.sort).toEqual({
      nextAttemptAt: 1,
      createdAt: 1,
    });
  });

  it('clears encrypted payload after SMTP success', async () => {
    await expect(
      store.markPasswordResetEmailSent('b'.repeat(64), 'lease-id', new Date()),
    ).resolves.toBe(true);
    expect(updateOne.mock.calls[0][1].$unset).toEqual({
      encryptedPayload: '',
      leaseId: '',
      leaseUntil: '',
    });
  });

  it('marks exhausted delivery retries failed and erases email payload', async () => {
    findOne.mockResolvedValue({ _id: 'row-id', attemptCount: 5 });

    await expect(
      store.retryPasswordResetEmail(
        'b'.repeat(64),
        'lease-id',
        new Date(),
        5,
        'DELIVERY_FAILED',
      ),
    ).resolves.toBe('FAILED');
    expect(updateOne.mock.calls[0][1].$set?.deliveryStatus).toBe('FAILED');
    expect(updateOne.mock.calls[0][1].$unset?.encryptedPayload).toBe('');
  });

  it('fails a final-attempt job whose worker lease expired after a crash', async () => {
    const now = new Date();

    await store.failExhaustedPasswordResetEmails(now, 5, 'DELIVERY_FAILED');

    const [filter, update] = updateMany.mock.calls[0];
    expect(filter).toEqual({
      deliveryStatus: 'SENDING',
      leaseUntil: { $lte: now },
      attemptCount: { $gte: 5 },
    });
    expect(update.$set?.deliveryStatus).toBe('FAILED');
    expect(update.$unset?.encryptedPayload).toBe('');
  });
});
