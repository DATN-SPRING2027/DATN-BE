import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { ClientSession, Collection, Document } from 'mongodb';
import type { Connection } from 'mongoose';
import { IAM_PERSISTENCE } from '../persistence';
import type {
  EmailRegistrationEmailJob,
  EmailRegistrationEmailPayload,
  EmailRegistrationEmailPayloadBinding,
  EmailRegistrationOutboxStore,
  EmailRegistrationTokenClaim,
} from '../../application/authentication/email-registration.store';
import { EmailRegistrationPayloadCipher } from '../email/email-registration-payload.cipher';

const COLLECTION = 'email_registration_outbox';
const REQUIRED_INDEXES: Array<{
  key: Record<string, 1 | -1>;
  name: string;
  unique?: boolean;
  expireAfterSeconds?: number;
}> = [
  {
    key: { normalizedEmail: 1 },
    name: 'email_registration_current_email',
    unique: true,
  },
  {
    key: { tokenHash: 1 },
    name: 'email_registration_token_hash',
    unique: true,
  },
  {
    key: { expiresAt: 1 },
    name: 'email_registration_expiry',
    expireAfterSeconds: 0,
  },
  {
    key: { deliveryStatus: 1, nextAttemptAt: 1, expiresAt: 1, createdAt: 1 },
    name: 'email_registration_pending_jobs',
  },
  {
    key: { deliveryStatus: 1, leaseUntil: 1, expiresAt: 1, createdAt: 1 },
    name: 'email_registration_expired_leases',
  },
];

interface EmailRegistrationDocument extends Document {
  normalizedEmail: string;
  fullName: string;
  tokenHash: string;
  expiresAt: Date;
  deliveryStatus: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'IGNORED';
  encryptedPayload?: string;
  attemptCount: number;
  nextAttemptAt: Date;
  leaseId?: string;
  leaseUntil?: Date;
  tokenClaimId?: string;
  tokenClaimUntil?: Date;
  lastErrorCode?: string | null;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface UserForRegistration extends Document {
  email: string;
  passwordHash?: string;
  googleSubject?: string;
  fullName: string;
  status: string;
  twoFactorEnabled?: boolean;
}

@Injectable()
export class MongoEmailRegistrationOutboxStore implements EmailRegistrationOutboxStore {
  private indexesReady?: Promise<void>;

  constructor(
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection: Connection,
    private readonly cipher: EmailRegistrationPayloadCipher,
  ) {}

  async assertReady(): Promise<void> {
    this.cipher.assertReady();
    if (!this.indexesReady) this.indexesReady = this.verifyRequiredIndexes();
    try {
      await this.indexesReady;
    } catch (error) {
      this.indexesReady = undefined;
      throw error;
    }
  }

  async saveEmailRegistrationRequest(input: {
    normalizedEmail: string;
    fullName: string;
    tokenHash: string;
    expiresAt: Date;
    payload?: EmailRegistrationEmailPayload;
  }): Promise<boolean> {
    const now = new Date();
    const encryptedPayload = input.payload
      ? this.cipher.encrypt(input.payload, {
          normalizedEmail: input.normalizedEmail,
          tokenHash: input.tokenHash,
        })
      : null;
    const deliveryStatus: EmailRegistrationDocument['deliveryStatus'] =
      input.payload ? 'PENDING' : 'IGNORED';
    const update = {
      $set: {
        fullName: input.fullName,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        deliveryStatus,
        ...(encryptedPayload ? { encryptedPayload } : {}),
        attemptCount: 0,
        nextAttemptAt: now,
        lastErrorCode: input.payload ? null : 'REGISTRATION_NOT_ELIGIBLE',
        updatedAt: now,
      },
      $setOnInsert: { normalizedEmail: input.normalizedEmail, createdAt: now },
      $unset: {
        leaseId: '',
        leaseUntil: '',
        tokenClaimId: '',
        tokenClaimUntil: '',
        sentAt: '',
        ...(!encryptedPayload ? { encryptedPayload: '' } : {}),
      },
    };
    try {
      const row = await this.collection.findOneAndUpdate(
        { normalizedEmail: input.normalizedEmail },
        update,
        { upsert: true, returnDocument: 'after' },
      );
      return row !== null;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const updated = await this.collection.updateOne(
        { normalizedEmail: input.normalizedEmail },
        update,
      );
      return updated.matchedCount === 1;
    }
  }

