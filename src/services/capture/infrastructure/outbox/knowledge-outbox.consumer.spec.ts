import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import type { ProjectDocumentStorage } from '../storage/project-document.storage';
import {
  KnowledgeOutboxConsumer,
  type SagKnowledgeSyncTransport,
  type SagProjectDocumentRevokeInput,
  type SagProjectDocumentUploadInput,
} from './knowledge-outbox.consumer';

const organizationId = new Types.ObjectId('6ad76c7d938f3bf53df7335e');
const projectId = new Types.ObjectId('6ad7758334bd88b3f2cc844c');
const documentId = new Types.ObjectId('6bd7758334bd88b3f2cc9001');
const reviewerUserId = new Types.ObjectId('6ad76c7d938f3bf53df73351');

interface MockOutboxEvent {
  _id: Types.ObjectId;
  eventName:
    | 'KNOWLEDGE_SOURCE_APPROVED'
    | 'KNOWLEDGE_SOURCE_REPLACED'
    | 'KNOWLEDGE_SOURCE_REVOKED';
  aggregateType: 'PROJECT_DOCUMENT';
  aggregateId: string;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  occurredAt: Date;
  publishedAt?: Date;
  lastError?: string | null;
}

interface MockHarnessOptions {
  events: MockOutboxEvent[];
  liveDocument: Record<string, unknown> | null;
  liveVersions: Array<Record<string, unknown>>;
  fileBytesByKey?: Record<string, Buffer>;
  uploadImpl?: (input: SagProjectDocumentUploadInput) => Promise<{
    documentId: string;
    documentVersionId: string;
    status: string;
  }>;
  revokeImpl?: (
    input: SagProjectDocumentRevokeInput,
  ) => Promise<{ status: 'REVOKED' | 'NOT_FOUND'; documentId: string | null }>;
}

function cloneEvent(event: MockOutboxEvent): MockOutboxEvent {
  return {
    ...event,
    _id: new Types.ObjectId(String(event._id)),
    occurredAt: new Date(event.occurredAt.getTime()),
    ...(event.publishedAt
      ? { publishedAt: new Date(event.publishedAt.getTime()) }
      : {}),
    payload: structuredClone(event.payload),
  };
}

function createHarness(options: MockHarnessOptions) {
  const events = options.events.map((event) => cloneEvent(event));
  const uploads: SagProjectDocumentUploadInput[] = [];
  const revokes: SagProjectDocumentRevokeInput[] = [];

  const outboxCollection = {
    findOne: jest.fn((filter: Record<string, unknown>) => {
      const candidates = events
        .filter((e) => matchesFilter(e, filter))
        .sort(compareEvents);
      return Promise.resolve(candidates[0] ? cloneEvent(candidates[0]) : null);
    }),
    findOneAndUpdate: jest.fn(
      (
        filter: Record<string, unknown>,
        update: Record<string, Record<string, unknown>>,
      ) => {
        const candidates = events
          .filter((e) => matchesFilter(e, filter))
          .sort(compareEvents);
        const target = candidates[0];
        if (!target) return Promise.resolve(null);
        applyUpdate(target, update);
        return Promise.resolve(cloneEvent(target));
      },
    ),
    updateOne: jest.fn(
      (
        filter: Record<string, unknown>,
        update: Record<string, Record<string, unknown>>,
      ) => {
        const target = events.find((e) => matchesFilter(e, filter));
        if (!target)
          return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });
        applyUpdate(target, update);
        return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
      },
    ),
  };

  const documentsCollection = {
    findOne: jest.fn((filter: Record<string, unknown>) => {
      if (!options.liveDocument) return Promise.resolve(null);
      if (filter._id && !sameValue(filter._id, options.liveDocument._id)) {
        return Promise.resolve(null);
      }
      return Promise.resolve({ ...options.liveDocument });
    }),
  };

  const versionsCollection = {
    findOne: jest.fn((filter: Record<string, unknown>) => {
      const found = options.liveVersions.find(
        (v) =>
          sameValue(v.documentId, filter.documentId) &&
          (filter.versionNumber === undefined ||
            Number(v.versionNumber) === Number(filter.versionNumber)) &&
          (filter.status === undefined || v.status === filter.status),
      );
      return Promise.resolve(found ? { ...found } : null);
    }),
  };

  const collections: Record<string, unknown> = {
    outbox_events: outboxCollection,
    project_documents: documentsCollection,
    project_document_versions: versionsCollection,
  };

  const connection = {
    collection: jest.fn((name: string) => collections[name]),
  } as unknown as Connection;

  const storage = {
    get: jest.fn((key: string) => {
      const bytes = options.fileBytesByKey?.[key];
      if (!bytes)
        return Promise.reject(new Error(`Missing storage key: ${key}`));
      return Promise.resolve(bytes);
    }),
  } as unknown as ProjectDocumentStorage;

  const transport: SagKnowledgeSyncTransport = {
    async uploadProjectDocument(input) {
      uploads.push(input);
      if (options.uploadImpl) {
        return options.uploadImpl(input);
      }
      return {
        documentId: 'sag-doc-1',
        documentVersionId: `sag-ver-${input.version}`,
        status: 'QUEUED',
      };
    },
    async revokeProjectDocument(input) {
      revokes.push(input);
      if (options.revokeImpl) {
        return options.revokeImpl(input);
      }
      return {
        status: 'REVOKED',
        documentId: 'sag-doc-1',
      };
    },
  };

  const config = new ConfigService({
    KNOWLEDGE_OUTBOX_CONSUMER_ENABLED: 'false',
  });

  const consumer = new KnowledgeOutboxConsumer(
    connection,
    config,
    storage,
    transport,
  );

  return {
    consumer,
    events,
    uploads,
    revokes,
    outboxCollection,
  };
}

