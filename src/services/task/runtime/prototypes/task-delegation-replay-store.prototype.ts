import type { Collection } from 'mongodb';
import type { Connection } from 'mongoose';
import type { TaskDelegationReplayEvidence } from './task-delegation-assertion.prototype';

export const TASK_DELEGATION_REPLAY_COLLECTION =
  'task_delegation_replay_prototype';
export const TASK_DELEGATION_REPLAY_UNIQUE_INDEX =
  'task_delegation_replay_issuer_jti_unique';
export const TASK_DELEGATION_REPLAY_EXPIRY_INDEX =
  'task_delegation_replay_retain_until_ttl';

interface TaskDelegationReplayDocument {
  issuer: string;
  tokenId: string;
  retainUntil: Date;
  recordedAt: Date;
}

/**
 * A prototype persistence port for one-time delegation assertions. It is not
 * registered in TaskRuntimeModule. Callers choose the assertion acceptance
 * window; this adapter stores only issuer, jti and the caller-supplied expiry.
 */
export interface TaskDelegationReplayStore {
  consume(evidence: TaskDelegationReplayEvidence): Promise<boolean>;
}

/**
 * MongoDB unique insert provides atomic consume across independent clients.
 * The TTL index is storage cleanup only; expiry acceptance remains enforced by
 * the verifier before this store is called.
 */
export class MongoTaskDelegationReplayStore implements TaskDelegationReplayStore {
  private constructor(
    private readonly collection: Collection<TaskDelegationReplayDocument>,
    private readonly now: () => Date,
  ) {}

  static async create(
    connection: Connection,
    options: { now?: () => Date; collectionName?: string } = {},
  ): Promise<MongoTaskDelegationReplayStore> {
    if (!connection.db) throw new Error('Replay store database is unavailable');
    const collectionName =
      options.collectionName ?? TASK_DELEGATION_REPLAY_COLLECTION;
    if (!/^task_delegation_replay_[a-z0-9_]{0,48}$/.test(collectionName)) {
      throw new Error('Replay store collection name is invalid');
    }

    const collection =
      connection.db.collection<TaskDelegationReplayDocument>(collectionName);
    await collection.createIndex(
      { issuer: 1, tokenId: 1 },
      { unique: true, name: TASK_DELEGATION_REPLAY_UNIQUE_INDEX },
    );
    await collection.createIndex(
      { retainUntil: 1 },
      { expireAfterSeconds: 0, name: TASK_DELEGATION_REPLAY_EXPIRY_INDEX },
    );

    return new MongoTaskDelegationReplayStore(
      collection,
      options.now ?? (() => new Date()),
    );
  }

  async consume(evidence: TaskDelegationReplayEvidence): Promise<boolean> {
    if (
      typeof evidence.issuer !== 'string' ||
      evidence.issuer.length === 0 ||
      evidence.issuer.length > 512 ||
      typeof evidence.tokenId !== 'string' ||
      evidence.tokenId.length === 0 ||
      evidence.tokenId.length > 128 ||
      !(evidence.retainUntil instanceof Date) ||
      !Number.isFinite(evidence.retainUntil.getTime())
    ) {
      throw new Error('Replay evidence is malformed');
    }
    if (evidence.retainUntil.getTime() <= this.now().getTime()) return false;

    try {
      await this.collection.insertOne(
        {
          issuer: evidence.issuer,
          tokenId: evidence.tokenId,
          retainUntil: evidence.retainUntil,
          recordedAt: this.now(),
        },
        { writeConcern: { w: 'majority' } },
      );
      return true;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        Object.getOwnPropertyDescriptor(error, 'code')?.value === 11000
      ) {
        return false;
      }
      throw error;
    }
  }
}
