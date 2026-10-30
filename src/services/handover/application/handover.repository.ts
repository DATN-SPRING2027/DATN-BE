import {
  ConflictException,
  GoneException,
  Injectable,
  Optional,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import mongoose, { Types, type ClientSession, type Connection } from 'mongoose';
import {
  AuditService,
  type AuditEventInput,
} from '../infrastructure/audit/audit.service';
import {
  createHandoverV2Schema,
  HANDOVER_V2_MODEL_SUFFIX,
} from '../infrastructure/mongodb/handover-v2.schemas';
import {
  OutboxService,
  type OutboxEventInput,
} from '../infrastructure/outbox/outbox.service';
import { HANDOVER_PERSISTENCE } from '../infrastructure/persistence';
import type {
  StoredAcceptanceDoc,
  StoredDraftItemDoc,
  StoredEvidenceDoc,
  StoredEvidenceReviewDoc,
  StoredFollowUpDoc,
  StoredHandoverDoc,
  StoredJobDoc,
  StoredOperationDoc,
  StoredRevisionDoc,
} from './handover.types';

const LEGACY_SHARED = new Set([
  'handovers',
  'handover_items',
  'follow_up_tasks',
]);
const MAX_REVISION_BSON_BYTES = 4 * 1024 * 1024;
const COMMAND_LEASE_MS = 30_000;

export interface HandoverQueryChain<TResult> {
  sort(spec: Record<string, 1 | -1>): HandoverQueryChain<TResult>;
  limit(n: number): HandoverQueryChain<TResult>;
  select(spec: Record<string, 0 | 1>): HandoverQueryChain<TResult>;
  session(session: ClientSession | null): HandoverQueryChain<TResult>;
  lean<TLean = TResult>(): {
    exec(): Promise<TResult extends unknown[] ? TLean : TLean | null>;
  };
  exec(): Promise<TResult>;
}

export interface HandoverCountChain extends PromiseLike<number> {
  session(session: ClientSession | null): HandoverCountChain;
  exec(): Promise<number>;
}

/**
 * Lightweight strongly-typed wrapper interface over Mongoose V2 Model.
 * Avoids Mongoose 8's recursive DotNotation<HydratedDocument<T>> type explosion
 * during `tsc --noEmit` while keeping 100% runtime V2 schema & validator enforcement.
 */
export interface HandoverModel<TDoc> {
  find(
    filter: Record<string, unknown>,
    projection?: Record<string, unknown> | null,
    options?: { session?: ClientSession },
  ): HandoverQueryChain<TDoc[]>;
  findOne(
    filter: Record<string, unknown>,
    projection?: Record<string, unknown> | null,
    options?: { session?: ClientSession },
  ): HandoverQueryChain<TDoc | null>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { new?: boolean; upsert?: boolean; session?: ClientSession },
  ): HandoverQueryChain<TDoc | null>;
  create(
    docs: Array<Record<string, unknown>>,
    options?: { session?: ClientSession; ordered?: boolean },
  ): Promise<Array<{ toObject(): TDoc }>>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { session?: ClientSession; upsert?: boolean },
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { session?: ClientSession },
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  deleteMany(
    filter: Record<string, unknown>,
    options?: { session?: ClientSession },
  ): Promise<{ deletedCount: number }>;
  countDocuments(
    filter: Record<string, unknown>,
    options?: { session?: ClientSession },
  ): HandoverCountChain;
}