  async claimEmailRegistrationToken(
    tokenHash: string,
    claimId: string,
    now: Date,
    claimUntil: Date,
  ): Promise<EmailRegistrationTokenClaim | null> {
    const row = await this.collection.findOneAndUpdate(
      {
        tokenHash,
        expiresAt: { $gt: now },
        deliveryStatus: { $nin: ['FAILED', 'IGNORED'] },
        $or: [
          { tokenClaimId: { $exists: false } },
          { tokenClaimUntil: { $lte: now } },
        ],
      },
      {
        $set: {
          tokenClaimId: claimId,
          tokenClaimUntil: claimUntil,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' },
    );
    if (
      !row ||
      typeof row.normalizedEmail !== 'string' ||
      typeof row.fullName !== 'string'
    ) {
      return null;
    }
    return {
      normalizedEmail: row.normalizedEmail,
      fullName: row.fullName,
      tokenHash,
      claimId,
    };
  }

  async completeClaimedEmailRegistration(
    claim: EmailRegistrationTokenClaim,
    passwordHash: string,
    now: Date,
  ): Promise<boolean> {
    let session: ClientSession;
    try {
      session = await this.connection.startSession();
    } catch {
      throw new Error('EMAIL_REGISTRATION_TRANSACTION_UNAVAILABLE');
    }
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let completed = false;
        try {
          await session.withTransaction(async () => {
            const transactionNow = new Date(
              Math.max(Date.now(), now.getTime()),
            );
            const pending = await this.collection.findOne(
              {
                tokenHash: claim.tokenHash,
                normalizedEmail: claim.normalizedEmail,
                tokenClaimId: claim.claimId,
                tokenClaimUntil: { $gt: transactionNow },
                expiresAt: { $gt: transactionNow },
              },
              { session },
            );
            if (!pending) return;

            const users = this.users;
            const existing = await users.findOne(
              { email: pending.normalizedEmail },
              {
                session,
                projection: { status: 1, googleSubject: 1, passwordHash: 1 },
              },
            );
            let accountChanged = false;
            if (!existing) {
              await users.insertOne(
                {
                  email: pending.normalizedEmail,
                  passwordHash,
                  fullName: pending.fullName,
                  status: 'ACTIVE',
                  twoFactorEnabled: false,
                  createdAt: transactionNow,
                  updatedAt: transactionNow,
                },
                { session },
              );
              accountChanged = true;
            } else if (
              existing.status === 'ACTIVE' &&
              typeof existing.googleSubject === 'string' &&
              existing.googleSubject.length > 0 &&
              typeof existing.passwordHash !== 'string'
            ) {
              const linked = await users.updateOne(
                {
                  email: pending.normalizedEmail,
                  status: 'ACTIVE',
                  googleSubject: { $type: 'string' },
                  $or: [
                    { passwordHash: { $exists: false } },
                    { passwordHash: '' },
                  ],
                },
                { $set: { passwordHash, updatedAt: transactionNow } },
                { session },
              );
              accountChanged = linked.modifiedCount === 1;
            }

            const consumed = await this.collection.deleteOne(
              {
                _id: pending._id,
                tokenHash: claim.tokenHash,
                tokenClaimId: claim.claimId,
              },
              { session },
            );
            if (consumed.deletedCount !== 1) {
              throw new Error('EMAIL_REGISTRATION_TOKEN_CONSUME_FAILED');
            }
            completed = accountChanged;
          });
          return completed;
        } catch (error) {
          if (!isDuplicateKeyError(error) || attempt > 0) throw error;
        }
      }
      return false;
    } finally {
      await session.endSession();
    }
  }

  async releaseEmailRegistrationTokenClaim(
    normalizedEmail: string,
    claimId: string,
  ): Promise<void> {
    await this.collection.updateOne(
      { normalizedEmail, tokenClaimId: claimId },
      {
        $unset: { tokenClaimId: '', tokenClaimUntil: '' },
        $set: { updatedAt: new Date() },
      },
    );
  }

  async claimNextEmailRegistrationEmail(
    now: Date,
    leaseId: string,
    leaseUntil: Date,
  ): Promise<EmailRegistrationEmailJob | null> {
    const row = await this.collection.findOneAndUpdate(
      {
        expiresAt: { $gt: now },
        encryptedPayload: { $type: 'string' },
        $or: [
          { deliveryStatus: 'PENDING', nextAttemptAt: { $lte: now } },
          { deliveryStatus: 'SENDING', leaseUntil: { $lte: now } },
        ],
      },
      {
        $set: {
          deliveryStatus: 'SENDING',
          leaseId,
          leaseUntil,
          updatedAt: now,
        },
        $inc: { attemptCount: 1 },
      },
      { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: 'after' },
    );
    if (
      !row ||
      typeof row.normalizedEmail !== 'string' ||
      typeof row.tokenHash !== 'string' ||
      typeof row.encryptedPayload !== 'string' ||
      typeof row.attemptCount !== 'number'
    ) {
      return null;
    }
    return {
      normalizedEmail: row.normalizedEmail,
      tokenHash: row.tokenHash,
      leaseId,
      attemptCount: row.attemptCount,
      encryptedPayload: row.encryptedPayload,
    };
  }

