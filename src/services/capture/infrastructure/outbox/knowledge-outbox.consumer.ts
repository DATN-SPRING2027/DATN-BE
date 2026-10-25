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
import { CAPTURE_PERSISTENCE } from '../persistence';
import { ProjectDocumentStorage } from '../storage/project-document.storage';

export const SAG_KNOWLEDGE_SYNC_TRANSPORT = Symbol(
  'SAG_KNOWLEDGE_SYNC_TRANSPORT',
);

export const KNOWLEDGE_EVENT_NAMES = [
  'KNOWLEDGE_SOURCE_APPROVED',
  'KNOWLEDGE_SOURCE_REPLACED',
  'KNOWLEDGE_SOURCE_REVOKED',
] as const;

export type KnowledgeEventName = (typeof KNOWLEDGE_EVENT_NAMES)[number];

export type KnowledgeOutboxRunResult =
  'IDLE' | 'PUBLISHED' | 'SKIPPED' | 'RETRY' | 'FAILED';

export interface SagProjectDocumentUploadInput {
  organizationId: string;
  projectId: string;
  documentId: string;
  version: number;
  logicalSourceId: string;
  idempotencyKey: string;
  actorUserId: string;
  fileName: string;
  contentType: string;
  bytes: Buffer;
}

export interface SagProjectDocumentUploadReceipt {
  documentId: string;
  documentVersionId: string;
  status: string;
}

export interface SagProjectDocumentRevokeInput {
  organizationId: string;
  projectId: string;
  documentId: string;
  version: number;
  logicalSourceId: string;
  actorUserId: string;
  reason: string;
}

export interface SagProjectDocumentRevokeReceipt {
  status: 'REVOKED' | 'NOT_FOUND';
  documentId: string | null;
}

export interface SagKnowledgeSyncTransport {
  uploadProjectDocument(
    input: SagProjectDocumentUploadInput,
  ): Promise<SagProjectDocumentUploadReceipt>;
  revokeProjectDocument(
    input: SagProjectDocumentRevokeInput,
  ): Promise<SagProjectDocumentRevokeReceipt>;
}

const POLL_INTERVAL_MS = 2_000;
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 5;
const INITIAL_RETRY_MS = 15_000;
const MAX_RETRY_MS = 5 * 60_000;

interface KnowledgeOutboxPayload {
  sourceType?: string;
  sourceId?: string;
  organizationId?: string;
  projectId?: string;
  version?: number;
  previousVersion?: number;
  approvedAt?: string;
  reason?: string;
  delivery?: {
    attemptCount?: number;
    leaseId?: string;
    leaseUntil?: Date;
    nextAttemptAt?: Date;
    skippedReason?: string;
    delegatedToApprovedVersion?: number;
    receipt?: unknown;
  };
}

interface KnowledgeOutboxEventDoc {
  _id: Types.ObjectId;
  eventName: KnowledgeEventName;
  aggregateType: string;
  aggregateId: string;
  payload: KnowledgeOutboxPayload;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  occurredAt: Date;
  publishedAt?: Date;
  lastError?: string | null;
}

interface LiveProjectDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  title?: string;
  status?: string;
  currentVersionNumber?: number;
  latestApprovedVersionNumber?: number;
  createdByUserId?: Types.ObjectId;
  updatedByUserId?: Types.ObjectId;
}

interface LiveProjectDocumentVersion {
  _id: Types.ObjectId;
  documentId: Types.ObjectId;
  versionNumber: number;
  title?: string;
  content?: string;
  status?: string;
  reviewedByUserId?: Types.ObjectId;
  editedByUserId?: Types.ObjectId;
  file?: {
    key?: string;
    name?: string;
    contentType?: string;
    size?: number;
  };
}

@Injectable()
export class HttpSagKnowledgeSyncTransport implements SagKnowledgeSyncTransport {
  constructor(private readonly config: ConfigService) {}

