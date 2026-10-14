import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Collection, Document } from 'mongodb';
import type { Connection } from 'mongoose';
import { IAM_PERSISTENCE } from '../persistence';
import type { CollectionIndex } from './mongodb.types';
import type {
  PasswordResetEmailJob,
  PasswordResetEmailPayload,
  PasswordResetEmailPayloadBinding,
  PasswordResetRequestSaveResult,
  PasswordResetOutboxStore,
  PasswordResetTokenClaim,
} from '../../application/authentication/password-reset.store';
import { PasswordResetPayloadCipher } from '../email/password-reset-payload.cipher';

export const PASSWORD_RESET_OUTBOX_COLLECTION = 'password_reset_outbox';

interface PasswordResetOutboxDocument extends Document {
  userScopeHash: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  deliveryStatus: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'IGNORED';
  encryptedPayload: string | null;
  attemptCount: number;
  nextAttemptAt: Date;
  leaseId?: string;
  leaseUntil?: Date;
  tokenClaimId?: string;
  lastErrorCode?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class MongoPasswordResetOutboxStore implements PasswordResetOutboxStore {
  private indexesReady?: Promise<void>;

  constructor(
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection: Connection,
    private readonly cipher: PasswordResetPayloadCipher,
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

  async savePasswordResetRequest(input: {
    userScopeHash: string;
    tokenHash: string;
    userId: string;
    expiresAt: Date;
    payload?: PasswordResetEmailPayload;
  }): Promise<PasswordResetRequestSaveResult> {
    const now = new Date();
    const encryptedPayload = input.payload
      ? this.cipher.encrypt(input.payload, {
          userScopeHash: input.userScopeHash,
          userId: input.userId,
          tokenHash: input.tokenHash,
        })
      : null;
    try {
      const queued = await this.collection.findOneAndUpdate(
        {
          userScopeHash: input.userScopeHash,
          $or: [
            {
              tokenClaimId: { $exists: false },
              leaseId: { $exists: false },
            },
            {
              tokenClaimId: { $exists: false },
              leaseUntil: { $lte: now },
            },
            { expiresAt: { $lte: now } },
          ],
        },
        {
          $set: {
            userId: input.userId,
            tokenHash: input.tokenHash,
            expiresAt: input.expiresAt,
            deliveryStatus: input.payload ? 'PENDING' : 'IGNORED',
            encryptedPayload,
            attemptCount: 0,
            nextAttemptAt: now,
            lastErrorCode: null,
            updatedAt: now,
          },
          $setOnInsert: {
            userScopeHash: input.userScopeHash,
            createdAt: now,
          },
          $unset: { leaseId: '', leaseUntil: '', tokenClaimId: '' },
        },
        { upsert: true, returnDocument: 'after' },
      );
      return queued !== null ? 'SAVED' : 'NOT_SAVED';
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const current = await this.collection.findOne(
          {
            userScopeHash: input.userScopeHash,
            expiresAt: { $gt: now },
            deliveryStatus: { $in: ['PENDING', 'SENDING', 'SENT'] },
          },
          { projection: { _id: 1 } },
        );
        return current ? 'COALESCED' : 'NOT_SAVED';
      }
      throw error;
    }
  }

  async claimPasswordResetToken(
    tokenHash: string,
    claimId: string,
  ): Promise<PasswordResetTokenClaim | null> {
    const row = await this.collection.findOneAndUpdate(
      {
        tokenHash,
        expiresAt: { $gt: new Date() },
        deliveryStatus: { $nin: ['FAILED', 'IGNORED'] },
        tokenClaimId: { $exists: false },
      },
      { $set: { tokenClaimId: claimId, updatedAt: new Date() } },
      { returnDocument: 'after', projection: { userId: 1, userScopeHash: 1 } },
    );
    if (
      !row ||
      typeof row.userId !== 'string' ||
      typeof row.userScopeHash !== 'string'
    )
      return null;
    return { userId: row.userId, userScopeHash: row.userScopeHash };
  }

  async consumeClaimedPasswordResetToken(
    tokenHash: string,
    userScopeHash: string,
    claimId: string,
  ): Promise<boolean> {
    const result = await this.collection.deleteOne({
      tokenHash,
      userScopeHash,
      tokenClaimId: claimId,
    });
    return result.deletedCount === 1;
  }

  async releasePasswordResetTokenClaim(
    userScopeHash: string,
    claimId: string,
  ): Promise<void> {
    await this.collection.updateOne(
      { userScopeHash, tokenClaimId: claimId },
      { $unset: { tokenClaimId: '' }, $set: { updatedAt: new Date() } },
    );
  }

  async claimNextPasswordResetEmail(
    now: Date,
    leaseId: string,
    leaseUntil: Date,
  ): Promise<PasswordResetEmailJob | null> {
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
      {
        sort: { nextAttemptAt: 1, createdAt: 1 },
        returnDocument: 'after',
      },
    );
    if (
      !row ||
      typeof row.tokenHash !== 'string' ||
      typeof row.userId !== 'string' ||
      typeof row.userScopeHash !== 'string' ||
      typeof row.encryptedPayload !== 'string' ||
      typeof row.attemptCount !== 'number'
    ) {
      return null;
    }
    return {
      userScopeHash: row.userScopeHash,
      userId: row.userId,
      tokenHash: row.tokenHash,
      leaseId,
      attemptCount: row.attemptCount,
      encryptedPayload: row.encryptedPayload,
    };
  }