  async failExhaustedEmailRegistrationEmails(
    now: Date,
    maxAttempts: number,
    safeErrorCode: string,
  ): Promise<void> {
    await this.collection.updateMany(
      {
        deliveryStatus: 'SENDING',
        leaseUntil: { $lte: now },
        attemptCount: { $gte: maxAttempts },
      },
      {
        $set: {
          deliveryStatus: 'FAILED',
          lastErrorCode: safeErrorCode,
          updatedAt: now,
        },
        $unset: { encryptedPayload: '', leaseId: '', leaseUntil: '' },
      },
    );
  }

  async markEmailRegistrationEmailSent(
    tokenHash: string,
    leaseId: string,
    sentAt: Date,
  ): Promise<boolean> {
    const result = await this.collection.updateOne(
      {
        tokenHash,
        deliveryStatus: 'SENDING',
        leaseId,
        expiresAt: { $gt: sentAt },
      },
      {
        $set: { deliveryStatus: 'SENT', sentAt, updatedAt: sentAt },
        $unset: { encryptedPayload: '', leaseId: '', leaseUntil: '' },
      },
    );
    return result.modifiedCount === 1;
  }

  async retryEmailRegistrationEmail(
    tokenHash: string,
    leaseId: string,
    nextAttemptAt: Date,
    maxAttempts: number,
    safeErrorCode: string,
  ): Promise<'REQUEUED' | 'FAILED' | 'STALE'> {
    const row = await this.collection.findOne({
      tokenHash,
      deliveryStatus: 'SENDING',
      leaseId,
    });
    if (!row) return 'STALE';
    const exhausted = Number(row.attemptCount) >= maxAttempts;
    const result = await this.collection.updateOne(
      { _id: row._id, deliveryStatus: 'SENDING', leaseId },
      exhausted
        ? {
            $set: {
              deliveryStatus: 'FAILED',
              lastErrorCode: safeErrorCode,
              updatedAt: new Date(),
            },
            $unset: { encryptedPayload: '', leaseId: '', leaseUntil: '' },
          }
        : {
            $set: {
              deliveryStatus: 'PENDING',
              nextAttemptAt,
              lastErrorCode: safeErrorCode,
              updatedAt: new Date(),
            },
            $unset: { leaseId: '', leaseUntil: '' },
          },
    );
    if (result.modifiedCount !== 1) return 'STALE';
    return exhausted ? 'FAILED' : 'REQUEUED';
  }

  decryptEmailRegistrationPayload(
    encryptedPayload: string,
    binding: EmailRegistrationEmailPayloadBinding,
  ): EmailRegistrationEmailPayload {
    return this.cipher.decrypt(encryptedPayload, binding);
  }

  private get collection(): Collection<EmailRegistrationDocument> {
    const db = this.connection.db;
    if (!db) throw new Error('IAM_DATABASE_UNAVAILABLE');
    return db.collection<EmailRegistrationDocument>(COLLECTION);
  }

  private get users(): Collection<UserForRegistration> {
    const db = this.connection.db;
    if (!db) throw new Error('IAM_DATABASE_UNAVAILABLE');
    return db.collection<UserForRegistration>('users');
  }

  private async verifyRequiredIndexes(): Promise<void> {
    const current = await this.collection.listIndexes().toArray();
    const missing = REQUIRED_INDEXES.filter(
      (expected) => !current.some((actual) => isExactIndex(actual, expected)),
    );
    if (missing.length > 0)
      throw new Error('EMAIL_REGISTRATION_OUTBOX_INDEXES_UNAVAILABLE');
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

function isExactIndex(
  value: unknown,
  expected: (typeof REQUIRED_INDEXES)[number],
): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const actual = value as {
    name?: unknown;
    key?: unknown;
    unique?: unknown;
    hidden?: unknown;
    expireAfterSeconds?: unknown;
    sparse?: unknown;
    partialFilterExpression?: unknown;
  };
  const key = actual.key;
  if (
    actual.name !== expected.name ||
    typeof key !== 'object' ||
    key === null ||
    JSON.stringify(Object.entries(key)) !==
      JSON.stringify(Object.entries(expected.key))
  ) {
    return false;
  }
  return (
    (actual.unique === true) === (expected.unique === true) &&
    actual.hidden !== true &&
    (actual.expireAfterSeconds as number | undefined) ===
      expected.expireAfterSeconds &&
    actual.sparse !== true &&
    actual.partialFilterExpression === undefined
  );
}
