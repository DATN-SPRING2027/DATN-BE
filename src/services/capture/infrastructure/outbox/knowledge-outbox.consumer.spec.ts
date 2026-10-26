import { ConfigService } from '@nestjs/config';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import type { ProjectDocumentStorage } from '../storage/project-document.storage';
import {
  HttpSagKnowledgeSyncTransport,
  KnowledgeOutboxConsumer,
  type SagKnowledgeSyncTransport,
  type SagProjectDocumentRevokeInput,
  type SagProjectDocumentUploadInput,
  type SagProjectDocumentUploadReceipt,
  type SagProjectDocumentVersionStatusInput,
  type SagProjectDocumentVersionStatusReceipt,
} from './knowledge-outbox.consumer';

const organizationId = new Types.ObjectId('6ad76c7d938f3bf53df7335e');
const projectId = new Types.ObjectId('6ad7758334bd88b3f2cc844c');
const documentId = new Types.ObjectId('6bd7758334bd88b3f2cc9001');
const secondDocumentId = new Types.ObjectId('6bd7758334bd88b3f2cc9002');
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
  liveDocumentsById?: Record<string, Record<string, unknown>>;
  liveVersions: Array<Record<string, unknown>>;
  fileBytesByKey?: Record<string, Buffer>;
  uploadImpl?: (
    input: SagProjectDocumentUploadInput,
  ) => Promise<SagProjectDocumentUploadReceipt>;
  statusImpl?: (
    input: SagProjectDocumentVersionStatusInput,
  ) => Promise<SagProjectDocumentVersionStatusReceipt>;
  revokeImpl?: (input: SagProjectDocumentRevokeInput) => Promise<{
    status: 'REVOKED' | 'ALREADY_REVOKED' | 'NOT_FOUND';
    documentId: string | null;
  }>;
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
  const statusCalls: SagProjectDocumentVersionStatusInput[] = [];
  const revokes: SagProjectDocumentRevokeInput[] = [];

  const outboxCollection = {
    find: jest.fn((filter: Record<string, unknown>) => {
      const matched = events
        .filter((e) => matchesFilter(e, filter))
        .sort(compareEvents)
        .map((e) => cloneEvent(e));
      return {
        sort: jest.fn(() => ({
          toArray: jest.fn(() => Promise.resolve(matched)),
        })),
        toArray: jest.fn(() => Promise.resolve(matched)),
      };
    }),
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
      const idHex =
        filter._id instanceof Types.ObjectId
          ? filter._id.toHexString()
          : typeof filter._id === 'string'
            ? filter._id
            : '';
      if (options.liveDocumentsById && idHex in options.liveDocumentsById) {
        return Promise.resolve({ ...options.liveDocumentsById[idHex] });
      }
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
        versionId: `sag-ver-${input.version}`,
        versionNo: input.version,
        runId: `run-${input.version}`,
        status: 'RECEIVED',
        searchStatus: 'PENDING',
        knowledgeStatus: 'NOT_STARTED',
        isDuplicate: false,
      };
    },
    async getProjectDocumentVersionStatus(input) {
      statusCalls.push(input);
      if (options.statusImpl) {
        return options.statusImpl(input);
      }
      return {
        documentId: input.sagDocumentId,
        versionNo: input.versionNo,
        status: 'SEARCH_READY',
        searchStatus: 'SEARCH_READY',
        knowledgeStatus: 'NOT_STARTED',
        searchReady: true,
        knowledgeReady: false,
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
    KNOWLEDGE_OUTBOX_SEARCH_READY_POLL_MS: 5,
    KNOWLEDGE_OUTBOX_SEARCH_READY_TIMEOUT_MS: 100,
  });

  const consumer = new KnowledgeOutboxConsumer(
    connection,
    config,
    storage,
    transport,
  );

  const createPeerConsumer = () =>
    new KnowledgeOutboxConsumer(connection, config, storage, transport);

  return {
    consumer,
    createPeerConsumer,
    events,
    uploads,
    statusCalls,
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
      if ('$nin' in ops && Array.isArray(ops.$nin)) {
        if (ops.$nin.some((item) => String(item) === String(actual)))
          return false;
        continue;
      }
      if ('$ne' in ops) {
        if (sameValue(actual, ops.$ne)) return false;
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
      if ('$lt' in ops) {
        if (ops.$lt instanceof Date) {
          if (
            !(actual instanceof Date) ||
            actual.getTime() >= ops.$lt.getTime()
          ) {
            return false;
          }
          continue;
        }
        if (
          ops.$lt instanceof Types.ObjectId &&
          actual instanceof Types.ObjectId
        ) {
          if (actual.toHexString().localeCompare(ops.$lt.toHexString()) >= 0) {
            return false;
          }
          continue;
        }
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
    if (expected instanceof Date && actual instanceof Date) {
      if (expected.getTime() !== actual.getTime()) return false;
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
  it('uploads an APPROVED document version to SAG, verifies SEARCH_READY, and transitions PENDING -> PUBLISHED', async () => {
    const storageKey = `work-notes/${organizationId.toHexString()}/${projectId.toHexString()}/${documentId.toHexString()}/11111111-2222-4333-8444-555555555555`;
    const fileBytes = Buffer.from('# SAG Architecture Spec v1\n', 'utf-8');
    const eventId = new Types.ObjectId('700000000000000000000001');
    let pollAttempt = 0;

    const { consumer, events, uploads, statusCalls } = createHarness({
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
      statusImpl: (input) => {
        pollAttempt += 1;
        return Promise.resolve({
          documentId: input.sagDocumentId,
          versionNo: input.versionNo,
          status: pollAttempt >= 2 ? 'SEARCH_READY' : 'RECEIVED',
          searchStatus: pollAttempt >= 2 ? 'SEARCH_READY' : 'PENDING',
          knowledgeStatus: 'NOT_STARTED',
          searchReady: pollAttempt >= 2,
          knowledgeReady: false,
        });
      },
    });

    await expect(consumer.runOnce()).resolves.toBe('PUBLISHED');

    expect(uploads).toHaveLength(1);
    expect(statusCalls).toHaveLength(2);
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
    const delivery = (events[0]?.payload.delivery ?? {}) as Record<
      string,
      unknown
    >;
    expect(delivery.receipt).toMatchObject({
      documentId: 'sag-doc-1',
      versionId: 'sag-ver-1',
      versionNo: 1,
      searchStatus: 'SEARCH_READY',
      searchReady: true,
    });
  });

  it('schedules RETRY (never PUBLISHED) when SAG indexing reports INDEX_FAILED after upload', async () => {
    const eventId = new Types.ObjectId('700000000000000000000009');
    const { consumer, events } = createHarness({
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
        title: 'Index Failure Spec',
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
          title: 'Index Failure Spec',
          status: 'APPROVED',
          reviewedByUserId: reviewerUserId,
          content: '# Index Failure Spec\n\nBody text.',
        },
      ],
      statusImpl: (input) =>
        Promise.resolve({
          documentId: input.sagDocumentId,
          versionNo: input.versionNo,
          status: 'FAILED',
          searchStatus: 'INDEX_FAILED',
          knowledgeStatus: 'NOT_STARTED',
          searchReady: false,
          knowledgeReady: false,
          error: { code: 'STORE_PERSIST_FAILED' },
        }),
    });

    await expect(consumer.runOnce()).resolves.toBe('RETRY');
    expect(events[0]?.status).toBe('PENDING');
    expect(events[0]?.lastError).toBe('SAG_INDEX_FAILED:STORE_PERSIST_FAILED');
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

    await expect(consumer.runOnce()).resolves.toBe('FAILED');
    expect(events[0]?.status).toBe('FAILED');
    expect(events[0]?.lastError).toBe('SAG_HTTP_503_UNAVAILABLE');
  });

  it('enforces multi-instance per-documentId FIFO and prevents out-of-order execution when an older event is leased or in retry backoff', async () => {
    const futureRetry = new Date(Date.now() + 60_000);
    const { consumer, createPeerConsumer, events, uploads, revokes } =
      createHarness({
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
              delivery: {
                attemptCount: 1,
                nextAttemptAt: futureRetry,
              },
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
          {
            _id: new Types.ObjectId('700000000000000000000042'),
            eventName: 'KNOWLEDGE_SOURCE_APPROVED',
            aggregateType: 'PROJECT_DOCUMENT',
            aggregateId: secondDocumentId.toHexString(),
            payload: {
              sourceType: 'PROJECT_DOCUMENT',
              sourceId: secondDocumentId.toHexString(),
              organizationId: organizationId.toHexString(),
              projectId: projectId.toHexString(),
              version: 1,
              approvedAt: '2026-10-25T10:02:00.000Z',
            },
            status: 'PENDING',
            occurredAt: new Date('2026-10-25T10:02:00.000Z'),
          },
        ],
        liveDocument: null,
        liveDocumentsById: {
          [documentId.toHexString()]: {
            _id: documentId,
            organizationId,
            projectId,
            title: 'Doc 1',
            status: 'ARCHIVED',
            currentVersionNumber: 1,
            latestApprovedVersionNumber: 1,
            createdByUserId: reviewerUserId,
            updatedByUserId: reviewerUserId,
          },
          [secondDocumentId.toHexString()]: {
            _id: secondDocumentId,
            organizationId,
            projectId,
            title: 'Doc 2',
            status: 'APPROVED',
            currentVersionNumber: 1,
            latestApprovedVersionNumber: 1,
            createdByUserId: reviewerUserId,
            updatedByUserId: reviewerUserId,
          },
        },
        liveVersions: [
          {
            _id: new Types.ObjectId(),
            organizationId,
            projectId,
            documentId: secondDocumentId,
            versionNumber: 1,
            title: 'Doc 2',
            status: 'APPROVED',
            reviewedByUserId: reviewerUserId,
            content: '# Doc 2 Content',
          },
        ],
      });

    const peerConsumer = createPeerConsumer();

    // 1. Scoped run on Doc 1 returns IDLE because its head-of-line event (40) is in retry backoff,
    //    and event (41) is blocked behind event (40) with attemptCount rolled back to 0!
    await expect(peerConsumer.runOnce(documentId.toHexString())).resolves.toBe(
      'IDLE',
    );
    expect(revokes).toHaveLength(0);
    expect(
      (events[1]?.payload.delivery as Record<string, unknown> | undefined)
        ?.attemptCount ?? 0,
    ).toBe(0);

    // 2. Unscoped runOnce skips blocked Doc 1 and processes ready Doc 2 without starvation!
    await expect(consumer.runOnce()).resolves.toBe('PUBLISHED');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.documentId).toBe(secondDocumentId.toHexString());
    expect(events[2]?.status).toBe('PUBLISHED');
  });

  it('supports scoped Pilot inspection and execution via inspectPendingEvents and runScopedBatch', async () => {
    const { consumer, uploads } = createHarness({
      events: [
        {
          _id: new Types.ObjectId('700000000000000000000050'),
          eventName: 'KNOWLEDGE_SOURCE_APPROVED',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId.toHexString(),
          payload: {
            sourceType: 'PROJECT_DOCUMENT',
            sourceId: documentId.toHexString(),
            organizationId: organizationId.toHexString(),
            projectId: projectId.toHexString(),
            version: 1,
          },
          status: 'PENDING',
          occurredAt: new Date('2026-10-25T10:00:00.000Z'),
        },
        {
          _id: new Types.ObjectId('700000000000000000000051'),
          eventName: 'KNOWLEDGE_SOURCE_APPROVED',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: secondDocumentId.toHexString(),
          payload: {
            sourceType: 'PROJECT_DOCUMENT',
            sourceId: secondDocumentId.toHexString(),
            organizationId: organizationId.toHexString(),
            projectId: projectId.toHexString(),
            version: 1,
          },
          status: 'PENDING',
          occurredAt: new Date('2026-10-25T10:01:00.000Z'),
        },
      ],
      liveDocument: null,
      liveDocumentsById: {
        [documentId.toHexString()]: {
          _id: documentId,
          organizationId,
          projectId,
          title: 'Pilot Doc 1',
          status: 'APPROVED',
          currentVersionNumber: 1,
          latestApprovedVersionNumber: 1,
          createdByUserId: reviewerUserId,
          updatedByUserId: reviewerUserId,
        },
      },
      liveVersions: [
        {
          _id: new Types.ObjectId(),
          organizationId,
          projectId,
          documentId,
          versionNumber: 1,
          title: 'Pilot Doc 1',
          status: 'APPROVED',
          reviewedByUserId: reviewerUserId,
          content: '# Pilot Doc 1 Content',
        },
      ],
    });

    await expect(consumer.runScopedBatch({ documentIds: [] })).rejects.toThrow(
      'SCOPED_BATCH_DOCUMENT_IDS_REQUIRED',
    );

    const dryRunRes = await consumer.runScopedBatch({
      documentIds: [documentId.toHexString()],
      dryRun: true,
    });
    expect(dryRunRes.candidateEvents).toHaveLength(1);
    expect(dryRunRes.candidateEvents[0]?.documentId).toBe(
      documentId.toHexString(),
    );
    expect(uploads).toHaveLength(0);

    const execRes = await consumer.runScopedBatch({
      documentIds: [documentId.toHexString()],
    });
    expect(execRes.outcomesByDocument[documentId.toHexString()]).toEqual([
      'PUBLISHED',
    ]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.documentId).toBe(documentId.toHexString());

    // Second document outside the Pilot allowlist remains untouched in PENDING
    const remaining = await consumer.inspectPendingEvents();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.documentId).toBe(secondDocumentId.toHexString());
  });
});