@Injectable()
export class HandoverRepository {
  constructor(
    @Optional()
    @InjectConnection(HANDOVER_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
    @Optional()
    private readonly auditService?: AuditService,
    @Optional()
    private readonly outboxService?: OutboxService,
  ) {}

  get conn(): Connection {
    if (!this.connection || !this.connection.db) {
      throw new ServiceUnavailableException({
        code: 'HANDOVER_DATABASE_UNAVAILABLE',
        message: 'Handover persistence is unavailable.',
        details: {},
      });
    }
    return this.connection;
  }

  model<TDoc>(collectionName: string): HandoverModel<TDoc> {
    const conn = this.conn;
    const prefix = HANDOVER_PERSISTENCE.databaseName;
    const modelName = LEGACY_SHARED.has(collectionName)
      ? `${prefix}_${collectionName}${HANDOVER_V2_MODEL_SUFFIX}`
      : `${prefix}_${collectionName}`;

    const existing = conn.models[modelName] as unknown as
      HandoverModel<TDoc> | undefined;
    if (existing) {
      return existing;
    }
    const schema = createHandoverV2Schema(collectionName);
    if (!schema) {
      throw new Error(`Unknown Handover V2 collection '${collectionName}'`);
    }
    return conn.model(modelName, schema) as unknown as HandoverModel<TDoc>;
  }

  get handovers(): HandoverModel<StoredHandoverDoc> {
    return this.model<StoredHandoverDoc>('handovers');
  }

  get draftItems(): HandoverModel<StoredDraftItemDoc> {
    return this.model<StoredDraftItemDoc>('handover_items');
  }

  get revisions(): HandoverModel<StoredRevisionDoc> {
    return this.model<StoredRevisionDoc>('handover_revisions');
  }

  get acceptances(): HandoverModel<StoredAcceptanceDoc> {
    return this.model<StoredAcceptanceDoc>('handover_acceptances');
  }

  get evidences(): HandoverModel<StoredEvidenceDoc> {
    return this.model<StoredEvidenceDoc>('handover_evidence');
  }

  get evidenceReviews(): HandoverModel<StoredEvidenceReviewDoc> {
    return this.model<StoredEvidenceReviewDoc>('handover_evidence_reviews');
  }

  get operations(): HandoverModel<StoredOperationDoc> {
    return this.model<StoredOperationDoc>('handover_operations');
  }

  get jobs(): HandoverModel<StoredJobDoc> {
    return this.model<StoredJobDoc>('handover_jobs');
  }

  get followUps(): HandoverModel<StoredFollowUpDoc> {
    return this.model<StoredFollowUpDoc>('follow_up_tasks');
  }

  assertRevisionSnapshotWithinLimit(
    revisionDoc: Record<string, unknown>,
  ): void {
    const size = mongoose.mongo.BSON.calculateObjectSize(revisionDoc);
    if (size > MAX_REVISION_BSON_BYTES) {
      throw new PayloadTooLargeException({
        code: 'REVISION_SNAPSHOT_TOO_LARGE',
        message: 'Encoded revision snapshot exceeds 4 MiB BSON limit.',
        details: { maxBytes: MAX_REVISION_BSON_BYTES },
      });
    }
  }

  async withTransaction<T>(
    fn: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.conn.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async appendAuditAndOutbox(
    audit: AuditEventInput,
    outbox: OutboxEventInput | null,
    session?: ClientSession,
  ): Promise<void> {
    if (this.auditService) {
      await this.auditService.append(audit, session);
    } else if (this.connection) {
      const client = this.conn.getClient();
      await client
        .db('continuum_audit')
        .collection('audit_logs')
        .insertOne(
          { ...audit, occurredAt: new Date() },
          session ? { session } : undefined,
        );
    }

    if (outbox) {
      if (this.outboxService) {
        await this.outboxService.append(outbox, session);
      } else {
        const now = new Date();
        await this.conn.collection('outbox_events').insertOne(
          {
            ...outbox,
            status: 'PENDING',
            occurredAt: now,
            createdAt: now,
            updatedAt: now,
          },
          session ? { session } : undefined,
        );
      }
    }
  }

  async findExistingOperation(input: {
    organizationId: string;
    projectId: string;
    actorUserId: string;
    namespace: string;
    key: string;
    session?: ClientSession;
  }): Promise<StoredOperationDoc | null> {
    return this.operations
      .findOne({
        organizationId: new Types.ObjectId(input.organizationId.toLowerCase()),
        projectId: new Types.ObjectId(input.projectId.toLowerCase()),
        actorUserId: input.actorUserId.toLowerCase(),
        namespace: input.namespace,
        key: input.key.toLowerCase(),
      })
      .session(input.session ?? null)
      .lean<StoredOperationDoc>()
      .exec();
  }

  assertIdempotencyMatchOrReplay(
    existing: StoredOperationDoc | null,
    expectedFingerprint: string,
  ): 'NEW' | 'REPLAY_COMMITTED' {
    if (!existing) {
      return 'NEW';
    }
    if (existing.fingerprint !== expectedFingerprint) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_CONFLICT',
        message:
          'Idempotency-Key was already used with a different command payload or version.',
        details: {},
      });
    }
    if (
      existing.receipt?.outcome === 'ARCHIVED' ||
      existing.safeErrorCode === 'RECEIPT_ARCHIVED'
    ) {
      throw new GoneException({
        code: 'OPERATION_RECEIPT_ARCHIVED',
        message:
          'Operation receipt has been archived; reconcile current resource state before retrying.',
        details: {},
      });
    }
    if (existing.state === 'COMMITTED') {
      return 'REPLAY_COMMITTED';
    }
    if (
      (existing.state === 'PENDING' || existing.state === 'DISPATCHED') &&
      existing.leaseExpiresAt &&
      existing.leaseExpiresAt.getTime() > Date.now()
    ) {
      throw new ConflictException({
        code: 'OPERATION_IN_PROGRESS',
        message: 'Command with this Idempotency-Key is currently in progress.',
        details: {},
      });
    }
    if (existing.state === 'REJECTED' || existing.state === 'FAILED') {
      throw new ConflictException({
        code: existing.safeErrorCode ?? 'OPERATION_PREVIOUSLY_REJECTED',
        message: 'Command with this Idempotency-Key was previously rejected.',
        details: {},
      });
    }
    return 'NEW';
  }

  async createOrClaimCommandOperation(
    input: {
      organizationId: string;
      projectId: string;
      handoverId?: Types.ObjectId;
      actorUserId: string;
      namespace: string;
      key: string;
      fingerprint: string;
      expectedVersion?: number;
      receipt: NonNullable<StoredOperationDoc['receipt']>;
    },
    session: ClientSession,
  ): Promise<StoredOperationDoc> {
    const now = new Date();
    const orgObj = new Types.ObjectId(input.organizationId.toLowerCase());
    const projObj = new Types.ObjectId(input.projectId.toLowerCase());
    const keyLower = input.key.toLowerCase();

    const doc: Record<string, unknown> = {
      schemaVersion: 2,
      organizationId: orgObj,
      projectId: projObj,
      ...(input.handoverId ? { handoverId: input.handoverId } : {}),
      actorUserId: input.actorUserId.toLowerCase(),
      namespace: input.namespace,
      key: keyLower,
      fingerprint: input.fingerprint,
      kind: 'COMMAND',
      state: 'COMMITTED',
      ...(input.expectedVersion !== undefined
        ? { expectedVersion: input.expectedVersion }
        : {}),
      receipt: input.receipt,
      leaseOwner: 'handover-service',
      leaseExpiresAt: new Date(now.getTime() + COMMAND_LEASE_MS),
      fence: 1,
    };

    try {
      const [created] = await this.operations.create([doc], { session });
      return created.toObject();
    } catch (err: unknown) {
      if ((err as { code?: number })?.code === 11000) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_CONFLICT',
          message: 'Concurrent duplicate Idempotency-Key detected.',
          details: {},
        });
      }
      throw err;
    }
  }

  async nextSequence(
    collection:
      | 'handover_acceptances'
      | 'handover_evidence'
      | 'handover_evidence_reviews',
    filter: {
      handoverId: Types.ObjectId;
      revisionId: Types.ObjectId;
      successorUserId: string;
      assignmentVersion: number;
      itemId?: Types.ObjectId;
    },
    session?: ClientSession,
  ): Promise<number> {
    const model = this.model<{ sequence: number }>(collection);
    const query: Record<string, unknown> = {
      handoverId: filter.handoverId,
      revisionId: filter.revisionId,
      successorUserId: filter.successorUserId.toLowerCase(),
      assignmentVersion: filter.assignmentVersion,
    };
    if (filter.itemId) {
      query.itemId = filter.itemId;
    } else {
      query.itemId = { $exists: false };
    }
    const latest = await model
      .findOne(query)
      .sort({ sequence: -1 })
      .session(session ?? null)
      .lean<{ sequence: number }>()
      .exec();
    return (latest?.sequence ?? 0) + 1;
  }
}