  async uploadProjectDocument(
    input: SagProjectDocumentUploadInput,
  ): Promise<SagProjectDocumentUploadReceipt> {
    const { baseUrl, serviceToken, timeoutMs } = this.resolveConfig();
    const target = new URL(
      `/api/v1/projects/${encodeURIComponent(input.projectId)}/documents/upload`,
      `${baseUrl.origin}/`,
    );

    const form = new FormData();
    const blob = new Blob([new Uint8Array(input.bytes)], {
      type: input.contentType,
    });
    form.append('file', blob, input.fileName);
    form.append('logical_source_id', input.logicalSourceId);

    const headers = this.scopeHeaders(
      serviceToken,
      input.actorUserId,
      input.organizationId,
      input.projectId,
    );
    headers.set('Idempotency-Key', input.idempotencyKey);

    const response = await fetch(target, {
      method: 'POST',
      headers,
      body: form,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok || !body) {
      throw new Error(
        `SAG_UPLOAD_FAILED_${response.status}:${asText(body?.detail, 'unknown')}`,
      );
    }
    return {
      documentId: asText(body.document_id),
      documentVersionId: asText(body.document_version_id),
      status: asText(body.status, 'QUEUED'),
    };
  }

  async revokeProjectDocument(
    input: SagProjectDocumentRevokeInput,
  ): Promise<SagProjectDocumentRevokeReceipt> {
    const { baseUrl, serviceToken, timeoutMs } = this.resolveConfig();
    const target = new URL(
      `/api/v1/projects/${encodeURIComponent(input.projectId)}/documents/revoke`,
      `${baseUrl.origin}/`,
    );

    const headers = this.scopeHeaders(
      serviceToken,
      input.actorUserId,
      input.organizationId,
      input.projectId,
    );
    headers.set('Content-Type', 'application/json');

    const response = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        logical_source_id: input.logicalSourceId,
        reason: input.reason,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok || !body) {
      throw new Error(
        `SAG_REVOKE_FAILED_${response.status}:${asText(body?.detail, 'unknown')}`,
      );
    }
    const status = body.status === 'NOT_FOUND' ? 'NOT_FOUND' : 'REVOKED';
    return {
      status,
      documentId:
        typeof body.document_id === 'string' ? body.document_id : null,
    };
  }

  private resolveConfig(): {
    baseUrl: URL;
    serviceToken: string;
    timeoutMs: number;
  } {
    const rawBaseUrl =
      this.config.get<string>('SAG_API_BASE_URL')?.trim() ||
      this.config.get<string>('SAG_SERVICE_URL')?.trim();
    const serviceToken = this.config
      .get<string>('SAG_BFF_SERVICE_TOKEN')
      ?.trim();
    if (!rawBaseUrl || !serviceToken) {
      throw new Error('SAG_SYNC_NOT_CONFIGURED');
    }
    const timeoutMs =
      this.config.get<number>('CAPTURE_FILE_TIMEOUT_MS') ?? 120_000;
    return {
      baseUrl: new URL(rawBaseUrl),
      serviceToken,
      timeoutMs,
    };
  }

  private scopeHeaders(
    serviceToken: string,
    actorUserId: string,
    organizationId: string,
    projectId: string,
  ): Headers {
    const headers = new Headers();
    headers.set('X-SAG-BFF-Service-Token', serviceToken);
    headers.set('Accept', 'application/json');
    headers.set('X-Continuum-User-Id', actorUserId);
    headers.set('X-Continuum-Organization-Id', organizationId);
    headers.set('X-Continuum-Tenant-Id', organizationId);
    headers.set('X-Continuum-Project-Id', projectId);
    headers.set('X-Continuum-Security-Partition', projectId);
    return headers;
  }
}