function compareEvents(a: MockOutboxEvent, b: MockOutboxEvent): number {
  const timeDiff = a.occurredAt.getTime() - b.occurredAt.getTime();
  if (timeDiff !== 0) return timeDiff;
  return a._id.toHexString().localeCompare(b._id.toHexString());
}

function getNested(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (
      acc &&
      typeof acc === 'object' &&
      key in (acc as Record<string, unknown>)
    ) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Types.ObjectId && b instanceof Types.ObjectId) {
    return a.equals(b);
  }
  if (a instanceof Types.ObjectId && typeof b === 'string') {
    return a.toHexString() === b;
  }
  if (typeof a === 'string' && b instanceof Types.ObjectId) {
    return a === b.toHexString();
  }
  return a === b;
}

function setNested(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!part) continue;
    if (typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const lastPart = parts[parts.length - 1];
  if (lastPart) current[lastPart] = value;
}

function unsetNested(obj: Record<string, unknown>, path: string): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!part) return;
    if (typeof current[part] !== 'object' || current[part] === null) return;
    current = current[part] as Record<string, unknown>;
  }
  const lastPart = parts[parts.length - 1];
  if (lastPart) delete current[lastPart];
}

function matchesFilter(
  event: MockOutboxEvent,
  filter: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === '$or' && Array.isArray(expected)) {
      if (
        !expected.some((sub) =>
          matchesFilter(event, sub as Record<string, unknown>),
        )
      ) {
        return false;
      }
      continue;
    }
    if (key === '$and' && Array.isArray(expected)) {
      if (
        !expected.every((sub) =>
          matchesFilter(event, sub as Record<string, unknown>),
        )
      ) {
        return false;
      }
      continue;
    }
    const actual = key.includes('.')
      ? getNested(event as unknown as Record<string, unknown>, key)
      : (event as unknown as Record<string, unknown>)[key];
    if (
      expected &&
      typeof expected === 'object' &&
      !(expected instanceof Types.ObjectId) &&
      !(expected instanceof Date)
    ) {
      const ops = expected as Record<string, unknown>;
      if ('$in' in ops && Array.isArray(ops.$in)) {
        if (!ops.$in.some((item) => String(item) === String(actual)))
          return false;
        continue;
      }
      if ('$exists' in ops) {
        const exists = actual !== undefined;
        if (Boolean(ops.$exists) !== exists) return false;
        continue;
      }
      if ('$lte' in ops && ops.$lte instanceof Date) {
        if (
          !(actual instanceof Date) ||
          actual.getTime() > ops.$lte.getTime()
        ) {
          return false;
        }
        continue;
      }
      if ('$gt' in ops && ops.$gt instanceof Date) {
        if (
          !(actual instanceof Date) ||
          actual.getTime() <= ops.$gt.getTime()
        ) {
          return false;
        }
        continue;
      }
    }
    if (
      expected instanceof Types.ObjectId &&
      actual instanceof Types.ObjectId
    ) {
      if (!expected.equals(actual)) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function applyUpdate(
  event: MockOutboxEvent,
  update: Record<string, Record<string, unknown>>,
): void {
  const target = event as unknown as Record<string, unknown>;
  if (update.$set) {
    for (const [key, value] of Object.entries(update.$set)) {
      setNested(target, key, value);
    }
  }
  if (update.$inc) {
    for (const [key, delta] of Object.entries(update.$inc)) {
      const current = Number(getNested(target, key) ?? 0);
      setNested(target, key, current + Number(delta));
    }
  }
  if (update.$unset) {
    for (const key of Object.keys(update.$unset)) {
      unsetNested(target, key);
    }
  }
}

describe('KnowledgeOutboxConsumer', () => {
  it('uploads an APPROVED document version to SAG and transitions PENDING -> PUBLISHED', async () => {
    const storageKey = `work-notes/${organizationId.toHexString()}/${projectId.toHexString()}/${documentId.toHexString()}/11111111-2222-4333-8444-555555555555`;
    const fileBytes = Buffer.from('# SAG Architecture Spec v1\n', 'utf-8');
    const eventId = new Types.ObjectId('700000000000000000000001');

    const { consumer, events, uploads } = createHarness({
      events: [
        {
          _id: eventId,
          eventName: 'KNOWLEDGE_SOURCE_APPROVED',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId.toHexString(),
          payload: {
            sourceType: 'PROJECT_DOCUMENT',
            sourceId: documentId.toHexString(),
            organizationId: organizationId.toHexString(),
            projectId: projectId.toHexString(),
            version: 1,
            approvedAt: '2026-10-25T10:00:00.000Z',
          },
          status: 'PENDING',
          occurredAt: new Date('2026-10-25T10:00:00.000Z'),
        },
      ],
      liveDocument: {
        _id: documentId,
        organizationId,
        projectId,
        title: 'SAG Architecture Spec',
        status: 'APPROVED',
        currentVersionNumber: 1,
        latestApprovedVersionNumber: 1,
        createdByUserId: reviewerUserId,
        updatedByUserId: reviewerUserId,
      },
      liveVersions: [
        {
          _id: new Types.ObjectId(),
          organizationId,
          projectId,
          documentId,
          versionNumber: 1,
          title: 'SAG Architecture Spec',
          status: 'APPROVED',
          reviewedByUserId: reviewerUserId,
          file: {
            key: storageKey,
            name: 'sag-architecture.md',
            contentType: 'text/markdown',
            size: fileBytes.length,
          },
        },
      ],
      fileBytesByKey: { [storageKey]: fileBytes },
    });

    await expect(consumer.runOnce()).resolves.toBe('PUBLISHED');

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      organizationId: organizationId.toHexString(),
      projectId: projectId.toHexString(),
      documentId: documentId.toHexString(),
      version: 1,
      logicalSourceId: `continuum:project_document:${documentId.toHexString()}`,
      idempotencyKey: `continuum:project_document:${documentId.toHexString()}:v1`,
      fileName: 'sag-architecture.md',
      contentType: 'text/markdown',
    });
    expect(uploads[0]?.bytes.equals(fileBytes)).toBe(true);
    expect(events[0]?.status).toBe('PUBLISHED');
    expect(events[0]?.publishedAt).toBeInstanceOf(Date);
  });

  it('skips a stale KNOWLEDGE_SOURCE_APPROVED event when live document is ARCHIVED (after REVOKED) so it never revives in SAG', async () => {
    const eventId = new Types.ObjectId('700000000000000000000002');
    const { consumer, events, uploads, revokes } = createHarness({
      events: [
        {
          _id: eventId,
          eventName: 'KNOWLEDGE_SOURCE_APPROVED',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId.toHexString(),
          payload: {
            sourceType: 'PROJECT_DOCUMENT',
            sourceId: documentId.toHexString(),
            organizationId: organizationId.toHexString(),
            projectId: projectId.toHexString(),
            version: 1,
            approvedAt: '2026-10-25T10:00:00.000Z',
          },
          status: 'PENDING',
          occurredAt: new Date('2026-10-25T10:00:00.000Z'),
        },
      ],
      liveDocument: {
        _id: documentId,
        organizationId,
        projectId,
        title: 'Revoked Spec',
        status: 'ARCHIVED',
        currentVersionNumber: 1,
        latestApprovedVersionNumber: 1,
        createdByUserId: reviewerUserId,
        updatedByUserId: reviewerUserId,
      },
      liveVersions: [
        {
          _id: new Types.ObjectId(),
          organizationId,
          projectId,
          documentId,
          versionNumber: 1,
          title: 'Revoked Spec',
          status: 'APPROVED',
          reviewedByUserId: reviewerUserId,
          content: '# Should never be uploaded after archive',
        },
      ],
    });

    await expect(consumer.runOnce()).resolves.toBe('SKIPPED');

    expect(uploads).toHaveLength(0);
    expect(revokes).toHaveLength(0);
    expect(events[0]?.status).toBe('PUBLISHED');
    const delivery = (events[0]?.payload.delivery ?? {}) as Record<
      string,
      unknown
    >;
    expect(delivery.skippedReason).toBe('DOCUMENT_REVOKED_OR_ARCHIVED');
  });

  it('skips a stale APPROVED(v1) event when v2 is already approved, and processes REPLACED + APPROVED(v2) sequentially', async () => {
    const storageKeyV2 = `work-notes/${organizationId.toHexString()}/${projectId.toHexString()}/${documentId.toHexString()}/22222222-2222-4333-8444-555555555555`;
    const bytesV2 = Buffer.from('# SAG Spec v2 (Current)\n', 'utf-8');

    const { consumer, events, uploads } = createHarness({
      events: [
        {
          _id: new Types.ObjectId('700000000000000000000010'),
          eventName: 'KNOWLEDGE_SOURCE_APPROVED',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId.toHexString(),
          payload: {
            sourceType: 'PROJECT_DOCUMENT',
            sourceId: documentId.toHexString(),
            organizationId: organizationId.toHexString(),
            projectId: projectId.toHexString(),
            version: 1,
            approvedAt: '2026-10-25T10:00:00.000Z',
          },
          status: 'PENDING',
          occurredAt: new Date('2026-10-25T10:00:00.000Z'),
        },
        {
          _id: new Types.ObjectId('700000000000000000000011'),
          eventName: 'KNOWLEDGE_SOURCE_REPLACED',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId.toHexString(),
          payload: {
            sourceType: 'PROJECT_DOCUMENT',
            sourceId: documentId.toHexString(),
            organizationId: organizationId.toHexString(),
            projectId: projectId.toHexString(),
            previousVersion: 1,
            version: 2,
          },
          status: 'PENDING',
          occurredAt: new Date('2026-10-25T10:05:00.000Z'),
        },
        {
          _id: new Types.ObjectId('700000000000000000000012'),
          eventName: 'KNOWLEDGE_SOURCE_APPROVED',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId.toHexString(),
          payload: {
            sourceType: 'PROJECT_DOCUMENT',
            sourceId: documentId.toHexString(),
            organizationId: organizationId.toHexString(),
            projectId: projectId.toHexString(),
            version: 2,
            approvedAt: '2026-10-25T10:05:00.000Z',
          },
          status: 'PENDING',
          occurredAt: new Date('2026-10-25T10:05:00.000Z'),
        },
      ],
      liveDocument: {
        _id: documentId,
        organizationId,
        projectId,
        title: 'SAG Spec',
        status: 'APPROVED',
        currentVersionNumber: 2,
        latestApprovedVersionNumber: 2,
        createdByUserId: reviewerUserId,
        updatedByUserId: reviewerUserId,
      },
      liveVersions: [
        {
          _id: new Types.ObjectId(),
          organizationId,
          projectId,
          documentId,
          versionNumber: 1,
          title: 'SAG Spec v1',
          status: 'APPROVED',
          reviewedByUserId: reviewerUserId,
          content: '# SAG Spec v1',
        },
        {
          _id: new Types.ObjectId(),
          organizationId,
          projectId,
          documentId,
          versionNumber: 2,
          title: 'SAG Spec v2',
          status: 'APPROVED',
          reviewedByUserId: reviewerUserId,
          file: {
            key: storageKeyV2,
            name: 'sag-spec-v2.md',
            contentType: 'text/markdown',
            size: bytesV2.length,
          },
        },
      ],
      fileBytesByKey: { [storageKeyV2]: bytesV2 },
    });

    const results = await consumer.processDocumentEvents(
      documentId.toHexString(),
    );
    expect(results).toEqual(['SKIPPED', 'PUBLISHED', 'PUBLISHED']);

    // Only v2 was uploaded to SAG; stale v1 was skipped!
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.version).toBe(2);
    expect(uploads[0]?.idempotencyKey).toBe(
      `continuum:project_document:${documentId.toHexString()}:v2`,
    );
    expect(events.every((e) => e.status === 'PUBLISHED')).toBe(true);
  });

  it('executes KNOWLEDGE_SOURCE_REVOKED against SAG and marks the event PUBLISHED', async () => {
    const { consumer, events, revokes } = createHarness({
      events: [
        {
          _id: new Types.ObjectId('700000000000000000000020'),
          eventName: 'KNOWLEDGE_SOURCE_REVOKED',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId.toHexString(),
          payload: {
            sourceType: 'PROJECT_DOCUMENT',
            sourceId: documentId.toHexString(),
            organizationId: organizationId.toHexString(),
            projectId: projectId.toHexString(),
            version: 1,
            reason: 'ARCHIVED',
          },
          status: 'PENDING',
          occurredAt: new Date('2026-10-25T11:00:00.000Z'),
        },
      ],
      liveDocument: {
        _id: documentId,
        organizationId,
        projectId,
        title: 'Archived Doc',
        status: 'ARCHIVED',
        currentVersionNumber: 1,
        latestApprovedVersionNumber: 1,
        createdByUserId: reviewerUserId,
        updatedByUserId: reviewerUserId,
      },
      liveVersions: [],
    });

    await expect(consumer.runOnce()).resolves.toBe('PUBLISHED');
    expect(revokes).toHaveLength(1);
    expect(revokes[0]).toMatchObject({
      organizationId: organizationId.toHexString(),
      projectId: projectId.toHexString(),
      documentId: documentId.toHexString(),
      version: 1,
      logicalSourceId: `continuum:project_document:${documentId.toHexString()}`,
      reason: 'ARCHIVED',
    });
    expect(events[0]?.status).toBe('PUBLISHED');
  });

  it('transitions event to RETRY then FAILED when SAG transport repeatedly fails', async () => {
    const { consumer, events } = createHarness({
      events: [
        {
          _id: new Types.ObjectId('700000000000000000000030'),
          eventName: 'KNOWLEDGE_SOURCE_REVOKED',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId.toHexString(),
          payload: {
            sourceType: 'PROJECT_DOCUMENT',
            sourceId: documentId.toHexString(),
            organizationId: organizationId.toHexString(),
            projectId: projectId.toHexString(),
            version: 1,
            reason: 'ARCHIVED',
            delivery: { attemptCount: 4 },
          },
          status: 'PENDING',
          occurredAt: new Date('2026-10-25T11:00:00.000Z'),
        },
      ],
      liveDocument: {
        _id: documentId,
        organizationId,
        projectId,
        status: 'ARCHIVED',
        currentVersionNumber: 1,
        latestApprovedVersionNumber: 1,
        createdByUserId: reviewerUserId,
        updatedByUserId: reviewerUserId,
      },
      liveVersions: [],
      revokeImpl: () => Promise.reject(new Error('SAG_HTTP_503_UNAVAILABLE')),
    });

    // Attempt 5 reaches MAX_ATTEMPTS (5) -> status becomes FAILED
    await expect(consumer.runOnce()).resolves.toBe('FAILED');
    expect(events[0]?.status).toBe('FAILED');
    expect(events[0]?.lastError).toBe('SAG_HTTP_503_UNAVAILABLE');
  });

  it('serializes concurrent runOnce calls for the same documentId in strict FIFO order without overlapping transport calls', async () => {
    const executionOrder: string[] = [];
    let inFlightForDoc = 0;
    let maxConcurrentForDoc = 0;

    const { consumer, events } = createHarness({
      events: [
        {
          _id: new Types.ObjectId('700000000000000000000040'),
          eventName: 'KNOWLEDGE_SOURCE_APPROVED',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId.toHexString(),
          payload: {
            sourceType: 'PROJECT_DOCUMENT',
            sourceId: documentId.toHexString(),
            organizationId: organizationId.toHexString(),
            projectId: projectId.toHexString(),
            version: 1,
            approvedAt: '2026-10-25T10:00:00.000Z',
          },
          status: 'PENDING',
          occurredAt: new Date('2026-10-25T10:00:00.000Z'),
        },
        {
          _id: new Types.ObjectId('700000000000000000000041'),
          eventName: 'KNOWLEDGE_SOURCE_REVOKED',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId.toHexString(),
          payload: {
            sourceType: 'PROJECT_DOCUMENT',
            sourceId: documentId.toHexString(),
            organizationId: organizationId.toHexString(),
            projectId: projectId.toHexString(),
            version: 1,
            reason: 'ARCHIVED',
          },
          status: 'PENDING',
          occurredAt: new Date('2026-10-25T10:01:00.000Z'),
        },
      ],
      liveDocument: {
        _id: documentId,
        organizationId,
        projectId,
        title: 'Concurrent Doc',
        status: 'APPROVED',
        currentVersionNumber: 1,
        latestApprovedVersionNumber: 1,
        createdByUserId: reviewerUserId,
        updatedByUserId: reviewerUserId,
      },
      liveVersions: [
        {
          _id: new Types.ObjectId(),
          organizationId,
          projectId,
          documentId,
          versionNumber: 1,
          title: 'Concurrent Doc',
          status: 'APPROVED',
          reviewedByUserId: reviewerUserId,
          content: '# Concurrent Doc v1',
        },
      ],
      uploadImpl: async (input) => {
        inFlightForDoc += 1;
        maxConcurrentForDoc = Math.max(maxConcurrentForDoc, inFlightForDoc);
        executionOrder.push(`UPLOAD_START_v${input.version}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
        executionOrder.push(`UPLOAD_END_v${input.version}`);
        inFlightForDoc -= 1;
        return {
          documentId: 'sag-doc-1',
          documentVersionId: 'sag-ver-1',
          status: 'QUEUED',
        };
      },
      revokeImpl: async () => {
        inFlightForDoc += 1;
        maxConcurrentForDoc = Math.max(maxConcurrentForDoc, inFlightForDoc);
        executionOrder.push('REVOKE_START');
        await new Promise((resolve) => setTimeout(resolve, 10));
        executionOrder.push('REVOKE_END');
        inFlightForDoc -= 1;
        return {
          status: 'REVOKED',
          documentId: 'sag-doc-1',
        };
      },
    });

    const [firstResult, secondResult] = await Promise.all([
      consumer.runOnce(documentId.toHexString()),
      consumer.runOnce(documentId.toHexString()),
    ]);

    expect([firstResult, secondResult]).toEqual(['PUBLISHED', 'PUBLISHED']);
    expect(maxConcurrentForDoc).toBe(1);
    expect(executionOrder).toEqual([
      'UPLOAD_START_v1',
      'UPLOAD_END_v1',
      'REVOKE_START',
      'REVOKE_END',
    ]);
    expect(events.every((e) => e.status === 'PUBLISHED')).toBe(true);
  });
});