  async failExhaustedPasswordResetEmails(
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

  async markPasswordResetEmailSent(
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

  async retryPasswordResetEmail(
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

  decryptPasswordResetEmailPayload(
    encryptedPayload: string,
    binding: PasswordResetEmailPayloadBinding,
  ): PasswordResetEmailPayload {
    return this.cipher.decrypt(encryptedPayload, binding);
  }

  private get collection(): Collection<PasswordResetOutboxDocument> {
    const db = this.connection.db;
    if (!db) throw new Error('IAM_DATABASE_UNAVAILABLE');
    return db.collection<PasswordResetOutboxDocument>(
      PASSWORD_RESET_OUTBOX_COLLECTION,
    );
  }

  private async verifyRequiredIndexes(): Promise<void> {
    const definition = IAM_PERSISTENCE.collections.find(
      (item) => item.name === PASSWORD_RESET_OUTBOX_COLLECTION,
    );
    if (!definition?.indexes?.length) {
      throw new Error('PASSWORD_RESET_OUTBOX_INDEX_DEFINITION_UNAVAILABLE');
    }
    const current = (await this.collection.indexes()) as unknown as Array<
      Record<string, unknown>
    >;
    const missing = definition.indexes.filter(
      (expected) => !current.some((actual) => isExactIndex(actual, expected)),
    );
    if (missing.length > 0) {
      throw new Error('PASSWORD_RESET_OUTBOX_INDEXES_UNAVAILABLE');
    }
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
  actual: Record<string, unknown>,
  expected: CollectionIndex,
): boolean {
  const options = expected.options;
  const key = actual.key;
  if (
    typeof actual.name !== 'string' ||
    actual.name !== options?.name ||
    typeof key !== 'object' ||
    key === null ||
    !sameIndexKey(key as Record<string, unknown>, expected.fields)
  ) {
    return false;
  }
  return (
    (actual.unique === true) === (options?.unique === true) &&
    (actual.sparse === true) === (options?.sparse === true) &&
    actual.hidden !== true &&
    (actual.expireAfterSeconds as number | undefined) ===
      options?.expireAfterSeconds &&
    sameJson(actual.partialFilterExpression, options?.partialFilterExpression)
  );
}

function sameIndexKey(
  actual: Record<string, unknown>,
  expected: Record<string, 1 | -1>,
): boolean {
  return (
    JSON.stringify(Object.entries(actual)) ===
    JSON.stringify(Object.entries(expected))
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}