@Injectable()
export class KnowledgeOutboxConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KnowledgeOutboxConsumer.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly documentLocks = new Map<string, Promise<unknown>>();

  constructor(
    @InjectConnection(CAPTURE_PERSISTENCE.databaseName)
    private readonly connection: Connection,
    private readonly config: ConfigService,
    private readonly documentStorage: ProjectDocumentStorage,
    @Inject(SAG_KNOWLEDGE_SYNC_TRANSPORT)
    private readonly transport: SagKnowledgeSyncTransport,
  ) {}

  onModuleInit(): void {
    // Only auto-poll in the background when explicitly enabled via configuration
    if (
      this.config.get<string>('KNOWLEDGE_OUTBOX_CONSUMER_ENABLED') !== 'true'
    ) {
      return;
    }
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.timer.unref();
    void this.poll();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Sequentially drains all ready PENDING knowledge outbox events for a specific documentId.
   */
  async processDocumentEvents(
    documentId: string,
  ): Promise<KnowledgeOutboxRunResult[]> {
    const results: KnowledgeOutboxRunResult[] = [];
    for (let step = 0; step < 50; step += 1) {
      const outcome = await this.runOnce(documentId);
      if (outcome === 'IDLE') break;
      results.push(outcome);
      if (outcome === 'RETRY' || outcome === 'FAILED') break;
    }
    return results;
  }

  /**
   * Claims and processes the oldest ready PENDING knowledge outbox event in FIFO order.
   * Serializes execution per documentId (`aggregateId`) and re-reads authoritative live state
   * from `project_documents` / `project_document_versions` immediately before calling SAG.
   */
  async runOnce(filterDocumentId?: string): Promise<KnowledgeOutboxRunResult> {
    const now = new Date();
    const leaseId = randomBytes(24).toString('base64url');
    const outbox =
      this.connection.collection<KnowledgeOutboxEventDoc>('outbox_events');

    const event = await outbox.findOneAndUpdate(
      {
        aggregateType: 'PROJECT_DOCUMENT',
        eventName: { $in: [...KNOWLEDGE_EVENT_NAMES] },
        ...(filterDocumentId ? { aggregateId: filterDocumentId } : {}),
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
          updatedAt: now,
        },
        $inc: { 'payload.delivery.attemptCount': 1 },
      },
      { returnDocument: 'after', sort: { occurredAt: 1, _id: 1 } },
    );

    if (!event) return 'IDLE';

    return this.withDocumentLock(event.aggregateId, () =>
      this.executeLeasedEvent(event, leaseId),
    );
  }

  private async executeLeasedEvent(
    event: KnowledgeOutboxEventDoc,
    leaseId: string,
  ): Promise<KnowledgeOutboxRunResult> {
    const payload = event.payload;
    const documentId = event.aggregateId;
    const organizationId = String(payload.organizationId ?? '');
    const projectId = String(payload.projectId ?? '');
    const version = Number(payload.version ?? 0);

    if (
      !isValidObjectIdHex(documentId) ||
      !isValidObjectIdHex(organizationId) ||
      !isValidObjectIdHex(projectId) ||
      !Number.isInteger(version) ||
      version < 1
    ) {
      await this.markFailed(event._id, leaseId, 'KNOWLEDGE_PAYLOAD_INVALID');
      return 'FAILED';
    }

    try {
      const documents =
        this.connection.collection<LiveProjectDocument>('project_documents');
      const versions = this.connection.collection<LiveProjectDocumentVersion>(
        'project_document_versions',
      );

      // Authoritative live-state recheck immediately before any SAG action
      const liveDoc = await documents.findOne({
        _id: new Types.ObjectId(documentId),
        organizationId: new Types.ObjectId(organizationId),
        projectId: new Types.ObjectId(projectId),
      });

      const latestApprovedVersion = this.resolveLatestApprovedVersion(liveDoc);

      if (
        event.eventName === 'KNOWLEDGE_SOURCE_APPROVED' ||
        event.eventName === 'KNOWLEDGE_SOURCE_REPLACED'
      ) {
        // Stale-event guard 1: If the document was archived/revoked or deleted, NEVER revive it in SAG
        if (!liveDoc || liveDoc.status === 'ARCHIVED') {
          await this.markPublished(event._id, leaseId, {
            skippedReason: 'DOCUMENT_REVOKED_OR_ARCHIVED',
          });
          return 'SKIPPED';
        }

        // Stale-event guard 2: If a newer version is already approved, skip uploading the older version
        if (latestApprovedVersion !== null && version < latestApprovedVersion) {
          await this.markPublished(event._id, leaseId, {
            skippedReason: 'SUPERSEDED_BY_NEWER_VERSION',
          });
          return 'SKIPPED';
        }

        const targetVersionDoc = await versions.findOne({
          documentId: new Types.ObjectId(documentId),
          versionNumber: version,
        });

        if (
          !targetVersionDoc ||
          targetVersionDoc.status !== 'APPROVED' ||
          latestApprovedVersion === null
        ) {
          await this.markPublished(event._id, leaseId, {
            skippedReason: 'VERSION_NOT_APPROVED',
          });
          return 'SKIPPED';
        }

        // When KNOWLEDGE_SOURCE_REPLACED is paired with KNOWLEDGE_SOURCE_APPROVED for the same version,
        // SAG supersedes the previous version atomically on upload of the new version.
        if (event.eventName === 'KNOWLEDGE_SOURCE_REPLACED') {
          const companionApproved = await this.connection
            .collection<KnowledgeOutboxEventDoc>('outbox_events')
            .findOne({
              aggregateType: 'PROJECT_DOCUMENT',
              aggregateId: documentId,
              eventName: 'KNOWLEDGE_SOURCE_APPROVED',
              'payload.version': version,
              status: { $in: ['PENDING', 'PUBLISHED'] },
            });
          if (companionApproved) {
            await this.markPublished(event._id, leaseId, {
              delegatedToApprovedVersion: version,
            });
            return 'PUBLISHED';
          }
        }

        const { bytes, fileName, contentType } = await this.loadVersionContent(
          documentId,
          liveDoc,
          targetVersionDoc,
        );

        const actorUserId = String(
          targetVersionDoc.reviewedByUserId ??
            liveDoc.updatedByUserId ??
            liveDoc.createdByUserId,
        );

        const receipt = await this.transport.uploadProjectDocument({
          organizationId,
          projectId,
          documentId,
          version,
          logicalSourceId: `continuum:project_document:${documentId}`,
          idempotencyKey: `continuum:project_document:${documentId}:v${version}`,
          actorUserId,
          fileName,
          contentType,
          bytes,
        });

        await this.markPublished(event._id, leaseId, { receipt });
        return 'PUBLISHED';
      }

      if (event.eventName === 'KNOWLEDGE_SOURCE_REVOKED') {
        // Guard against a stale REVOKED event if the document is currently active at a higher approved version
        if (
          liveDoc &&
          liveDoc.status !== 'ARCHIVED' &&
          latestApprovedVersion !== null &&
          latestApprovedVersion > version
        ) {
          await this.markPublished(event._id, leaseId, {
            skippedReason: 'REAPPROVED_AT_NEWER_VERSION',
          });
          return 'SKIPPED';
        }

        const actorUserId = String(
          liveDoc?.updatedByUserId ??
            liveDoc?.createdByUserId ??
            '000000000000000000000000',
        );

        const receipt = await this.transport.revokeProjectDocument({
          organizationId,
          projectId,
          documentId,
          version,
          logicalSourceId: `continuum:project_document:${documentId}`,
          actorUserId,
          reason: String(payload.reason ?? 'ARCHIVED'),
        });

        await this.markPublished(event._id, leaseId, { receipt });
        return 'PUBLISHED';
      }

      await this.markFailed(event._id, leaseId, 'UNSUPPORTED_EVENT');
      return 'FAILED';
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'UNKNOWN_SYNC_ERROR';
      const attemptCount = payload.delivery?.attemptCount ?? 1;
      return this.scheduleRetryOrFail(
        event._id,
        leaseId,
        attemptCount,
        errorMessage,
      );
    }
  }

  private resolveLatestApprovedVersion(
    liveDoc: LiveProjectDocument | null,
  ): number | null {
    if (!liveDoc || liveDoc.status === 'ARCHIVED') return null;
    if (
      typeof liveDoc.latestApprovedVersionNumber === 'number' &&
      liveDoc.latestApprovedVersionNumber >= 1
    ) {
      return liveDoc.latestApprovedVersionNumber;
    }
    if (
      liveDoc.status === 'APPROVED' &&
      typeof liveDoc.currentVersionNumber === 'number' &&
      liveDoc.currentVersionNumber >= 1
    ) {
      return liveDoc.currentVersionNumber;
    }
    return null;
  }

  private async loadVersionContent(
    documentId: string,
    liveDoc: LiveProjectDocument,
    versionDoc: LiveProjectDocumentVersion,
  ): Promise<{ bytes: Buffer; fileName: string; contentType: string }> {
    if (
      versionDoc.file?.key &&
      versionDoc.file.name &&
      versionDoc.file.contentType
    ) {
      const bytes = await this.documentStorage.get(versionDoc.file.key);
      return {
        bytes,
        fileName: versionDoc.file.name,
        contentType: versionDoc.file.contentType,
      };
    }

    const markdown = (versionDoc.content ?? '').trim();
    if (!markdown) {
      throw new Error('DOCUMENT_VERSION_CONTENT_EMPTY');
    }
    const baseTitle = (versionDoc.title || liveDoc.title || documentId)
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120);
    return {
      bytes: Buffer.from(markdown, 'utf-8'),
      fileName: `${baseTitle || documentId}.md`,
      contentType: 'text/markdown',
    };
  }

  private async markPublished(
    eventId: Types.ObjectId,
    leaseId: string,
    metadata: {
      skippedReason?: string;
      delegatedToApprovedVersion?: number;
      receipt?: unknown;
    },
  ): Promise<void> {
    const now = new Date();
    await this.connection.collection('outbox_events').updateOne(
      {
        _id: eventId,
        status: 'PENDING',
        'payload.delivery.leaseId': leaseId,
      },
      {
        $set: {
          status: 'PUBLISHED',
          publishedAt: now,
          updatedAt: now,
          lastError: null,
          ...(metadata.skippedReason
            ? { 'payload.delivery.skippedReason': metadata.skippedReason }
            : {}),
          ...(metadata.delegatedToApprovedVersion !== undefined
            ? {
                'payload.delivery.delegatedToApprovedVersion':
                  metadata.delegatedToApprovedVersion,
              }
            : {}),
          ...(metadata.receipt !== undefined
            ? { 'payload.delivery.receipt': metadata.receipt }
            : {}),
        },
        $unset: {
          'payload.delivery.leaseId': '',
          'payload.delivery.leaseUntil': '',
          'payload.delivery.nextAttemptAt': '',
        },
      },
    );
  }

  private async scheduleRetryOrFail(
    eventId: Types.ObjectId,
    leaseId: string,
    attemptCount: number,
    errorMessage: string,
  ): Promise<'RETRY' | 'FAILED'> {
    const terminal = attemptCount >= MAX_ATTEMPTS;
    const now = new Date();
    const delay = Math.min(
      INITIAL_RETRY_MS * 2 ** Math.max(0, attemptCount - 1),
      MAX_RETRY_MS,
    );
    await this.connection.collection('outbox_events').updateOne(
      {
        _id: eventId,
        status: 'PENDING',
        'payload.delivery.leaseId': leaseId,
      },
      {
        $set: {
          ...(terminal
            ? { status: 'FAILED', lastError: errorMessage, updatedAt: now }
            : {
                lastError: errorMessage,
                updatedAt: now,
                'payload.delivery.nextAttemptAt': new Date(
                  now.getTime() + delay,
                ),
              }),
        },
        $unset: {
          'payload.delivery.leaseId': '',
          'payload.delivery.leaseUntil': '',
        },
      },
    );
    this.logger.warn(
      terminal
        ? `knowledge_outbox_delivery_exhausted (${String(eventId)}): ${errorMessage}`
        : `knowledge_outbox_delivery_retry_scheduled (${String(eventId)}): ${errorMessage}`,
    );
    return terminal ? 'FAILED' : 'RETRY';
  }

  private async markFailed(
    eventId: Types.ObjectId,
    leaseId: string,
    errorCode: string,
  ): Promise<void> {
    await this.connection.collection('outbox_events').updateOne(
      {
        _id: eventId,
        status: 'PENDING',
        'payload.delivery.leaseId': leaseId,
      },
      {
        $set: {
          status: 'FAILED',
          lastError: errorCode,
          updatedAt: new Date(),
        },
        $unset: {
          'payload.delivery.leaseId': '',
          'payload.delivery.leaseUntil': '',
          'payload.delivery.nextAttemptAt': '',
        },
      },
    );
  }

  private async withDocumentLock<T>(
    documentId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.documentLocks.get(documentId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.documentLocks.set(documentId, chained);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.documentLocks.get(documentId) === chained) {
        this.documentLocks.delete(documentId);
      }
    }
  }

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch {
      this.logger.warn('knowledge_outbox_poll_failed');
    } finally {
      this.running = false;
    }
  }
}

function isValidObjectIdHex(value: string): boolean {
  return /^[a-f\d]{24}$/i.test(value);
}

function asText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}