describe('HttpSagKnowledgeSyncTransport (Real HTTP Contract)', () => {
  it('sends BFF service token + Continuum scope headers and parses version_id + version_no over HTTP', async () => {
    const receivedRequests: Array<{
      method: string;
      url: string;
      headers: IncomingMessage['headers'];
    }> = [];

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      receivedRequests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
      });

      if (
        req.method === 'POST' &&
        req.url ===
          `/api/v1/projects/${projectId.toHexString()}/documents/upload`
      ) {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            document_id: 'sag-doc-http-1',
            version_no: 2,
            version_id: 'sag-ver-http-2',
            run_id: 'run-http-2',
            file_hash: 'sha256-abc',
            status: 'RECEIVED',
            search_status: 'PENDING',
            knowledge_status: 'NOT_STARTED',
            is_duplicate: false,
          }),
        );
        return;
      }

      if (
        req.method === 'GET' &&
        req.url ===
          `/api/v1/projects/${projectId.toHexString()}/documents/sag-doc-http-1/versions/2/status`
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            document_id: 'sag-doc-http-1',
            version_no: 2,
            status: 'SEARCH_READY',
            search_status: 'SEARCH_READY',
            knowledge_status: 'NOT_STARTED',
            search_ready: true,
            knowledge_ready: false,
            current_stage: 'COMPLETE',
          }),
        );
        return;
      }

      if (
        req.method === 'POST' &&
        req.url ===
          `/api/v1/projects/${projectId.toHexString()}/documents/revoke`
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            document_id: 'sag-doc-http-1',
            project_id: projectId.toHexString(),
            logical_source_id: `continuum:project_document:${documentId.toHexString()}`,
            status: 'REVOKED',
            delete_job_id: 'job-del-1',
            revoked_version_count: 1,
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const transport = new HttpSagKnowledgeSyncTransport(
        new ConfigService({
          SAG_API_BASE_URL: `http://127.0.0.1:${port}`,
          SAG_BFF_SERVICE_TOKEN: 'bff-test-secret',
          CAPTURE_FILE_TIMEOUT_MS: 5_000,
        }),
      );

      const uploadReceipt = await transport.uploadProjectDocument({
        organizationId: organizationId.toHexString(),
        projectId: projectId.toHexString(),
        documentId: documentId.toHexString(),
        version: 2,
        logicalSourceId: `continuum:project_document:${documentId.toHexString()}`,
        idempotencyKey: `continuum:project_document:${documentId.toHexString()}:v2`,
        actorUserId: reviewerUserId.toHexString(),
        fileName: 'spec.md',
        contentType: 'text/markdown',
        bytes: Buffer.from('# HTTP Spec v2\n', 'utf-8'),
      });

      expect(uploadReceipt).toEqual({
        documentId: 'sag-doc-http-1',
        versionId: 'sag-ver-http-2',
        versionNo: 2,
        runId: 'run-http-2',
        fileHash: 'sha256-abc',
        status: 'RECEIVED',
        searchStatus: 'PENDING',
        knowledgeStatus: 'NOT_STARTED',
        isDuplicate: false,
        searchReady: false,
      });

      const statusReceipt = await transport.getProjectDocumentVersionStatus({
        organizationId: organizationId.toHexString(),
        projectId: projectId.toHexString(),
        sagDocumentId: 'sag-doc-http-1',
        versionNo: 2,
        actorUserId: reviewerUserId.toHexString(),
      });
      expect(statusReceipt.searchReady).toBe(true);
      expect(statusReceipt.searchStatus).toBe('SEARCH_READY');

      const revokeReceipt = await transport.revokeProjectDocument({
        organizationId: organizationId.toHexString(),
        projectId: projectId.toHexString(),
        documentId: documentId.toHexString(),
        version: 2,
        logicalSourceId: `continuum:project_document:${documentId.toHexString()}`,
        actorUserId: reviewerUserId.toHexString(),
        reason: 'ARCHIVED',
      });
      expect(revokeReceipt).toEqual({
        status: 'REVOKED',
        documentId: 'sag-doc-http-1',
      });

      expect(receivedRequests).toHaveLength(3);
      expect(receivedRequests[0]?.headers['x-sag-bff-service-token']).toBe(
        'bff-test-secret',
      );
      expect(receivedRequests[0]?.headers['x-continuum-organization-id']).toBe(
        organizationId.toHexString(),
      );
      expect(receivedRequests[0]?.headers['x-continuum-tenant-id']).toBe(
        organizationId.toHexString(),
      );
      expect(receivedRequests[0]?.headers['x-continuum-project-id']).toBe(
        projectId.toHexString(),
      );
      expect(
        receivedRequests[0]?.headers['x-continuum-security-partition'],
      ).toBe(projectId.toHexString());
      expect(receivedRequests[0]?.headers['idempotency-key']).toBe(
        `continuum:project_document:${documentId.toHexString()}:v2`,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
